/**
 * StructuredTextMarkup.ts
 * ------------------------------------------------------
 * Serialise a DatoCMS structured-text (DAST) field to a single flat marker
 * string and parse the translated string back into a DAST tree.
 *
 * The LLM receives one string per field, preserving whole-document context.
 * Block structure and inline marks are encoded with opaque numeric ids plus
 * short advisory type hints; URLs, heading levels, list styles, item
 * references, and other attributes are kept in an out-of-band store so the
 * model never sees them and cannot rewrite them.
 */
import { tokenize, type TokenMap } from './translateArray';

/** Opening delimiter for markers. U+27E6 is extremely rare in natural text. */
const L = '⟦';
/** Closing delimiter for markers. U+27E7. */
const R = '⟧';

/** Inline span marks supported by DatoCMS DAST. */
const MARK_TYPES = [
  'strong',
  'emphasis',
  'underline',
  'strikethrough',
  'code',
  'highlight',
] as const;
export type MarkType = (typeof MARK_TYPES)[number];

const MARK_TYPE_SET = new Set<string>(MARK_TYPES);

/** Mapping between Slate-style boolean leaf properties and DAST mark names. */
const SLATE_MARK_MAP: Record<string, MarkType> = {
  bold: 'strong',
  italic: 'emphasis',
  underlined: 'underline',
  strikethrough: 'strikethrough',
  code: 'code',
  highlight: 'highlight',
};

/** Mnemonic hints used when rendering block markers. */
type BlockHint =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'bq'
  | 'list'
  | 'li'
  | 'code'
  | 'hr'
  | 'block';

const HEADING_HINTS: readonly BlockHint[] = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
];

/** Attributes stored out-of-band for a block. */
export type BlockAttrs =
  | { kind: 'paragraph' }
  | { kind: 'heading'; level: number }
  | { kind: 'blockquote' }
  | { kind: 'code'; code: string; language?: string; highlight?: number[] }
  | { kind: 'list'; style: 'bulleted' | 'numbered' }
  | { kind: 'listItem' }
  | { kind: 'thematicBreak' }
  | { kind: 'unknown'; original: Record<string, unknown> };

/** Attributes stored out-of-band for an inline mark / link / item. */
export type MarkAttrs =
  | { kind: 'mark'; mark: MarkType }
  | {
      kind: 'link';
      url: string;
      meta?: Array<{ id: string; value: string }>;
    }
  | {
      kind: 'itemLink';
      item: string;
      meta?: Array<{ id: string; value: string }>;
    }
  | { kind: 'inlineItem'; item: string };

/** Out-of-band attribute store populated at render time. */
export interface AttributeStore {
  blocks: Record<string, BlockAttrs>;
  marks: Record<string, MarkAttrs>;
  /** Block ids whose source content was non-empty — must stay non-empty on parse. */
  nonEmptyBlocks: Set<string>;
  /** Shape used by this field's leaves, controls output normalisation. */
  leafFormat: 'dast' | 'slate';
  /** Token maps used to restore placeholders per block. */
  tokenMaps: Record<string, TokenMap>;
  /**
   * Source-tree parent id for each block, or null for top-level blocks.
   * Used at parse time to detect if the model has renested blocks under the
   * wrong parent (which would silently truncate content otherwise).
   */
  blockParents: Record<string, string | null>;
}

export interface RenderResult {
  markup: string;
  attributes: AttributeStore;
}

export type IntegrityViolationType =
  | 'missing-block'
  | 'duplicate-block'
  | 'empty-block'
  | 'misnested-block'
  | 'missing-mark'
  | 'duplicate-mark'
  | 'malformed-marker'
  | 'unknown-id'
  | 'source-collision';

export interface IntegrityViolation {
  type: IntegrityViolationType;
  /** Ids involved in the violation, when applicable. */
  ids?: string[];
  /** Free-form detail for logging. */
  detail?: string;
}

export class IntegrityError extends Error {
  public readonly violations: IntegrityViolation[];
  public readonly preview: string;
  constructor(violations: IntegrityViolation[], preview: string) {
    super(
      violations
        .map((v) =>
          v.ids?.length
            ? `${v.type} [${v.ids.join(',')}]`
            : v.detail
              ? `${v.type}: ${v.detail}`
              : v.type,
        )
        .join('; '),
    );
    this.name = 'IntegrityError';
    this.violations = violations;
    this.preview = preview;
  }
}

// ---------------------------------------------------------------------------
// Render: DAST tree → markup string + attribute store
// ---------------------------------------------------------------------------

interface RenderState {
  /**
   * Monotonically increasing counter shared across every id type (B/M/I).
   * A single counter guarantees that marks belonging to a given block have
   * numeric ids strictly greater than that block's id and strictly less than
   * the next block's id, which is what `collectExpectedMarkIdsForBlock` relies
   * on to map marks back to their owning block.
   */
  idCounter: number;
  /**
   * Globally-unique placeholder counter. The upstream `tokenize` helper uses a
   * local counter that resets per call, which would collide when multiple
   * leaves contain placeholders. We rewrite its output with this counter so
   * each placeholder in the markup is unique across the whole field.
   */
  phCounter: number;
  /**
   * Id of the block currently being rendered — used to record each nested
   * block's source parent. `null` at the top level.
   */
  currentParent: string | null;
  attributes: AttributeStore;
  lines: string[];
}

