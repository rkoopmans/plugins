/**
 * StructuredTextTranslation.ts
 * ------------------------------------------------------
 * Translates DatoCMS structured-text (DAST) fields as a single whole-field
 * round trip so the LLM has the full document context it needs to produce
 * coherent output.
 *
 * The field is serialised by `StructuredTextMarkup.renderFieldToMarkup` into
 * a flat marker string, sent to the provider in ONE call, and parsed back to
 * a DAST tree by `parseMarkupToField`. Embedded block nodes (type === 'block')
 * are still extracted up-front and translated recursively through the field
 * translator, exactly as before. Non-empty integrity violations throw and
 * log — there is no implicit retry; the user retries from the UI.
 */

import type { ctxParamsType } from '../../entrypoints/Config/ConfigScreen';
import { createLogger } from '../logging/Logger';
import type { SchemaRepository } from '../schemaRepository';
import { handleTranslationError } from './ProviderErrors';
import {
  type AttributeStore,
  IntegrityError,
  markupInstruction,
  parseMarkupToField,
  renderFieldToMarkup,
} from './StructuredTextMarkup';
import { translateFieldValue } from './TranslateField';
import type { StreamCallbacks, TranslationProvider } from './types';
import { removeIds } from './utils';

/**
 * A DAST node wrapper used for book-keeping during block extraction.
 */
interface StructuredTextNode {
  type?: string;
  value?: string;
  item?: string;
  originalIndex?: number;
  [key: string]: unknown;
}

/**
 * DAST API response shape, where the structured text is wrapped in
 * `{ document: { children: [...] }, schema: 'dast' }`.
 */
interface APIResponseFormat {
  document: {
    children: unknown[];
    type?: string;
  };
  schema?: string;
}

function isAPIResponseFormat(value: unknown): value is APIResponseFormat {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (!obj.document || typeof obj.document !== 'object') return false;
  const doc = obj.document as Record<string, unknown>;
  return Array.isArray(doc.children) && doc.children.length > 0;
}

/**
 * Approximate per-call character budget for the rendered markup. Modern chat
 * models comfortably handle hundreds of thousands of characters, but we prefer
 * splitting very long fields at block boundaries so that (a) a single response
 * never dominates latency, and (b) a truncated response doesn't wipe out the
 * whole field. Tuned conservatively; can be raised per-model later.
 */
const MAX_MARKUP_CHARS_PER_CALL = 40000;

type UnknownRecord = Record<string, unknown>;

/**
 * Partitions the top-level children into batches whose rendered markup stays
 * under `MAX_MARKUP_CHARS_PER_CALL`. Uses a dry render to measure size and
 * never splits inside a block. If a single block exceeds the budget on its
 * own, that block gets its own batch — no further subdivision.
 */
function buildNestedTranslationOptions(cmaBaseUrl?: string) {
  return cmaBaseUrl
    ? { bypassFieldTypeAllowlist: true, cmaBaseUrl }
    : { bypassFieldTypeAllowlist: true };
}

