/**
 * Tests for StructuredTextTranslation.ts
 * Verifies whole-field markup-based translation of structured text fields.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ctxParamsType } from '../../entrypoints/Config/ConfigScreen';
import { IntegrityError } from './StructuredTextMarkup';
import { translateStructuredTextValue } from './StructuredTextTranslation';
import type { TranslationProvider } from './types';

// Mock translateFieldValue for embedded-block translation
vi.mock('./TranslateField', () => ({
  translateFieldValue: vi.fn(),
}));

import { translateFieldValue } from './TranslateField';

describe('StructuredTextTranslation', () => {
  const mockPluginParams: ctxParamsType = {
    apiKey: 'test-key',
    gptModel: 'gpt-4',
    translationFields: [],
    translateWholeRecord: false,
    translateBulkRecords: false,
    prompt: '',
    modelsToBeExcludedFromThisPlugin: [],
    rolesToBeExcludedFromThisPlugin: [],
    apiKeysToBeExcludedFromThisPlugin: [],
    enableDebugging: false,
  };

  let mockProvider: TranslationProvider;
  let completeText: Mock<(prompt: string) => Promise<string>>;

  beforeEach(() => {
    vi.clearAllMocks();
    completeText = vi.fn();
    mockProvider = {
      vendor: 'openai',
      streamText: vi.fn(),
      completeText: completeText as unknown as TranslationProvider['completeText'],
    };
  });

  describe('empty/invalid value handling', () => {
    it('returns null for null value', async () => {
      const result = await translateStructuredTextValue(
        null,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(result).toBe(null);
      expect(completeText).not.toHaveBeenCalled();
    });

    it('returns empty array for empty array', async () => {
      const result = await translateStructuredTextValue(
        [],
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(result).toEqual([]);
      expect(completeText).not.toHaveBeenCalled();
    });

    it('returns non-array values as-is', async () => {
      const result = await translateStructuredTextValue(
        'not an array',
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(result).toBe('not an array');
    });
  });

  describe('simple paragraph translation', () => {
    it('translates text in a paragraph (DAST leaf)', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Hallo Welt⟦/B1⟧');

      const source = [
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Hello World' }],
        },
      ];
      const result = await translateStructuredTextValue(
        source,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(result).toEqual([
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Hallo Welt' }],
        },
      ]);
      expect(completeText).toHaveBeenCalledTimes(1);
      const prompt = completeText.mock.calls[0][0];
      expect(prompt).toContain('⟦B1:p⟧Hello World⟦/B1⟧');
      expect(prompt).toContain('preservation markers');
    });

    it('translates Slate-format paragraphs, preserving leaf shape', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Hallo Welt⟦/B1⟧');

      const source = [
        {
          type: 'paragraph',
          children: [{ text: 'Hello World' }],
        },
      ];
      const result = await translateStructuredTextValue(
        source,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(result).toEqual([
        {
          type: 'paragraph',
          children: [{ text: 'Hallo Welt' }],
        },
      ]);
    });
  });

  describe('formatting marks and links', () => {
    it('preserves bold marks through round trip (DAST)', async () => {
      completeText.mockImplementation(async (prompt: string) => {
        expect(prompt).toContain(
          '⟦B1:p⟧Hello ⟦M2:strong⟧world⟦/M2⟧⟦/B1⟧',
        );
        return '⟦B1:p⟧Bonjour ⟦M2:strong⟧monde⟦/M2⟧⟦/B1⟧';
      });
      const source = [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hello ' },
            { type: 'span', value: 'world', marks: ['strong'] },
          ],
        },
      ];
      const result = await translateStructuredTextValue(
        source,
        mockPluginParams,
        'fr',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(result).toEqual([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Bonjour ' },
            { type: 'span', value: 'monde', marks: ['strong'] },
          ],
        },
      ]);
    });

    it('keeps Slate bold/italic boolean shape on output', async () => {
      completeText.mockResolvedValue(
        '⟦B1:p⟧⟦M2:strong⟧Fett⟦/M2⟧⟦M3:emphasis⟧Kursiv⟦/M3⟧⟦/B1⟧',
      );
      const source = [
        {
          type: 'paragraph',
          children: [
            { text: 'Bold', bold: true },
            { text: 'Italic', italic: true },
          ],
        },
      ];
      const result = (await translateStructuredTextValue(
        source,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<{ children: Array<{ text: string; bold?: boolean; italic?: boolean }> }>;
      expect(result[0].children).toEqual([
        { text: 'Fett', bold: true },
        { text: 'Kursiv', italic: true },
      ]);
    });

    it('keeps link url and meta untouched while translating the anchor text', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧⟦M2:link⟧Clicca qui⟦/M2⟧⟦/B1⟧');
      const source = [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com',
              meta: [{ id: 'target', value: '_blank' }],
              children: [{ type: 'span', value: 'Click here' }],
            },
          ],
        },
      ];
      const result = (await translateStructuredTextValue(
        source,
        mockPluginParams,
        'it',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<{
        children: Array<{
          url: string;
          meta: Array<{ value: string }>;
          children: Array<{ value: string }>;
        }>;
      }>;
      const link = result[0].children[0];
      expect(link.url).toBe('https://example.com');
      expect(link.meta).toEqual([{ id: 'target', value: '_blank' }]);
      expect(link.children[0].value).toBe('Clicca qui');
      // The URL must never appear in the prompt sent to the model.
      const prompt = completeText.mock.calls[0][0] as string;
      expect(prompt).not.toContain('example.com');
    });
  });

  describe('embedded block nodes', () => {
    it('extracts blocks, translates them via translateFieldValue, and reinserts at original position', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Übersetzt⟦/B1⟧');
      vi.mocked(translateFieldValue).mockResolvedValue([
        { type: 'block', item: 'block-123', originalIndex: 1 },
      ]);

      const source = [
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Translated' }],
        },
        { type: 'block', item: 'block-123' },
      ];
      const result = (await translateStructuredTextValue(
        source,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<{ type: string }>;
      expect(result).toHaveLength(2);
      expect(result[1].type).toBe('block');
      expect(translateFieldValue).toHaveBeenCalledWith(
        expect.any(Array),
        mockPluginParams,
        'de',
        'en',
        'rich_text',
        mockProvider,
        '',
        'api-token',
        '',
        'main',
        undefined,
        '',
        undefined,
        { bypassFieldTypeAllowlist: true },
      );
    });

    it('places an embedded block between two inline paragraphs at the original index (H4)', async () => {
      completeText.mockResolvedValue(
        '⟦B1:p⟧Premier⟦/B1⟧\n⟦B2:p⟧Dernier⟦/B2⟧',
      );
      vi.mocked(translateFieldValue).mockResolvedValue([
        { type: 'block', item: 'block-1', originalIndex: 1 },
      ]);
      const source = [
        { type: 'paragraph', children: [{ type: 'span', value: 'First' }] },
        { type: 'block', item: 'block-1' },
        { type: 'paragraph', children: [{ type: 'span', value: 'Last' }] },
      ];
      const result = (await translateStructuredTextValue(
        source,
        mockPluginParams,
        'fr',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<{ type: string; item?: string; children?: unknown[] }>;
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('paragraph');
      expect(result[1].type).toBe('block');
      expect(result[1].item).toBe('block-1');
      expect(result[2].type).toBe('paragraph');
    });

    it('restores source order even when embedded blocks are returned in reverse (H4)', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Milieu⟦/B1⟧');
      // Source has embedded at index 0 and index 2 (inline at index 1).
      // Upstream translateFieldValue returns them in REVERSE order.
      vi.mocked(translateFieldValue).mockResolvedValue([
        { type: 'block', item: 'block-last', originalIndex: 2 },
        { type: 'block', item: 'block-first', originalIndex: 0 },
      ]);
      const source = [
        { type: 'block', item: 'block-first' },
        { type: 'paragraph', children: [{ type: 'span', value: 'Middle' }] },
        { type: 'block', item: 'block-last' },
      ];
      const result = (await translateStructuredTextValue(
        source,
        mockPluginParams,
        'fr',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<{ type: string; item?: string }>;
      expect(result).toHaveLength(3);
      expect(result[0].item).toBe('block-first');
      expect(result[1].type).toBe('paragraph');
      expect(result[2].item).toBe('block-last');
    });

    it('throws when inline translated count diverges from source inline count (H4)', async () => {
      // Simulate drift: mock parseMarkupToField-style scenario where the
      // provider returns markup that parses successfully but the inline
      // translator emits a different number of top-level items than went in.
      // We exercise this via translateFieldValue returning an embedded node
      // whose originalIndex collides with what inline would produce — the
      // simpler test is to feed a mismatched inline count from the inline
      // round trip. We force this by having the provider return markup that
      // causes rebuilds to fail silently: since rebuildBlockNode already
      // drops unknown-attrs nodes, we exercise an alternate drift path by
      // having translateFieldValue return an embedded originalIndex that is
      // out of bounds for the merged array.
      completeText.mockResolvedValue('⟦B1:p⟧Un⟦/B1⟧');
      vi.mocked(translateFieldValue).mockResolvedValue([
        // originalIndex 10 is way beyond totalLength=2 — merge should throw.
        { type: 'block', item: 'oob', originalIndex: 10 },
      ]);
      const source = [
        { type: 'paragraph', children: [{ type: 'span', value: 'One' }] },
        { type: 'block', item: 'oob' },
      ];
      await expect(
        translateStructuredTextValue(
          source,
          mockPluginParams,
          'de',
          'en',
          mockProvider,
          'api-token',
          'main',
        ),
      ).rejects.toThrow();
    });

    it('translates fields that contain only embedded blocks (no inline content)', async () => {
      vi.mocked(translateFieldValue).mockResolvedValue([
        { type: 'block', item: 'block-1', originalIndex: 0 },
      ]);
      const source = [{ type: 'block', item: 'block-1' }];
      const result = (await translateStructuredTextValue(
        source,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<{ type: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('block');
      expect(completeText).not.toHaveBeenCalled();
    });
  });

  describe('API response format handling', () => {
    it('preserves document.children wrapper format', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Hallo Welt⟦/B1⟧');
      const apiResponse = {
        document: {
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'span', value: 'Hello World' }],
            },
          ],
          type: 'root',
        },
        schema: 'dast',
      };
      const result = await translateStructuredTextValue(
        apiResponse,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(result).toHaveProperty('document');
      expect(result).toHaveProperty('schema', 'dast');
    });
  });

  describe('id removal', () => {
    it('strips id fields from inputs before sending', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Hallo⟦/B1⟧');
      const source = [
        {
          id: 'node-123',
          type: 'paragraph',
          children: [{ id: 'text-456', type: 'span', value: 'Hello' }],
        },
      ];
      const result = (await translateStructuredTextValue(
        source,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<{ id?: string; children: Array<{ id?: string }> }>;
      expect(result[0].id).toBeUndefined();
      expect(result[0].children[0].id).toBeUndefined();
    });
  });

  describe('integrity violations', () => {
    it('throws IntegrityError when the model drops a block', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Hallo⟦/B1⟧');
      const source = [
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Hello' }],
        },
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'World' }],
        },
      ];
      await expect(
        translateStructuredTextValue(
          source,
          mockPluginParams,
          'de',
          'en',
          mockProvider,
          'api-token',
          'main',
        ),
      ).rejects.toBeInstanceOf(IntegrityError);
    });

    it('throws IntegrityError when the model drops a mark', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Hi bold⟦/B1⟧');
      const source = [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hi ' },
            { type: 'span', value: 'bold', marks: ['strong'] },
          ],
        },
      ];
      await expect(
        translateStructuredTextValue(
          source,
          mockPluginParams,
          'de',
          'en',
          mockProvider,
          'api-token',
          'main',
        ),
      ).rejects.toBeInstanceOf(IntegrityError);
    });

    it('logs failure details via console.error before throwing', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Hi⟦/B1⟧');
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const source = [
        { type: 'paragraph', children: [{ type: 'span', value: 'Hi' }] },
        { type: 'paragraph', children: [{ type: 'span', value: 'Yo' }] },
      ];
      try {
        await expect(
          translateStructuredTextValue(
            source,
            mockPluginParams,
            'de',
            'en',
            mockProvider,
            'api-token',
            'main',
          ),
        ).rejects.toBeInstanceOf(IntegrityError);
        expect(consoleSpy).toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('error handling', () => {
    it('propagates provider errors', async () => {
      completeText.mockRejectedValue(new Error('API Error'));
      const source = [
        { type: 'paragraph', children: [{ type: 'span', value: 'Hello' }] },
      ];
      await expect(
        translateStructuredTextValue(
          source,
          mockPluginParams,
          'de',
          'en',
          mockProvider,
          'api-token',
          'main',
        ),
      ).rejects.toThrow();
    });
  });

  describe('stream callbacks', () => {
    it('forwards stream callbacks to the embedded-block translator', async () => {
      completeText.mockResolvedValue('⟦B1:p⟧Text⟦/B1⟧');
      vi.mocked(translateFieldValue).mockResolvedValue([
        { type: 'block', item: 'block-1', originalIndex: 1 },
      ]);
      const callbacks = { onStream: vi.fn(), onComplete: vi.fn() };
      const source = [
        { type: 'paragraph', children: [{ type: 'span', value: 'Text' }] },
        { type: 'block', item: 'block-1' },
      ];
      await translateStructuredTextValue(
        source,
        mockPluginParams,
        'de',
        'en',
        mockProvider,
        'api-token',
        'main',
        callbacks,
      );
      expect(translateFieldValue).toHaveBeenCalledWith(
        expect.any(Array),
        mockPluginParams,
        'de',
        'en',
        'rich_text',
        mockProvider,
        '',
        'api-token',
        '',
        'main',
        callbacks,
        '',
        undefined,
        { bypassFieldTypeAllowlist: true },
      );
    });
  });

  describe('cross-paragraph coherence', () => {
    it('sends all paragraphs in a single call so the model has full context', async () => {
      completeText.mockResolvedValue(
        '⟦B1:p⟧Première⟦/B1⟧\n⟦B2:p⟧Deuxième⟦/B2⟧\n⟦B3:p⟧Troisième⟦/B3⟧',
      );
      const source = [
        { type: 'paragraph', children: [{ type: 'span', value: 'First' }] },
        { type: 'paragraph', children: [{ type: 'span', value: 'Second' }] },
        { type: 'paragraph', children: [{ type: 'span', value: 'Third' }] },
      ];
      await translateStructuredTextValue(
        source,
        mockPluginParams,
        'fr',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      expect(completeText).toHaveBeenCalledTimes(1);
      const prompt = completeText.mock.calls[0][0] as string;
      expect(prompt).toContain('⟦B1:p⟧First⟦/B1⟧');
      expect(prompt).toContain('⟦B2:p⟧Second⟦/B2⟧');
      expect(prompt).toContain('⟦B3:p⟧Third⟦/B3⟧');
    });
  });

  describe('realistic article end-to-end', () => {
    const article = [
      {
        type: 'heading',
        level: 1,
        children: [{ type: 'span', value: 'My Article' }],
      },
      {
        type: 'paragraph',
        children: [
          { type: 'span', value: 'Welcome to ' },
          { type: 'span', value: 'my blog', marks: ['strong'] },
          { type: 'span', value: ', where we talk about ' },
          {
            type: 'link',
            url: 'https://example.com/tech',
            meta: [{ id: 'target', value: '_blank' }],
            children: [{ type: 'span', value: 'technology' }],
          },
          { type: 'span', value: '.' },
        ],
      },
      {
        type: 'list',
        style: 'bulleted',
        children: [
          {
            type: 'listItem',
            children: [
              {
                type: 'paragraph',
                children: [
                  { type: 'span', value: 'Frontend with ' },
                  { type: 'span', value: 'React', marks: ['strong'] },
                ],
              },
            ],
          },
          {
            type: 'listItem',
            children: [
              {
                type: 'paragraph',
                children: [
                  { type: 'span', value: 'Backend ' },
                  { type: 'span', value: 'systems', marks: ['emphasis'] },
                ],
              },
            ],
          },
        ],
      },
      { type: 'thematicBreak' },
      {
        type: 'paragraph',
        children: [
          { type: 'span', value: 'See also: ' },
          { type: 'inlineItem', item: 'record-42' },
          { type: 'span', value: '.' },
        ],
      },
    ];

    it('translates a realistic article in ONE call and preserves all structure', async () => {
      // The mock takes the prompt, extracts the markup (everything from the
      // first marker onward), and performs a minimal English→Italian rewrite
      // that leaves every marker and all attribute-bearing nodes untouched.
      completeText.mockImplementation(async (prompt: string) => {
        const markupStart = prompt.indexOf('⟦');
        const markup = prompt.slice(markupStart);
        return markup
          .replace('My Article', 'Il Mio Articolo')
          .replace('Welcome to ', 'Benvenuti nel ')
          .replace('my blog', 'mio blog')
          .replace(', where we talk about ', ', dove parliamo di ')
          .replace('technology', 'tecnologia')
          .replace('Frontend with ', 'Frontend con ')
          .replace('Backend ', 'Backend ')
          .replace('systems', 'sistemi')
          .replace('See also: ', 'Vedi anche: ');
      });

      const result = (await translateStructuredTextValue(
        article,
        mockPluginParams,
        'it',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as Array<Record<string, unknown>>;

      expect(completeText).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(5);

      // Heading + level survived
      const heading = result[0] as {
        type: string;
        level: number;
        children: Array<{ value: string }>;
      };
      expect(heading.type).toBe('heading');
      expect(heading.level).toBe(1);
      expect(heading.children[0].value).toBe('Il Mio Articolo');

      // Link url + meta survived, anchor text translated
      const paragraph = result[1] as { children: unknown[] };
      const link = paragraph.children.find(
        (n) => (n as { type?: string }).type === 'link',
      ) as {
        url: string;
        meta: Array<{ id: string; value: string }>;
        children: Array<{ value: string }>;
      };
      expect(link.url).toBe('https://example.com/tech');
      expect(link.meta).toEqual([{ id: 'target', value: '_blank' }]);
      expect(link.children[0].value).toBe('tecnologia');

      // List style preserved
      const list = result[2] as { type: string; style: string };
      expect(list.type).toBe('list');
      expect(list.style).toBe('bulleted');

      // thematicBreak intact
      expect((result[3] as { type: string }).type).toBe('thematicBreak');

      // inlineItem reference intact
      const lastPara = result[4] as { children: unknown[] };
      const inlineItem = lastPara.children.find(
        (n) => (n as { type?: string }).type === 'inlineItem',
      ) as { item: string };
      expect(inlineItem.item).toBe('record-42');

      // No URL, item-ref, or meta ever hit the prompt
      const prompt = completeText.mock.calls[0][0] as string;
      expect(prompt).not.toContain('https://example.com/tech');
      expect(prompt).not.toContain('record-42');
      expect(prompt).not.toContain('_blank');
    });

    it('splits an oversized field into sequential batches at block boundaries', async () => {
      // MAX_MARKUP_CHARS_PER_CALL is 40_000. Build a document whose rendered
      // markup clearly exceeds that, with one block per heavy paragraph, so
      // partitionIntoBatches breaks it apart. Each batch ends up going through
      // `provider.completeText` separately.
      const heavyText = 'x'.repeat(12000);
      const source: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        source.push({
          type: 'paragraph',
          children: [{ type: 'span', value: `${heavyText} #${i}` }],
        });
      }
      completeText.mockImplementation(async (prompt: string) => {
        const markupStart = prompt.indexOf('⟦');
        return prompt.slice(markupStart);
      });
      await translateStructuredTextValue(
        source,
        mockPluginParams,
        'fr',
        'en',
        mockProvider,
        'api-token',
        'main',
      );
      // 5 × 12_000-byte paragraphs cannot fit in one 40_000-byte budget.
      expect(completeText.mock.calls.length).toBeGreaterThan(1);
    });

    it('preserves a document.children wrapper through a realistic article', async () => {
      completeText.mockImplementation(async (prompt: string) => {
        const markupStart = prompt.indexOf('⟦');
        return prompt.slice(markupStart);
      });

      const wrapped = {
        document: { children: article, type: 'root' },
        schema: 'dast',
      };
      const result = (await translateStructuredTextValue(
        wrapped,
        mockPluginParams,
        'it',
        'en',
        mockProvider,
        'api-token',
        'main',
      )) as { document: { children: unknown[]; type: string }; schema: string };

      expect(result.schema).toBe('dast');
      expect(result.document.type).toBe('root');
      expect(result.document.children).toHaveLength(article.length);
    });
  });
});