/** Left delimiter for placeholders. U+27E8 — distinct from marker delimiters. */
const PH_L = '⟨';
/** Right delimiter for placeholders. U+27E9. */
const PH_R = '⟩';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextBlockId(state: RenderState): string {
  state.idCounter += 1;
  return `B${state.idCounter}`;
}

function nextMarkId(state: RenderState): string {
  state.idCounter += 1;
  return `M${state.idCounter}`;
}

function nextInlineItemId(state: RenderState): string {
  state.idCounter += 1;
  return `I${state.idCounter}`;
}

/**
 * Detect whether the field's inline leaves use DAST canonical form
 * (`{type: 'span', value, marks?}`) or the Slate-style shorthand
 * (`{text, bold?, italic?, …}`). The first leaf encountered wins.
 */
function detectLeafFormat(node: unknown): 'dast' | 'slate' | null {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const detected = detectLeafFormat(entry);
      if (detected) return detected;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  if (node.type === 'span' && typeof node.value === 'string') return 'dast';
  if (node.type === 'block') return null;
  if (typeof node.text === 'string') return 'slate';
  if (Array.isArray(node.children)) {
    return detectLeafFormat(node.children);
  }
  return null;
}

/**
 * Guard against source text that would collide with our delimiter characters.
 * A single pre-render pass throws before we even send the markup.
 */
function assertNoDelimiterCollision(children: unknown): void {
  // Marker delimiters (U+27E6/U+27E7) AND placeholder delimiters
  // (U+27E8/U+27E9). Literal placeholder delimiters in source text would
  // collide with the globally-unique ⟨PH_N⟩ tokens allocated in
  // `renderLeafText`: `detokenizeText` uses String#split/join, so any literal
  // copy of a safe token elsewhere in the field would also be substituted for
  // the original, silently corrupting the user's text.
  const markerRe = /[⟦⟧]/u;
  const placeholderRe = /[⟨⟩]/u;
  const throwCollision = (detail: string): never => {
    throw new IntegrityError([{ type: 'source-collision', detail }], '');
  };
  const checkString = (text: string, kind: 'text' | 'value'): void => {
    if (markerRe.test(text)) {
      throwCollision(
        kind === 'text'
          ? 'text contains translation-marker delimiter characters'
          : 'span value contains translation-marker delimiter characters',
      );
    }
    if (placeholderRe.test(text)) {
      throwCollision(
        kind === 'text'
          ? 'text contains placeholder delimiter characters'
          : 'span value contains placeholder delimiter characters',
      );
    }
  };
  const scan = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) scan(entry);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.text === 'string') checkString(node.text, 'text');
    if (typeof node.value === 'string') checkString(node.value, 'value');
    if (Array.isArray(node.children)) scan(node.children);
  };
  scan(children);
}

function blockHintForNode(node: UnknownRecord): BlockHint {
  const type = typeof node.type === 'string' ? node.type : '';
  switch (type) {
    case 'paragraph':
      return 'p';
    case 'heading': {
      const level = typeof node.level === 'number' ? node.level : 1;
      const clamped = Math.min(6, Math.max(1, Math.floor(level)));
      return HEADING_HINTS[clamped - 1];
    }
    case 'blockquote':
      return 'bq';
    case 'list':
      return 'list';
    case 'listItem':
      return 'li';
    case 'code':
      return 'code';
    case 'thematicBreak':
      return 'hr';
    default:
      return 'block';
  }
}

function blockAttrsForNode(node: UnknownRecord): BlockAttrs {
  const type = typeof node.type === 'string' ? node.type : '';
  switch (type) {
    case 'paragraph':
      return { kind: 'paragraph' };
    case 'heading': {
      const level = typeof node.level === 'number' ? node.level : 1;
      return {
        kind: 'heading',
        level: Math.min(6, Math.max(1, Math.floor(level))),
      };
    }
    case 'blockquote':
      return { kind: 'blockquote' };
    case 'list': {
      const style = node.style === 'numbered' ? 'numbered' : 'bulleted';
      return { kind: 'list', style };
    }
    case 'listItem':
      return { kind: 'listItem' };
    case 'code': {
      const code = typeof node.code === 'string' ? node.code : '';
      const language = typeof node.language === 'string' ? node.language : undefined;
      const highlight = Array.isArray(node.highlight)
        ? (node.highlight.filter((n) => typeof n === 'number') as number[])
        : undefined;
      return { kind: 'code', code, language, highlight };
    }
    case 'thematicBreak':
      return { kind: 'thematicBreak' };
    default:
      return { kind: 'unknown', original: node };
  }
}

/**
 * Extract the DAST mark set from a leaf node. Supports both DAST `marks: [...]`
 * and Slate boolean-property shorthand. Returns the marks in a stable order so
 * nested mark markers are deterministic.
 */
function extractMarks(node: UnknownRecord): MarkType[] {
  const out = new Set<MarkType>();
  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (typeof mark === 'string' && MARK_TYPE_SET.has(mark)) {
        out.add(mark as MarkType);
      }
    }
  }
  for (const [slateKey, dastMark] of Object.entries(SLATE_MARK_MAP)) {
    if (node[slateKey] === true) out.add(dastMark);
  }
  return MARK_TYPES.filter((m) => out.has(m));
}

function leafText(node: UnknownRecord): string | null {
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'span' && typeof node.value === 'string') return node.value;
  return null;
}