function partitionIntoBatches(children: unknown[]): unknown[][] {
  if (children.length === 0) return [];
  const batches: unknown[][] = [];
  let current: unknown[] = [];
  let currentSize = 0;
  for (const child of children) {
    const size = measureBlockSize(child);
    if (currentSize + size > MAX_MARKUP_CHARS_PER_CALL && current.length > 0) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(child);
    currentSize += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const MARKER_OVERHEAD_CHARS = 24;

function leafCharLength(entry: UnknownRecord): number {
  let size = 0;
  if (typeof entry.text === 'string') size += entry.text.length;
  if (typeof entry.value === 'string') size += entry.value.length;
  return size;
}

function measureStackItem(item: unknown, stack: unknown[]): number {
  if (Array.isArray(item)) {
    for (const entry of item) stack.push(entry);
    return 0;
  }
  if (!item || typeof item !== 'object') return 0;
  const entry = item as UnknownRecord;
  const charLength = leafCharLength(entry);
  if (Array.isArray(entry.children)) stack.push(entry.children);
  return charLength > 0 ? charLength + MARKER_OVERHEAD_CHARS : 0;
}

/**
 * Rough markup-size estimate for a single top-level block, without actually
 * allocating ids or maintaining state. Used only for batching decisions; the
 * real render happens once the batch is finalised.
 */
function measureBlockSize(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const rec = node as UnknownRecord;
  if (typeof rec.code === 'string') {
    return rec.code.length + MARKER_OVERHEAD_CHARS;
  }
  let size = MARKER_OVERHEAD_CHARS;
  const stack: unknown[] = [rec.children];
  while (stack.length > 0) {
    size += measureStackItem(stack.pop(), stack);
  }
  return size;
}

/**
 * Builds the full prompt for a translation call. The prompt consists of the
 * plugin's configured prompt template (with `{fieldValue}`, `{fromLocale}`,
 * `{toLocale}`, `{recordContext}` placeholders), the record context, the
 * preservation-marker instructions, any locale-specific override, and the
 * markup itself.
 */
function buildPrompt(params: {
  pluginParams: ctxParamsType;
  fromLocale: string;
  toLocale: string;
  recordContext: string;
  markup: string;
}): string {
  const { pluginParams, fromLocale, toLocale, recordContext, markup } = params;
  const template = pluginParams.prompt || '';
  const base = template
    ? template
        .replace('{fieldValue}', markup)
        .replace('{fromLocale}', fromLocale)
        .replace('{toLocale}', toLocale)
        .replace(
          '{recordContext}',
          recordContext || 'Record context: No additional context available.',
        )
    : `Translate the following content from ${fromLocale} to ${toLocale}. ${
        recordContext || ''
      }\n\n${markup}`;
  const localeInstruction = pluginParams.localeInstructions?.[toLocale];
  const localeBlock = localeInstruction
    ? `\n\nAdditional instruction for this locale: ${localeInstruction}`
    : '';
  return `${base}\n\n${markupInstruction()}${localeBlock}`;
}

/**
 * Sends one batch of children to the provider and rebuilds the translated
 * DAST subtree. Throws IntegrityError if the response fails validation — the
 * caller logs and rethrows. Does not retry.
 */
async function translateBatch(
  batch: unknown[],
  params: {
    pluginParams: ctxParamsType;
    fromLocale: string;
    toLocale: string;
    provider: TranslationProvider;
    recordContext: string;
  },
): Promise<unknown[]> {
  const { markup, attributes } = renderFieldToMarkup(batch);
  if (markup.length === 0) return batch;

  const prompt = buildPrompt({
    pluginParams: params.pluginParams,
    fromLocale: params.fromLocale,
    toLocale: params.toLocale,
    recordContext: params.recordContext,
    markup,
  });

  const response = await params.provider.completeText(prompt);

  try {
    const { children } = parseMarkupToField(
      response.trim(),
      attributes as AttributeStore,
    );
    return children;
  } catch (error) {
    if (error instanceof IntegrityError) {
      throw error;
    }
    throw error;
  }
}

function splitEmbeddedBlocks(children: StructuredTextNode[]): {
  embedded: StructuredTextNode[];
  inline: StructuredTextNode[];
} {
  const embedded: StructuredTextNode[] = [];
  const inline: StructuredTextNode[] = [];
  children.forEach((node, index) => {
    if (node?.type === 'block') {
      embedded.push({ ...node, originalIndex: index });
    } else {
      inline.push(node);
    }
  });
  return { embedded, inline };
}

async function translateInlinePortion(
  inline: StructuredTextNode[],
  params: Parameters<typeof translateBatch>[1],
): Promise<unknown[]> {
  if (inline.length === 0) return [];
  const batches = partitionIntoBatches(inline);
  // Sequential reduce keeps batches in source order and avoids overwhelming
  // the provider with parallel requests on very large fields.
  return batches.reduce<Promise<unknown[]>>(async (chain, batch) => {
    const accumulated = await chain;
    const result = await translateBatch(batch, params);
    return accumulated.concat(result);
  }, Promise.resolve<unknown[]>([]));
}

/**
 * Re-merge inline-translated and embedded-translated children into the
 * original source order. The old implementation inserted embedded nodes into
 * the inline array using `insertObjectAtIndex` at each node's `originalIndex`,
 * which only produced correct output when (a) the inline array was exactly
 * the expected length and (b) the embedded array was sorted by
 * `originalIndex` ascending. If either assumption broke (e.g. embedded blocks
 * reordered by the upstream field translator, or `rebuildBlockNode` dropping
 * an entry), positions drifted silently.
 *
 * The replacement is deterministic: we know `originalIndex` on every embedded
 * node and we know the total length must be `inline.length + embedded.length`.
 * We walk 0..totalLength-1 and at each position either append the embedded
 * node registered for that index, or the next inline node from a pointer.
 * If the inline pointer doesn't match up at the end we throw — that indicates
 * upstream drift we'd rather surface than silently corrupt.
 */
function reinsertEmbeddedBlocks(
  inlineTranslated: StructuredTextNode[],
  embeddedTranslated: StructuredTextNode[],
  expectedInlineCount: number,
): StructuredTextNode[] {
  if (inlineTranslated.length !== expectedInlineCount) {
    throw new Error(
      `reinsertEmbeddedBlocks: inline count mismatch (expected ${expectedInlineCount}, got ${inlineTranslated.length})`,
    );
  }
  const byIndex = new Map<number, StructuredTextNode>();
  for (const node of embeddedTranslated) {
    if (node.originalIndex === undefined) {
      throw new Error(
        'reinsertEmbeddedBlocks: embedded node missing originalIndex',
      );
    }
    if (byIndex.has(node.originalIndex)) {
      throw new Error(
        `reinsertEmbeddedBlocks: duplicate originalIndex ${node.originalIndex}`,
      );
    }
    byIndex.set(node.originalIndex, node);
  }

  const total = inlineTranslated.length + embeddedTranslated.length;
  const out: StructuredTextNode[] = [];
  let inlinePtr = 0;
  for (let i = 0; i < total; i++) {
    const embedded = byIndex.get(i);
    if (embedded) {
      out.push(embedded);
    } else {
      if (inlinePtr >= inlineTranslated.length) {
        throw new Error(
          `reinsertEmbeddedBlocks: ran out of inline nodes at position ${i}`,
        );
      }
      out.push(inlineTranslated[inlinePtr++]);
    }
  }
  if (inlinePtr !== inlineTranslated.length) {
    throw new Error(
      `reinsertEmbeddedBlocks: ${inlineTranslated.length - inlinePtr} inline node(s) left over after merge`,
    );
  }
  return out;
}

function wrapIfAPIResponse(
  children: StructuredTextNode[],
  wrap: boolean,
): unknown {
  if (!wrap) return children;
  return {
    document: { children, type: 'root' },
    schema: 'dast',
  };
}

/**
 * Translates a structured-text field value end-to-end, preserving block nodes
 * and delegating them to the field translator for recursive translation of
 * their inner fields.
 */
export async function translateStructuredTextValue(
  initialValue: unknown,
  pluginParams: ctxParamsType,
  toLocale: string,
  fromLocale: string,
  provider: TranslationProvider,
  apiToken: string,
  environment: string,
  streamCallbacks?: StreamCallbacks,
  recordContext = '',
  schemaRepository?: SchemaRepository,
  cmaBaseUrl?: string,
): Promise<unknown> {
  const logger = createLogger(pluginParams, 'StructuredTextTranslation');

  const isAPIResponse = isAPIResponseFormat(initialValue);
  const fieldValue: unknown = isAPIResponse
    ? initialValue.document.children
    : initialValue;

  if (!fieldValue || !Array.isArray(fieldValue) || fieldValue.length === 0) {
    logger.info('Invalid structured text value', fieldValue);
    return fieldValue;
  }

  logger.info('Translating structured text field', {
    nodeCount: fieldValue.length,
  });

  const noIdFieldValue = removeIds(fieldValue) as StructuredTextNode[];
  const { embedded, inline } = splitEmbeddedBlocks(noIdFieldValue);

  try {
    const inlineTranslated = (await translateInlinePortion(inline, {
      pluginParams,
      fromLocale,
      toLocale,
      provider,
      recordContext,
    })) as StructuredTextNode[];

    let embeddedTranslated: StructuredTextNode[] = [];
    if (embedded.length > 0) {
      logger.info(`Translating ${embedded.length} embedded block node(s)`);
      embeddedTranslated = (await translateFieldValue(
        embedded,
        pluginParams,
        toLocale,
        fromLocale,
        'rich_text',
        provider,
        '',
        apiToken,
        '',
        environment,
        streamCallbacks,
        recordContext,
        schemaRepository,
        buildNestedTranslationOptions(cmaBaseUrl),
      )) as StructuredTextNode[];
    }

    const merged = reinsertEmbeddedBlocks(
      inlineTranslated,
      embeddedTranslated,
      inline.length,
    );
    const cleaned = merged.map(({ originalIndex, ...rest }) => rest);

    logger.info('Successfully translated structured text');
    return wrapIfAPIResponse(cleaned, isAPIResponse);
  } catch (error) {
    if (error instanceof IntegrityError) {
      logger.error('Structured text translation failed integrity check', {
        violations: error.violations,
        preview: error.preview,
        fromLocale,
        toLocale,
      });
      throw error;
    }
    handleTranslationError(
      error,
      provider.vendor,
      logger,
      'Error during structured text translation',
    );
  }
}