function renderInlineChildren(
  children: unknown[],
  blockId: string,
  state: RenderState,
): string {
  let out = '';
  for (const child of children) {
    out += renderInlineNode(child, blockId, state);
  }
  return out;
}

function renderLinkLike(
  node: UnknownRecord,
  kind: 'link' | 'itemLink',
  blockId: string,
  state: RenderState,
): string {
  const id = nextMarkId(state);
  state.attributes.marks[id] =
    kind === 'link'
      ? {
          kind: 'link',
          url: typeof node.url === 'string' ? node.url : '',
          meta: normaliseMeta(node.meta),
        }
      : {
          kind: 'itemLink',
          item: typeof node.item === 'string' ? node.item : '',
          meta: normaliseMeta(node.meta),
        };
  const inner = Array.isArray(node.children)
    ? renderInlineChildren(node.children, blockId, state)
    : '';
  return `${L}${id}:${kind}${R}${inner}${L}/${id}${R}`;
}

function renderInlineItem(node: UnknownRecord, state: RenderState): string {
  const id = nextInlineItemId(state);
  state.attributes.marks[id] = {
    kind: 'inlineItem',
    item: typeof node.item === 'string' ? node.item : '',
  };
  return `${L}${id}/${R}`;
}

function renderInlineNode(
  node: unknown,
  blockId: string,
  state: RenderState,
): string {
  if (!isRecord(node)) return '';
  const type = typeof node.type === 'string' ? node.type : '';

  if (type === 'link' || type === 'itemLink') {
    return renderLinkLike(node, type, blockId, state);
  }
  if (type === 'inlineItem') {
    return renderInlineItem(node, state);
  }

  const text = leafText(node);
  if (text !== null) {
    return renderLeafText(text, extractMarks(node), blockId, state);
  }

  // Unknown inline container — recurse into children if any.
  if (Array.isArray(node.children)) {
    return renderInlineChildren(node.children, blockId, state);
  }
  return '';
}

function renderLeafText(
  text: string,
  marks: MarkType[],
  blockId: string,
  state: RenderState,
): string {
  const { safe, map } = tokenize(text);
  // Rewrite the placeholder delimiters so they do not collide with our
  // marker delimiters, and so placeholder ids are globally unique across the
  // whole field (upstream tokenize uses a per-call counter).
  let rewritten = safe;
  const rewrittenMap: TokenMap = [];
  for (const entry of map) {
    const newToken = `${PH_L}PH_${state.phCounter++}${PH_R}`;
    rewritten = rewritten.split(entry.safe).join(newToken);
    rewrittenMap.push({ safe: newToken, orig: entry.orig });
  }
  const existing = state.attributes.tokenMaps[blockId] ?? [];
  state.attributes.tokenMaps[blockId] = existing.concat(rewrittenMap);

  // Allocate ids in outer→inner order so the outermost marker has the
  // lowest numeric id (matches its left-to-right position in the markup).
  const markIds = marks.map((mark) => {
    const id = nextMarkId(state);
    state.attributes.marks[id] = { kind: 'mark', mark };
    return id;
  });
  let payload = rewritten;
  for (let i = marks.length - 1; i >= 0; i--) {
    payload = `${L}${markIds[i]}:${marks[i]}${R}${payload}${L}/${markIds[i]}${R}`;
  }
  return payload;
}

function normaliseMeta(
  input: unknown,
): Array<{ id: string; value: string }> | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: Array<{ id: string; value: string }> = [];
  for (const entry of input) {
    if (
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.value === 'string'
    ) {
      out.push({ id: entry.id, value: entry.value });
    }
  }
  return out.length > 0 ? out : undefined;
}

function renderCodeBlockInto(
  node: UnknownRecord,
  id: string,
  hint: BlockHint,
  attrs: Extract<BlockAttrs, { kind: 'code' }>,
  state: RenderState,
): void {
  void node;
  if (/[⟦⟧]/u.test(attrs.code)) {
    throw new IntegrityError(
      [
        {
          type: 'source-collision',
          detail: 'code block contains marker delimiter characters',
        },
      ],
      '',
    );
  }
  state.lines.push(`${L}${id}:${hint}${R}${attrs.code}${L}/${id}${R}`);
  if (attrs.code.trim().length > 0) state.attributes.nonEmptyBlocks.add(id);
}

function renderContainerBlockInto(
  node: UnknownRecord,
  id: string,
  hint: BlockHint,
  state: RenderState,
): void {
  const inner = renderContainerChildren(node.children, state);
  state.lines.push(`${L}${id}:${hint}${R}${inner}${L}/${id}${R}`);
  if (inner.trim().length > 0) state.attributes.nonEmptyBlocks.add(id);
}

function renderInlineBlockInto(
  node: UnknownRecord,
  id: string,
  hint: BlockHint,
  state: RenderState,
): void {
  const inner = Array.isArray(node.children)
    ? renderInlineChildren(node.children, id, state)
    : '';
  state.lines.push(`${L}${id}:${hint}${R}${inner}${L}/${id}${R}`);
  if (inner.replace(/⟦[^⟧]*⟧/g, '').trim().length > 0) {
    state.attributes.nonEmptyBlocks.add(id);
  }
}

function renderBlock(node: unknown, state: RenderState): void {
  if (!isRecord(node)) return;
  const type = typeof node.type === 'string' ? node.type : '';
  if (type === 'block') return; // embedded records handled elsewhere

  const id = nextBlockId(state);
  const hint = blockHintForNode(node);
  const attrs = blockAttrsForNode(node);
  state.attributes.blocks[id] = attrs;
  state.attributes.blockParents[id] = state.currentParent;

  const savedParent = state.currentParent;
  state.currentParent = id;
  try {
    switch (attrs.kind) {
      case 'thematicBreak':
      case 'unknown':
        state.lines.push(`${L}${id}:${hint}/${R}`);
        return;
      case 'code':
        renderCodeBlockInto(node, id, hint, attrs, state);
        return;
      case 'list':
      case 'listItem':
      case 'blockquote':
        renderContainerBlockInto(node, id, hint, state);
        return;
      default:
        // paragraph, heading — inline content
        renderInlineBlockInto(node, id, hint, state);
    }
  } finally {
    state.currentParent = savedParent;
  }
}

function renderContainerChildren(
  children: unknown,
  state: RenderState,
): string {
  if (!Array.isArray(children)) return '';
  const before = state.lines.length;
  for (const child of children) {
    renderBlock(child, state);
  }
  const emitted = state.lines.splice(before);
  return emitted.join('');
}

export function renderFieldToMarkup(children: unknown[]): RenderResult {
  assertNoDelimiterCollision(children);
  const leafFormat = detectLeafFormat(children) ?? 'dast';
  const state: RenderState = {
    idCounter: 0,
    phCounter: 0,
    currentParent: null,
    lines: [],
    attributes: {
      blocks: {},
      marks: {},
      nonEmptyBlocks: new Set<string>(),
      leafFormat,
      tokenMaps: {},
      blockParents: {},
    },
  };
  for (const node of children) {
    renderBlock(node, state);
  }
  return {
    markup: state.lines.join('\n'),
    attributes: state.attributes,
  };
}

// ---------------------------------------------------------------------------
// Parse: markup string → parsed tree
// ---------------------------------------------------------------------------

type ParsedNode =
  | { kind: 'text'; text: string }
  | {
      kind: 'mark';
      id: string;
      hint?: string;
      children: ParsedNode[];
    }
  | { kind: 'void'; id: string }
  | { kind: 'block'; id: string; hint?: string; children: ParsedNode[] };

interface ParseState {
  input: string;
  pos: number;
}

const MARKER_RE = /^⟦(\/?)([BMI])(\d+)(?::([\w-]+))?(\/?)⟧/u;

function parseMarkup(input: string): ParsedNode[] {
  const state: ParseState = { input, pos: 0 };
  const tokens = parseNodes(state, null);
  return tokens;
}

function integrityMalformed(detail: string, input: string): IntegrityError {
  return new IntegrityError(
    [{ type: 'malformed-marker', detail }],
    input.slice(0, 500),
  );
}

function consumeText(state: ParseState, out: ParsedNode[]): boolean {
  const nextL = state.input.indexOf(L, state.pos);
  if (nextL === -1) {
    const text = state.input.slice(state.pos);
    if (text.length > 0) out.push({ kind: 'text', text });
    state.pos = state.input.length;
    return false;
  }
  if (nextL > state.pos) {
    out.push({ kind: 'text', text: state.input.slice(state.pos, nextL) });
    state.pos = nextL;
  }
  return true;
}

interface MarkerMatch {
  raw: string;
  slash: string;
  prefix: 'B' | 'M' | 'I';
  id: string;
  hint?: string;
  voidSlash: string;
}

function matchMarker(state: ParseState): MarkerMatch | null {
  const remaining = state.input.slice(state.pos);
  const match = MARKER_RE.exec(remaining);
  if (!match) return null;
  const [raw, slash, prefix, number, hint, voidSlash] = match;
  return {
    raw,
    slash,
    prefix: prefix as 'B' | 'M' | 'I',
    id: `${prefix}${number}`,
    hint,
    voidSlash,
  };
}

function pushVoidMarker(
  prefix: 'B' | 'M' | 'I',
  id: string,
  hint: string | undefined,
  out: ParsedNode[],
): void {
  if (prefix === 'B') {
    out.push({ kind: 'block', id, hint, children: [] });
  } else {
    out.push({ kind: 'void', id });
  }
}

/** Result of handling a single open marker. `done` means we consumed a
 *  matching close marker and should return from the current `parseNodes`
 *  invocation; `continue` means the caller should keep iterating. */
type MarkerStep = { kind: 'done' } | { kind: 'continue' };

function handleOpenMarker(
  match: MarkerMatch,
  state: ParseState,
  closeId: string | null,
  out: ParsedNode[],
): MarkerStep {
  state.pos += match.raw.length;
  if (match.slash === '/') {
    if (closeId !== match.id) {
      throw integrityMalformed(
        `unexpected closing marker ${match.id} while expecting ${closeId ?? '(top)'}`,
        state.input,
      );
    }
    return { kind: 'done' };
  }
  if (match.voidSlash === '/') {
    pushVoidMarker(match.prefix, match.id, match.hint, out);
    return { kind: 'continue' };
  }
  const children = parseNodes(state, match.id);
  if (match.prefix === 'B') {
    out.push({ kind: 'block', id: match.id, hint: match.hint, children });
  } else {
    out.push({ kind: 'mark', id: match.id, hint: match.hint, children });
  }
  return { kind: 'continue' };
}

function parseNodes(state: ParseState, closeId: string | null): ParsedNode[] {
  const out: ParsedNode[] = [];
  while (state.pos < state.input.length) {
    if (!consumeText(state, out)) break;

    const match = matchMarker(state);
    if (!match) {
      // Treat the stray `⟦` as literal text and move past it.
      out.push({ kind: 'text', text: L });
      state.pos += L.length;
      continue;
    }
    const step = handleOpenMarker(match, state, closeId, out);
    if (step.kind === 'done') return out;
  }
  if (closeId !== null) {
    throw integrityMalformed(
      `missing closing marker for ${closeId}`,
      state.input,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Integrity validation
// ---------------------------------------------------------------------------

interface IntegrityCheckInput {
  parsed: ParsedNode[];
  attributes: AttributeStore;
  preview: string;
}

type ParsedBlock = Extract<ParsedNode, { kind: 'block' }>;

/**
 * Single depth-first walk that records each parsed block, its actual parent
 * in the response, and the count of each id (for duplicate detection). Used
 * to avoid the O(N²) findBlockById scan that the original validator used.
 */
interface ParsedBlockIndex {
  /** id → node for direct lookup. When duplicated the last wins; `counts`
   *  carries the raw occurrence info for validation. */
  byId: Map<string, ParsedBlock>;
  /** id → actual parent *block* id in the response (or null if top level).
   *  Marks are transparent for parent tracking — only enclosing blocks count. */
  parentOf: Map<string, string | null>;
  /** Every observed block id in document order, duplicates included. */
  ordered: string[];
  /** id → occurrence count. */
  counts: Map<string, number>;
  /** Block ids whose walk path went through a mark before arriving. These are
   *  structurally invalid (marks cannot contain blocks) and are reported as
   *  misnested-block violations. */
  insideMark: Set<string>;
}

function recordParsedBlock(
  index: ParsedBlockIndex,
  node: ParsedBlock,
  parent: string | null,
  inMark: boolean,
): void {
  index.ordered.push(node.id);
  index.counts.set(node.id, (index.counts.get(node.id) ?? 0) + 1);
  if (!index.byId.has(node.id)) {
    index.byId.set(node.id, node);
    index.parentOf.set(node.id, parent);
  }
  if (inMark) index.insideMark.add(node.id);
}

function buildParsedBlockIndex(nodes: ParsedNode[]): ParsedBlockIndex {
  const index: ParsedBlockIndex = {
    byId: new Map(),
    parentOf: new Map(),
    ordered: [],
    counts: new Map(),
    insideMark: new Set(),
  };
  // Walks both blocks AND marks. Marks are transparent for parent tracking,
  // but if we encounter a block while currently inside a mark, we flag it —
  // a mark cannot legally contain a block, and without this flag the block
  // would be invisible (C1) so hallucinated blocks inside marks would pass
  // silently and real blocks would misreport as `missing-block`.
  const walk = (
    list: ParsedNode[],
    parent: string | null,
    inMark: boolean,
  ): void => {
    for (const node of list) {
      if (node.kind === 'block') {
        recordParsedBlock(index, node, parent, inMark);
        walk(node.children, node.id, false);
      } else if (node.kind === 'mark') {
        walk(node.children, parent, true);
      }
    }
  };
  walk(nodes, null, false);
  return index;
}

function collectMarkIds(nodes: ParsedNode[], ids: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'mark') {
      ids.push(node.id);
      collectMarkIds(node.children, ids);
    } else if (node.kind === 'void') {
      ids.push(node.id);
    } else if (node.kind === 'block') {
      // marks of nested blocks are scoped to that block, not this one
    }
  }
}

function hasVisibleText(nodes: ParsedNode[]): boolean {
  for (const node of nodes) {
    if (node.kind === 'text' && node.text.trim().length > 0) return true;
    if (node.kind === 'mark' && hasVisibleText(node.children)) return true;
    if (node.kind === 'block' && hasVisibleText(node.children)) return true;
    if (node.kind === 'void') return true;
  }
  return false;
}

/**
 * Validate the parsed tree against the expected attribute store. Collects all
 * violations and throws a single IntegrityError so the caller can log
 * everything at once.
 */
function validateBlockCounts(
  index: ParsedBlockIndex,
  attributes: AttributeStore,
): {
  violations: IntegrityViolation[];
  duplicates: string[];
} {
  const violations: IntegrityViolation[] = [];
  const expectedBlockIds = Object.keys(attributes.blocks);

  const missing = expectedBlockIds.filter((id) => !index.counts.has(id));
  if (missing.length > 0) {
    violations.push({ type: 'missing-block', ids: missing });
  }
  const duplicates = Array.from(index.counts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicates.length > 0) {
    violations.push({ type: 'duplicate-block', ids: duplicates });
  }
  const unknownUnique = Array.from(
    new Set(
      index.ordered.filter(
        (id) => !attributes.blocks[id] && !duplicates.includes(id),
      ),
    ),
  );
  if (unknownUnique.length > 0) {
    violations.push({ type: 'unknown-id', ids: unknownUnique });
  }
  return { violations, duplicates };
}

/**
 * Kinds whose direct children are *other blocks* rather than inline content.
 * Only these can legitimately wrap a nested block in the response; any other
 * kind returning a nested block is a misnest violation (H1).
 */
const BLOCK_CONTAINER_KINDS = new Set<BlockAttrs['kind']>([
  'list',
  'listItem',
  'blockquote',
]);

/**
 * Verify that every parsed block's actual parent matches the parent recorded
 * at render time. Catches the case where the model nests a block inside a
 * paragraph (or inside the wrong container), which would otherwise be
 * silently un-nested at rebuild time and drop content. Also catches blocks
 * whose walk path passed through a mark (marks cannot contain blocks).
 */
function checkBlockNesting(
  index: ParsedBlockIndex,
  attributes: AttributeStore,
  out: IntegrityViolation[],
): void {
  const offenders: string[] = [];
  const details: string[] = [];
  const describeParent = (id: string | null): string =>
    id === null ? '(top)' : id;
  for (const id of Object.keys(attributes.blocks)) {
    const actualParent = index.parentOf.get(id);
    if (actualParent === undefined) continue; // missing-block handled elsewhere
    const expectedParent = attributes.blockParents[id] ?? null;
    const insideMark = index.insideMark.has(id);
    if (actualParent !== expectedParent || insideMark) {
      offenders.push(id);
      const actualDesc = insideMark
        ? `mark (under ${describeParent(actualParent)})`
        : describeParent(actualParent);
      details.push(
        `${id} expected under ${describeParent(expectedParent)} but found under ${actualDesc}`,
      );
    }
  }
  if (offenders.length > 0) {
    out.push({
      type: 'misnested-block',
      ids: offenders,
      detail: details.join('; '),
    });
  }
}

function checkBlockEmptiness(
  blockId: string,
  attrs: BlockAttrs,
  blockNode: Extract<ParsedNode, { kind: 'block' }>,
  attributes: AttributeStore,
  out: IntegrityViolation[],
): void {
  if (
    attributes.nonEmptyBlocks.has(blockId) &&
    !BLOCK_CONTAINER_KINDS.has(attrs.kind) &&
    !hasVisibleText(blockNode.children)
  ) {
    out.push({ type: 'empty-block', ids: [blockId] });
  }
}

function checkBlockMarks(
  blockId: string,
  blockNode: Extract<ParsedNode, { kind: 'block' }>,
  attributes: AttributeStore,
  expectedBlockIds: string[],
  out: IntegrityViolation[],
): void {
  const expectedMarks = collectExpectedMarkIdsForBlock(
    attributes,
    blockId,
    expectedBlockIds,
  );
  const actualMarks: string[] = [];
  collectMarkIds(blockNode.children, actualMarks);
  const counts = new Map<string, number>();
  for (const id of actualMarks) counts.set(id, (counts.get(id) ?? 0) + 1);

  const missingMarks = expectedMarks.filter((id) => !counts.has(id));
  if (missingMarks.length > 0) {
    out.push({
      type: 'missing-mark',
      ids: missingMarks,
      detail: `block ${blockId}`,
    });
  }
  const duplicateMarks = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateMarks.length > 0) {
    out.push({
      type: 'duplicate-mark',
      ids: duplicateMarks,
      detail: `block ${blockId}`,
    });
  }
  const unknownMarksUnique = Array.from(
    new Set(
      actualMarks.filter(
        (id) => !attributes.marks[id] && !duplicateMarks.includes(id),
      ),
    ),
  );
  if (unknownMarksUnique.length > 0) {
    out.push({
      type: 'unknown-id',
      ids: unknownMarksUnique,
      detail: `block ${blockId}`,
    });
  }
}

/**
 * Run every integrity check against a pre-built parsed-block index and return
 * the collected violations. Extracted so `validateIntegrity` (public API) and
 * `parseMarkupToField` can share the exact same checks without duplicating
 * logic — the parser has the index on hand already and avoids a second walk.
 */
function runAllIntegrityChecks(
  index: ParsedBlockIndex,
  attributes: AttributeStore,
): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const { violations: countViolations } = validateBlockCounts(index, attributes);
  violations.push(...countViolations);
  checkBlockNesting(index, attributes, violations);

  const expectedBlockIds = Object.keys(attributes.blocks);
  for (const blockId of expectedBlockIds) {
    const blockNode = index.byId.get(blockId);
    if (!blockNode) continue;
    const attrs = attributes.blocks[blockId];
    checkBlockEmptiness(blockId, attrs, blockNode, attributes, violations);
    checkBlockMarks(blockId, blockNode, attributes, expectedBlockIds, violations);
  }
  return violations;
}

export function validateIntegrity(input: IntegrityCheckInput): void {
  const { parsed, attributes, preview } = input;
  const index = buildParsedBlockIndex(parsed);
  const violations = runAllIntegrityChecks(index, attributes);
  if (violations.length > 0) {
    throw new IntegrityError(violations, preview);
  }
}

/**
 * Determine which mark/inline-item ids were originally emitted inside a given
 * block. We rely on the render-time property that mark ids are assigned in a
 * depth-first traversal: a mark id belongs to a given block when it falls in
 * the numeric range between the block's own id and the next block id.
 *
 * For the *last* block, the upper bound is open-ended. For a block that is a
 * *container* (list, listItem, blockquote), marks inside its nested child
 * blocks are scoped to those child blocks, not to the container itself.
 */
function collectExpectedMarkIdsForBlock(
  attributes: AttributeStore,
  blockId: string,
  orderedBlockIds: string[],
): string[] {
  const thisIndex = orderedBlockIds.indexOf(blockId);
  if (thisIndex === -1) return [];

  const thisNum = Number(blockId.slice(1));
  // Next sibling/descendant block starts somewhere > thisNum.
  const nextBlockNum =
    thisIndex + 1 < orderedBlockIds.length
      ? Number(orderedBlockIds[thisIndex + 1].slice(1))
      : Number.POSITIVE_INFINITY;

  const out: string[] = [];
  for (const id of Object.keys(attributes.marks)) {
    const num = Number(id.slice(1));
    if (num > thisNum && num < nextBlockNum) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rebuild: parsed tree → DAST tree
// ---------------------------------------------------------------------------

type DastNode = Record<string, unknown>;

function detokenizeText(text: string, tokenMaps: TokenMap[]): string {
  let out = text;
  for (const tokenMap of tokenMaps) {
    for (const { safe, orig } of tokenMap) {
      out = out.split(safe).join(orig);
    }
  }
  return out;
}

/**
 * Emit a leaf for plain text with an optional set of active marks and token
 * map (from the originating block).
 */
function emitLeaf(
  text: string,
  marks: MarkType[],
  format: 'dast' | 'slate',
  tokenMap: TokenMap,
): DastNode | null {
  if (text === '') return null;
  const detokenized = detokenizeText(text, [tokenMap]);
  if (format === 'slate') {
    const out: DastNode = { text: detokenized };
    for (const mark of marks) {
      const slateKey = Object.entries(SLATE_MARK_MAP).find(
        ([, m]) => m === mark,
      )?.[0];
      if (slateKey) out[slateKey] = true;
    }
    return out;
  }
  const out: DastNode = { type: 'span', value: detokenized };
  if (marks.length > 0) out.marks = [...marks];
  return out;
}

interface RebuildCtx {
  attributes: AttributeStore;
  currentBlockTokenMap: TokenMap;
}

function buildLinkLikeNode(
  parsedChildren: ParsedNode[],
  marks: MarkType[],
  attrs:
    | Extract<MarkAttrs, { kind: 'link' }>
    | Extract<MarkAttrs, { kind: 'itemLink' }>,
  ctx: RebuildCtx,
): DastNode {
  const linkChildren: DastNode[] = [];
  rebuildInline(parsedChildren, marks, ctx, linkChildren);
  const linkNode: DastNode =
    attrs.kind === 'link'
      ? { type: 'link', url: attrs.url }
      : { type: 'itemLink', item: attrs.item };
  if (attrs.meta) linkNode.meta = attrs.meta;
  linkNode.children =
    linkChildren.length > 0 ? linkChildren : [emptySpan(ctx)];
  return linkNode;
}

function rebuildMarkNode(
  node: Extract<ParsedNode, { kind: 'mark' }>,
  marks: MarkType[],
  ctx: RebuildCtx,
  out: DastNode[],
): void {
  const attrs = ctx.attributes.marks[node.id];
  if (!attrs) return;
  if (attrs.kind === 'mark') {
    rebuildInline(node.children, [...marks, attrs.mark], ctx, out);
    return;
  }
  if (attrs.kind === 'link' || attrs.kind === 'itemLink') {
    out.push(buildLinkLikeNode(node.children, marks, attrs, ctx));
  }
}

function rebuildInline(
  nodes: ParsedNode[],
  marks: MarkType[],
  ctx: RebuildCtx,
  out: DastNode[],
): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      const leaf = emitLeaf(
        node.text,
        marks,
        ctx.attributes.leafFormat,
        ctx.currentBlockTokenMap,
      );
      if (leaf) out.push(leaf);
      continue;
    }
    if (node.kind === 'void') {
      const attrs = ctx.attributes.marks[node.id];
      if (attrs && attrs.kind === 'inlineItem') {
        out.push({ type: 'inlineItem', item: attrs.item });
      }
      continue;
    }
    if (node.kind === 'mark') {
      rebuildMarkNode(node, marks, ctx, out);
    }
    // `block` is intentionally ignored — misplaced blocks inside inline scope.
  }
}

function emptySpan(ctx: RebuildCtx): DastNode {
  return ctx.attributes.leafFormat === 'slate'
    ? { text: '' }
    : { type: 'span', value: '' };
}

function buildInlineBlock(
  type: 'paragraph' | 'heading',
  node: Extract<ParsedNode, { kind: 'block' }>,
  ctx: RebuildCtx,
  extra?: Record<string, unknown>,
): DastNode {
  const children: DastNode[] = [];
  rebuildInline(node.children, [], ctx, children);
  const base: DastNode = {
    type,
    children: children.length > 0 ? children : [emptySpan(ctx)],
  };
  return extra ? { ...base, ...extra } : base;
}

function buildCodeBlock(
  node: Extract<ParsedNode, { kind: 'block' }>,
  attrs: Extract<BlockAttrs, { kind: 'code' }>,
): DastNode {
  // Code blocks are explicitly NOT translated: the prompt instructs the model
  // to leave code contents alone, and the round-trip contract is "the code we
  // sent is the code we keep". If the model ignores that and rewrites the
  // code anyway, the empty-block check only catches the all-empty case — any
  // non-empty rewrite (e.g. returning "x" for a 500-line file) would pass and
  // silently destroy the original. Always use `attrs.code` from the store.
  // Do not read `node.children` here; we intentionally discard any model
  // rewrite of the code payload.
  void node;
  const out: DastNode = { type: 'code', code: attrs.code };
  if (attrs.language) out.language = attrs.language;
  if (attrs.highlight) out.highlight = attrs.highlight;
  return out;
}

function rebuildBlockNode(
  node: Extract<ParsedNode, { kind: 'block' }>,
  attributes: AttributeStore,
): DastNode | null {
  const attrs = attributes.blocks[node.id];
  if (!attrs) return null;
  const tokenMap = attributes.tokenMaps[node.id] ?? [];
  const ctx: RebuildCtx = { attributes, currentBlockTokenMap: tokenMap };

  switch (attrs.kind) {
    case 'paragraph':
      return buildInlineBlock('paragraph', node, ctx);
    case 'heading':
      return buildInlineBlock('heading', node, ctx, { level: attrs.level });
    case 'blockquote':
      return {
        type: 'blockquote',
        children: rebuildBlockChildren(node.children, attributes),
      };
    case 'list':
      return {
        type: 'list',
        style: attrs.style,
        children: rebuildBlockChildren(node.children, attributes),
      };
    case 'listItem':
      return {
        type: 'listItem',
        children: rebuildBlockChildren(node.children, attributes),
      };
    case 'code':
      return buildCodeBlock(node, attrs);
    case 'thematicBreak':
      return { type: 'thematicBreak' };
    case 'unknown':
      return attrs.original;
    default:
      return null;
  }
}

function rebuildBlockChildren(
  nodes: ParsedNode[],
  attributes: AttributeStore,
): DastNode[] {
  const out: DastNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'block') {
      const built = rebuildBlockNode(node, attributes);
      if (built) out.push(built);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level entry points
// ---------------------------------------------------------------------------

export interface ParseFieldResult {
  children: DastNode[];
}

/**
 * Top-level block kinds — those that can appear directly at the root of a
 * structured-text field. `listItem` is excluded because it only exists inside
 * a `list`.
 */
const TOP_LEVEL_BLOCK_KINDS = new Set<BlockAttrs['kind']>([
  'paragraph',
  'heading',
  'blockquote',
  'list',
  'code',
  'thematicBreak',
  'unknown',
]);

function collectTopLevelBlockIds(
  index: ParsedBlockIndex,
  attributes: AttributeStore,
): string[] {
  const sourceOrder = Object.keys(attributes.blocks);
  const topLevelIds = new Set<string>();
  for (const id of sourceOrder) {
    if (TOP_LEVEL_BLOCK_KINDS.has(attributes.blocks[id].kind)) {
      topLevelIds.add(id);
    }
  }
  for (const id of sourceOrder) {
    if (!BLOCK_CONTAINER_KINDS.has(attributes.blocks[id].kind)) continue;
    const blockNode = index.byId.get(id);
    if (!blockNode) continue;
    for (const child of blockNode.children) {
      if (child.kind === 'block') topLevelIds.delete(child.id);
    }
  }
  return sourceOrder.filter((id) => topLevelIds.has(id));
}

/**
 * Parse the LLM response markup, validate integrity, and rebuild the DAST
 * tree. Blocks are emitted in the source attribute-store order, ignoring any
 * reordering the model may have introduced. Throws IntegrityError if the
 * response fails any structural check.
 */
export function parseMarkupToField(
  markup: string,
  attributes: AttributeStore,
): ParseFieldResult {
  const parsed = parseMarkup(markup);
  const preview = markup.slice(0, 500);
  const index = buildParsedBlockIndex(parsed);

  const violations = runAllIntegrityChecks(index, attributes);
  if (violations.length > 0) {
    throw new IntegrityError(violations, preview);
  }

  const orderedTopLevelIds = collectTopLevelBlockIds(index, attributes);
  const children: DastNode[] = [];
  for (const id of orderedTopLevelIds) {
    const blockNode = index.byId.get(id);
    if (!blockNode) continue;
    const built = rebuildBlockNode(blockNode, attributes);
    if (built) children.push(built);
  }
  return { children };
}

/**
 * Build the short preservation-instruction block appended to the translation
 * prompt. Kept small so the model has strong, unambiguous guidance.
 */
export function markupInstruction(): string {
  return [
    'The content below is structured text encoded with preservation markers.',
    `Markers are of the form ${L}B{n}:hint${R}...${L}/B{n}${R} for blocks and`,
    `${L}M{n}:hint${R}...${L}/M{n}${R} for inline marks/links. Some markers are`,
    `self-closing (e.g. ${L}I{n}/${R} for inline items or ${L}B{n}:hr/${R} for`,
    'thematic breaks). Rules you MUST follow:',
    '1. Preserve every marker id exactly once, balanced, in your output.',
    '2. Do not introduce new ids, rename ids, or change the B/M/I prefix.',
    '3. You MAY reposition a marker to a different phrase in the translation',
    '   if that reads more naturally in the target language; the text inside a',
    '   marker travels with it.',
    '4. Do not translate the hint (e.g. strong, h2, link) — hints are metadata.',
    '5. Do not invent markers or remove markers.',
    '6. Keep the overall block order the same as the source.',
    '7. Return only the translated markup; no commentary, no code fences.',
  ].join('\n');
}
