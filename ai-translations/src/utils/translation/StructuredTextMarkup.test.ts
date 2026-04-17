import { describe, expect, it } from 'vitest';
import {
  IntegrityError,
  markupInstruction,
  parseMarkupToField,
  renderFieldToMarkup,
} from './StructuredTextMarkup';

describe('StructuredTextMarkup', () => {
  describe('renderFieldToMarkup', () => {
    it('renders a plain paragraph with one span', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Hello world' }],
        },
      ]);
      expect(markup).toBe('⟦B1:p⟧Hello world⟦/B1⟧');
      expect(attributes.blocks).toEqual({ B1: { kind: 'paragraph' } });
      expect(Object.keys(attributes.marks)).toEqual([]);
    });

    it('wraps span marks in nested mark markers', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hello ' },
            { type: 'span', value: 'world', marks: ['strong'] },
            { type: 'span', value: '!' },
          ],
        },
      ]);
      expect(markup).toBe('⟦B1:p⟧Hello ⟦M2:strong⟧world⟦/M2⟧!⟦/B1⟧');
      expect(attributes.marks).toEqual({ M2: { kind: 'mark', mark: 'strong' } });
    });

    it('combines multiple marks into nested markers in a stable order', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'x', marks: ['emphasis', 'strong'] },
          ],
        },
      ]);
      expect(markup).toBe('⟦B1:p⟧⟦M2:strong⟧⟦M3:emphasis⟧x⟦/M3⟧⟦/M2⟧⟦/B1⟧');
      expect(attributes.marks.M2).toEqual({ kind: 'mark', mark: 'strong' });
      expect(attributes.marks.M3).toEqual({ kind: 'mark', mark: 'emphasis' });
    });

    it('stores link url out-of-band and does not emit it in markup', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'see ' },
            {
              type: 'link',
              url: 'https://example.com',
              meta: [{ id: 'target', value: '_blank' }],
              children: [{ type: 'span', value: 'docs' }],
            },
          ],
        },
      ]);
      expect(markup).not.toContain('example.com');
      expect(markup).toBe('⟦B1:p⟧see ⟦M2:link⟧docs⟦/M2⟧⟦/B1⟧');
      expect(attributes.marks.M2).toEqual({
        kind: 'link',
        url: 'https://example.com',
        meta: [{ id: 'target', value: '_blank' }],
      });
    });

    it('renders inline items as self-closing void markers', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'before ' },
            { type: 'inlineItem', item: 'record-42' },
            { type: 'span', value: ' after' },
          ],
        },
      ]);
      expect(markup).toBe('⟦B1:p⟧before ⟦I2/⟧ after⟦/B1⟧');
      expect(attributes.marks.I2).toEqual({
        kind: 'inlineItem',
        item: 'record-42',
      });
    });

    it('renders headings with level hint', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'heading',
          level: 3,
          children: [{ type: 'span', value: 'About' }],
        },
      ]);
      expect(markup).toBe('⟦B1:h3⟧About⟦/B1⟧');
      expect(attributes.blocks.B1).toEqual({ kind: 'heading', level: 3 });
    });

    it('renders lists with nested listItems', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'list',
          style: 'bulleted',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'span', value: 'First' }],
                },
              ],
            },
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'span', value: 'Second' }],
                },
              ],
            },
          ],
        },
      ]);
      expect(markup).toBe(
        '⟦B1:list⟧⟦B2:li⟧⟦B3:p⟧First⟦/B3⟧⟦/B2⟧⟦B4:li⟧⟦B5:p⟧Second⟦/B5⟧⟦/B4⟧⟦/B1⟧',
      );
      expect(attributes.blocks.B1).toEqual({
        kind: 'list',
        style: 'bulleted',
      });
    });

    it('renders thematicBreak as self-closing void marker', () => {
      const { markup, attributes } = renderFieldToMarkup([
        { type: 'thematicBreak' },
      ]);
      expect(markup).toBe('⟦B1:hr/⟧');
      expect(attributes.blocks.B1).toEqual({ kind: 'thematicBreak' });
    });

    it('throws when source text contains marker delimiters', () => {
      expect(() =>
        renderFieldToMarkup([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: 'has ⟦ delimiter' }],
          },
        ]),
      ).toThrow(IntegrityError);
    });

    it('accepts Slate-style leaves with boolean marks', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { text: 'Hello ' },
            { text: 'world', bold: true },
            { text: '!' },
          ],
        },
      ]);
      expect(markup).toBe('⟦B1:p⟧Hello ⟦M2:strong⟧world⟦/M2⟧!⟦/B1⟧');
      expect(attributes.leafFormat).toBe('slate');
    });

    it('protects ICU placeholders through tokenisation', () => {
      const { markup } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hello {name}, you have {count} items' },
          ],
        },
      ]);
      expect(markup).toContain('⟨PH_0⟩');
      expect(markup).toContain('⟨PH_1⟩');
      expect(markup).not.toContain('{name}');
    });
  });

  describe('parseMarkupToField (round trip)', () => {
    it('round trips a plain paragraph unchanged', () => {
      const source = [
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Hello world' }],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips a paragraph with bold span', () => {
      const source = [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hello ' },
            { type: 'span', value: 'world', marks: ['strong'] },
            { type: 'span', value: '!' },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips a link with meta', () => {
      const source = [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com',
              meta: [{ id: 'target', value: '_blank' }],
              children: [{ type: 'span', value: 'click' }],
            },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips inline items', () => {
      const source = [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'before ' },
            { type: 'inlineItem', item: 'record-42' },
            { type: 'span', value: ' after' },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips a list with nested items', () => {
      const source = [
        {
          type: 'list',
          style: 'bulleted',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'span', value: 'First' }],
                },
              ],
            },
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'span', value: 'Second' }],
                },
              ],
            },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips a thematicBreak', () => {
      const source = [{ type: 'thematicBreak' }];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('applies a translated response, replacing text', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hello ' },
            { type: 'span', value: 'world', marks: ['strong'] },
            { type: 'span', value: '!' },
          ],
        },
      ]);
      expect(markup).toBe('⟦B1:p⟧Hello ⟦M2:strong⟧world⟦/M2⟧!⟦/B1⟧');
      const translated = '⟦B1:p⟧Bonjour ⟦M2:strong⟧monde⟦/M2⟧ !⟦/B1⟧';
      const { children } = parseMarkupToField(translated, attributes);
      expect(children).toEqual([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Bonjour ' },
            { type: 'span', value: 'monde', marks: ['strong'] },
            { type: 'span', value: ' !' },
          ],
        },
      ]);
    });

    it('supports mark repositioning within a block (en → ja)', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'The ' },
            { type: 'span', value: 'red', marks: ['strong'] },
            { type: 'span', value: ' car is ' },
            { type: 'span', value: 'fast', marks: ['emphasis'] },
            { type: 'span', value: '.' },
          ],
        },
      ]);
      expect(markup).toBe(
        '⟦B1:p⟧The ⟦M2:strong⟧red⟦/M2⟧ car is ⟦M3:emphasis⟧fast⟦/M3⟧.⟦/B1⟧',
      );
      // Model returns with M3 (em) first, then M2 (strong)
      const translated =
        '⟦B1:p⟧その車は⟦M3:emphasis⟧速く⟦/M3⟧て、⟦M2:strong⟧赤い⟦/M2⟧。⟦/B1⟧';
      const { children } = parseMarkupToField(translated, attributes);
      expect(children).toEqual([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'その車は' },
            { type: 'span', value: '速く', marks: ['emphasis'] },
            { type: 'span', value: 'て、' },
            { type: 'span', value: '赤い', marks: ['strong'] },
            { type: 'span', value: '。' },
          ],
        },
      ]);
    });

    it('silently re-sorts blocks returned in wrong order', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'First' }],
        },
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Second' }],
        },
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Third' }],
        },
      ]);
      expect(markup).toBe(
        '⟦B1:p⟧First⟦/B1⟧\n⟦B2:p⟧Second⟦/B2⟧\n⟦B3:p⟧Third⟦/B3⟧',
      );
      // Model returns in different order
      const scrambled =
        '⟦B3:p⟧Troisième⟦/B3⟧\n⟦B1:p⟧Premier⟦/B1⟧\n⟦B2:p⟧Deuxième⟦/B2⟧';
      const { children } = parseMarkupToField(scrambled, attributes);
      expect(children).toEqual([
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Premier' }],
        },
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Deuxième' }],
        },
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Troisième' }],
        },
      ]);
    });

    it('restores tokenised placeholders after parse', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hello {name}, you have {count} items' },
          ],
        },
      ]);
      // Model would translate, preserving the ⟦PH_n⟧ tokens
      const translated = markup
        .replace('Hello', 'Bonjour')
        .replace('you have', 'vous avez')
        .replace('items', 'éléments');
      const { children } = parseMarkupToField(translated, attributes);
      expect(children).toEqual([
        {
          type: 'paragraph',
          children: [
            {
              type: 'span',
              value: 'Bonjour {name}, vous avez {count} éléments',
            },
          ],
        },
      ]);
    });
  });

  describe('integrity violations', () => {
    it('throws on missing block id', () => {
      const { attributes } = renderFieldToMarkup([
        { type: 'paragraph', children: [{ type: 'span', value: 'A' }] },
        { type: 'paragraph', children: [{ type: 'span', value: 'B' }] },
      ]);
      expect(() =>
        parseMarkupToField('⟦B1:p⟧A⟦/B1⟧', attributes),
      ).toThrow(IntegrityError);
      try {
        parseMarkupToField('⟦B1:p⟧A⟦/B1⟧', attributes);
      } catch (err) {
        expect(err).toBeInstanceOf(IntegrityError);
        const e = err as IntegrityError;
        expect(e.violations).toContainEqual(
          expect.objectContaining({ type: 'missing-block', ids: ['B2'] }),
        );
      }
    });

    it('throws on duplicate block id', () => {
      const { attributes } = renderFieldToMarkup([
        { type: 'paragraph', children: [{ type: 'span', value: 'A' }] },
      ]);
      expect(() =>
        parseMarkupToField('⟦B1:p⟧A⟦/B1⟧⟦B1:p⟧A⟦/B1⟧', attributes),
      ).toThrow(IntegrityError);
      try {
        parseMarkupToField('⟦B1:p⟧A⟦/B1⟧⟦B1:p⟧A⟦/B1⟧', attributes);
      } catch (err) {
        const e = err as IntegrityError;
        expect(e.violations).toContainEqual(
          expect.objectContaining({ type: 'duplicate-block', ids: ['B1'] }),
        );
      }
    });

    it('throws on empty block where source was non-empty', () => {
      const { attributes } = renderFieldToMarkup([
        { type: 'paragraph', children: [{ type: 'span', value: 'Hello' }] },
      ]);
      expect(() =>
        parseMarkupToField('⟦B1:p⟧⟦/B1⟧', attributes),
      ).toThrow(IntegrityError);
    });

    it('throws on missing mark id', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hi ' },
            { type: 'span', value: 'bold', marks: ['strong'] },
          ],
        },
      ]);
      // Model drops the mark
      const badResponse = markup.replace(/⟦M2:strong⟧/g, '').replace(/⟦\/M2⟧/g, '');
      expect(() => parseMarkupToField(badResponse, attributes)).toThrow(
        IntegrityError,
      );
    });

    it('throws on duplicate mark id within a block', () => {
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'a', marks: ['strong'] },
            { type: 'span', value: 'b' },
          ],
        },
      ]);
      // Duplicate M2 inside B1
      const bad = markup.replace(
        '⟦M2:strong⟧a⟦/M2⟧b',
        '⟦M2:strong⟧a⟦/M2⟧⟦M2:strong⟧b⟦/M2⟧',
      );
      expect(() => parseMarkupToField(bad, attributes)).toThrow(IntegrityError);
    });

    it('throws on unknown id', () => {
      const { attributes } = renderFieldToMarkup([
        { type: 'paragraph', children: [{ type: 'span', value: 'Hi' }] },
      ]);
      expect(() =>
        parseMarkupToField('⟦B1:p⟧Hi⟦/B1⟧⟦B99:p⟧hallucinated⟦/B99⟧', attributes),
      ).toThrow(IntegrityError);
    });

    it('throws on unclosed marker', () => {
      const { attributes } = renderFieldToMarkup([
        { type: 'paragraph', children: [{ type: 'span', value: 'Hi' }] },
      ]);
      expect(() => parseMarkupToField('⟦B1:p⟧unclosed', attributes)).toThrow(
        IntegrityError,
      );
    });

    it('throws on source text containing marker delimiter', () => {
      expect(() =>
        renderFieldToMarkup([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: '⟦ literal' }],
          },
        ]),
      ).toThrow(IntegrityError);
    });

    it('throws on source text containing placeholder delimiter (left)', () => {
      // H2: U+27E8 (⟨) is reserved for placeholder tokens. If the user's
      // source text contains a literal ⟨PH_7⟩, detokenizeText would replace
      // it wherever another leaf uses that safe token, corrupting content.
      expect(() =>
        renderFieldToMarkup([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: 'has ⟨ bracket' }],
          },
        ]),
      ).toThrow(IntegrityError);
    });

    it('throws on source text containing placeholder delimiter (right)', () => {
      expect(() =>
        renderFieldToMarkup([
          {
            type: 'paragraph',
            children: [{ type: 'span', value: 'has ⟩ bracket' }],
          },
        ]),
      ).toThrow(IntegrityError);
    });

    it('throws source-collision for Slate-shape leaves with placeholder delimiters', () => {
      expect(() =>
        renderFieldToMarkup([
          {
            type: 'paragraph',
            children: [{ text: 'fake ⟨PH_7⟩ already' }],
          },
        ]),
      ).toThrow(IntegrityError);
    });

    it('flags block nested inside a mark as misnested-block (C1)', () => {
      // Source has a bold span; the model returns ⟦M2:strong⟧⟦B3:p⟧hi⟦/B3⟧⟦/M2⟧
      // with a hallucinated block inside the mark. Without the walker
      // descending into marks this would be invisible (B3 never indexed;
      // real B2 content reported as empty-block instead of the true cause).
      const { attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Hi ' },
            { type: 'span', value: 'there', marks: ['strong'] },
          ],
        },
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'second' }],
        },
      ]);
      const bad =
        '⟦B1:p⟧Hola ⟦M2:strong⟧⟦B3:p⟧nested⟦/B3⟧⟦/M2⟧⟦/B1⟧\n⟦B4:p⟧segundo⟦/B4⟧';
      expect(() => parseMarkupToField(bad, attributes)).toThrow(IntegrityError);
      try {
        parseMarkupToField(bad, attributes);
      } catch (err) {
        const e = err as IntegrityError;
        // B3 is misnested (wrapped in mark) AND it's an unknown id.
        expect(e.violations).toContainEqual(
          expect.objectContaining({ type: 'misnested-block', ids: ['B3'] }),
        );
      }
    });

    it('flags a known block hallucinated inside a mark as misnested-block (C1)', () => {
      // Source has two sibling paragraphs. Model wraps B2 inside M2's content
      // (and the mark itself is inside B1). B2 is known; missing-block would
      // be wrong — the actual issue is the mark wrapper.
      const { attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'One ' },
            { type: 'span', value: 'bold', marks: ['strong'] },
          ],
        },
        { type: 'paragraph', children: [{ type: 'span', value: 'Two' }] },
      ]);
      const bad = '⟦B1:p⟧One ⟦M2:strong⟧bold ⟦B3:p⟧Two⟦/B3⟧⟦/M2⟧⟦/B1⟧';
      expect(() => parseMarkupToField(bad, attributes)).toThrow(IntegrityError);
      try {
        parseMarkupToField(bad, attributes);
      } catch (err) {
        const e = err as IntegrityError;
        expect(e.violations).toContainEqual(
          expect.objectContaining({ type: 'misnested-block', ids: ['B3'] }),
        );
        const misnest = e.violations.find((v) => v.type === 'misnested-block');
        // L3: detail should mention mark in the actual-parent description.
        expect(misnest?.detail).toMatch(/mark/);
      }
    });

    it('includes parent context in misnested-block detail (L3)', () => {
      const { attributes } = renderFieldToMarkup([
        { type: 'paragraph', children: [{ type: 'span', value: 'Hello' }] },
        { type: 'paragraph', children: [{ type: 'span', value: 'World' }] },
      ]);
      const badResponse = '⟦B1:p⟧Hi ⟦B2:p⟧nested⟦/B2⟧ trail⟦/B1⟧';
      try {
        parseMarkupToField(badResponse, attributes);
      } catch (err) {
        const e = err as IntegrityError;
        const misnest = e.violations.find((v) => v.type === 'misnested-block');
        expect(misnest?.detail).toBeDefined();
        expect(misnest?.detail).toContain('B2');
        expect(misnest?.detail).toContain('B1');
      }
    });
  });

  describe('code block handling', () => {
    it('discards any model rewrite of code block content (H3)', () => {
      // Model returns altered code; we must keep the original attrs.code.
      const originalCode = 'const answer = 42;\nconsole.log(answer);';
      const { markup, attributes } = renderFieldToMarkup([
        { type: 'code', language: 'javascript', code: originalCode },
      ]);
      expect(markup).toContain(originalCode);
      // Simulate a model that re-translates the code content — we must NOT
      // trust that output.
      const altered = '⟦B1:code⟧const réponse = 42;⟦/B1⟧';
      const { children } = parseMarkupToField(altered, attributes);
      expect(children).toEqual([
        { type: 'code', language: 'javascript', code: originalCode },
      ]);
    });

    it('preserves code exactly when model returns it verbatim', () => {
      const source = [
        {
          type: 'code',
          language: 'typescript',
          code: 'function add(a: number, b: number) { return a + b; }',
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('preserves language and highlight attrs even with truncated model output', () => {
      const source = [
        {
          type: 'code',
          language: 'python',
          highlight: [1, 3, 5],
          code: 'def fn():\n    return 1',
        },
      ];
      const { attributes } = renderFieldToMarkup(source);
      // Model returns a short non-empty rewrite — would have passed empty-block
      // check before the fix and overwritten the original with "hi".
      const badResponse = '⟦B1:code⟧hi⟦/B1⟧';
      const { children } = parseMarkupToField(badResponse, attributes);
      expect(children).toEqual(source);
    });
  });

  describe('instruction text', () => {
    it('describes marker rules concisely', () => {
      const text = markupInstruction();
      expect(text).toContain('marker');
      expect(text).toContain('MUST');
    });
  });

  // A realistic blog-post-style DAST exercising heading, paragraph with
  // bold+link, list with nested paragraphs, blockquote with em, code block,
  // thematic break, inline item, and itemLink — all in one field.
  const COMPLEX_ARTICLE: unknown[] = [
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
      type: 'heading',
      level: 2,
      children: [{ type: 'span', value: 'Topics we cover' }],
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
                { type: 'span', value: 'Frontend development with ' },
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
                { type: 'span', value: ' design' },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'blockquote',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Good design is ' },
            { type: 'span', value: 'obvious', marks: ['emphasis'] },
            { type: 'span', value: ', great design is transparent.' },
          ],
        },
      ],
    },
    {
      type: 'code',
      language: 'javascript',
      code: 'const add = (a, b) => a + b;',
    },
    { type: 'thematicBreak' },
    {
      type: 'paragraph',
      children: [
        { type: 'span', value: 'See also: ' },
        {
          type: 'itemLink',
          item: 'article-123',
          meta: [{ id: 'rel', value: 'next' }],
          children: [{ type: 'span', value: 'Related article' }],
        },
        { type: 'span', value: ' and ' },
        { type: 'inlineItem', item: 'block-456' },
        { type: 'span', value: '.' },
      ],
    },
  ];

  describe('complex realistic DAST', () => {
    it('round trips a realistic article unchanged', () => {
      const { markup, attributes } = renderFieldToMarkup(COMPLEX_ARTICLE);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(COMPLEX_ARTICLE);
    });

    it('never leaks URLs, item references, or heading levels into the markup', () => {
      const { markup } = renderFieldToMarkup(COMPLEX_ARTICLE);
      // URLs
      expect(markup).not.toContain('https://example.com/tech');
      // itemLink record reference
      expect(markup).not.toContain('article-123');
      // inlineItem record reference
      expect(markup).not.toContain('block-456');
      // link meta value
      expect(markup).not.toContain('_blank');
      expect(markup).not.toContain('rel');
      // list style detail (we only expose the `:list` hint, not the bulleted/numbered)
      expect(markup).not.toContain('bulleted');
      // heading `level: 1` attribute is reflected only through the `h1` hint
      expect(markup).toContain(':h1⟧');
      expect(markup).toContain(':h2⟧');
      // code language stays out-of-band
      expect(markup).not.toContain('javascript');
    });

    it('emits every source block id exactly once in the markup', () => {
      const { markup, attributes } = renderFieldToMarkup(COMPLEX_ARTICLE);
      for (const blockId of Object.keys(attributes.blocks)) {
        const opens = markup.match(
          new RegExp(`⟦${blockId}(?::[\\w-]+)?\\/?⟧`, 'g'),
        );
        expect(opens?.length).toBe(1);
      }
    });

    it('applies a simulated translation, preserving all structure', () => {
      const { markup, attributes } = renderFieldToMarkup(COMPLEX_ARTICLE);
      // Simulate a model that translates a few English strings to Italian
      // while leaving every marker and the code block untouched.
      const translated = markup
        .replace('My Article', 'Il Mio Articolo')
        .replace('Welcome to ', 'Benvenuti nel ')
        .replace('my blog', 'mio blog')
        .replace(', where we talk about ', ', dove parliamo di ')
        .replace('technology', 'tecnologia')
        .replace('Topics we cover', 'Argomenti che trattiamo')
        .replace('Frontend development with ', 'Sviluppo frontend con ')
        .replace('Backend ', 'Backend ')
        .replace('systems', 'sistemi')
        .replace(' design', ' progettazione')
        .replace('Good design is ', 'Un buon design è ')
        .replace('obvious', 'ovvio')
        .replace(
          ', great design is transparent.',
          ', un ottimo design è trasparente.',
        )
        .replace('See also: ', 'Vedi anche: ')
        .replace('Related article', 'Articolo correlato')
        .replace(' and ', ' e ');
      const { children } = parseMarkupToField(translated, attributes);
      expect(children).toHaveLength(COMPLEX_ARTICLE.length);

      const heading = children[0] as {
        type: string;
        level: number;
        children: Array<{ value: string }>;
      };
      expect(heading.type).toBe('heading');
      expect(heading.level).toBe(1);
      expect(heading.children[0].value).toBe('Il Mio Articolo');

      // Link in the intro paragraph still has url + meta
      const intro = children[1] as { children: unknown[] };
      const link = intro.children.find(
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
      const list = children[3] as { type: string; style: string };
      expect(list.type).toBe('list');
      expect(list.style).toBe('bulleted');

      // Code block untouched (language + verbatim code)
      const code = children[5] as {
        type: string;
        code: string;
        language: string;
      };
      expect(code.type).toBe('code');
      expect(code.language).toBe('javascript');
      expect(code.code).toBe('const add = (a, b) => a + b;');

      // thematicBreak still there
      const hr = children[6] as { type: string };
      expect(hr.type).toBe('thematicBreak');

      // itemLink + inlineItem references preserved
      const last = children[7] as { children: unknown[] };
      const itemLink = last.children.find(
        (n) => (n as { type?: string }).type === 'itemLink',
      ) as {
        item: string;
        meta: Array<{ id: string; value: string }>;
        children: Array<{ value: string }>;
      };
      expect(itemLink.item).toBe('article-123');
      expect(itemLink.meta).toEqual([{ id: 'rel', value: 'next' }]);
      expect(itemLink.children[0].value).toBe('Articolo correlato');
      const inlineItem = last.children.find(
        (n) => (n as { type?: string }).type === 'inlineItem',
      ) as { item: string };
      expect(inlineItem.item).toBe('block-456');
    });

    it('round trips a link containing a span with multiple marks', () => {
      // Deep combination: a link wrapping a bold + italic span.
      const source = [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'Read ' },
            {
              type: 'link',
              url: 'https://example.com',
              children: [
                {
                  type: 'span',
                  value: 'the full report',
                  marks: ['strong', 'emphasis'],
                },
              ],
            },
            { type: 'span', value: ' today.' },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      expect(markup).not.toContain('example.com');
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips a list whose listItems contain nested paragraphs with links', () => {
      const source = [
        {
          type: 'list',
          style: 'numbered',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [
                    { type: 'span', value: 'Step one: read the ' },
                    {
                      type: 'link',
                      url: 'https://docs.example.com',
                      children: [{ type: 'span', value: 'docs' }],
                    },
                    { type: 'span', value: '.' },
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
                    { type: 'span', value: 'Step ' },
                    { type: 'span', value: 'two', marks: ['strong'] },
                    { type: 'span', value: ': follow the examples.' },
                  ],
                },
              ],
            },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips a code block with language and highlight attributes', () => {
      const source = [
        {
          type: 'code',
          language: 'typescript',
          highlight: [2, 3],
          code: "function add(a: number, b: number) {\n  return a + b;\n}",
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      // Code text IS in the markup (model is instructed to not translate it),
      // but language/highlight are out-of-band.
      expect(markup).toContain('function add');
      expect(markup).not.toContain('typescript');
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips an API-response-wrapped document', () => {
      // When the input arrives wrapped in { document: { children, type: 'root' }, schema: 'dast' }
      // the wrapper is preserved at the translation level (not in this module).
      // This test verifies that the inner children can be rendered/parsed
      // cleanly even for a nested-container-heavy document.
      const source = [
        {
          type: 'blockquote',
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'span', value: 'Nested quote with ' },
                { type: 'span', value: 'emphasis', marks: ['emphasis'] },
                { type: 'span', value: '.' },
              ],
            },
            {
              type: 'paragraph',
              children: [{ type: 'span', value: 'Second line.' }],
            },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('handles a large document (30+ paragraphs) with stable ids and order', () => {
      const source: unknown[] = [];
      for (let i = 0; i < 30; i++) {
        source.push({
          type: 'paragraph',
          children: [
            { type: 'span', value: `Paragraph ${i}, intro. ` },
            { type: 'span', value: `word${i}`, marks: ['strong'] },
            { type: 'span', value: `, trailing.` },
          ],
        });
      }
      const { markup, attributes } = renderFieldToMarkup(source);
      // 30 blocks, each with 1 mark = 60 ids, separated by newlines.
      expect(markup.split('\n')).toHaveLength(30);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('handles empty-paragraph interleaved with content', () => {
      const source = [
        { type: 'paragraph', children: [{ type: 'span', value: 'Before.' }] },
        { type: 'paragraph', children: [{ type: 'span', value: '' }] },
        { type: 'paragraph', children: [{ type: 'span', value: 'After.' }] },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      // The empty middle paragraph should round-trip as an empty span (we
      // canonicalise empty children to a single empty span to keep DAST valid).
      expect(children).toHaveLength(3);
      expect((children[0] as { children: unknown[] }).children).toEqual([
        { type: 'span', value: 'Before.' },
      ]);
      expect((children[2] as { children: unknown[] }).children).toEqual([
        { type: 'span', value: 'After.' },
      ]);
    });

    it('rejects a response that nests a block under the wrong parent', () => {
      // Source has two sibling paragraphs; model returns B2 nested INSIDE B1.
      const { attributes } = renderFieldToMarkup([
        { type: 'paragraph', children: [{ type: 'span', value: 'Hello' }] },
        { type: 'paragraph', children: [{ type: 'span', value: 'World' }] },
      ]);
      const badResponse = '⟦B1:p⟧Hi ⟦B2:p⟧nested⟦/B2⟧ trail⟦/B1⟧';
      expect(() => parseMarkupToField(badResponse, attributes)).toThrow(
        IntegrityError,
      );
      try {
        parseMarkupToField(badResponse, attributes);
      } catch (err) {
        const e = err as IntegrityError;
        expect(e.violations).toContainEqual(
          expect.objectContaining({ type: 'misnested-block', ids: ['B2'] }),
        );
      }
    });

    it('throws empty-block for a code block the model returned empty', () => {
      // H4: code blocks used to be skipped from emptiness checks, which
      // silently hid model-induced truncation of code content.
      const { attributes } = renderFieldToMarkup([
        {
          type: 'code',
          language: 'javascript',
          code: 'const a = 1;',
        },
      ]);
      expect(() => parseMarkupToField('⟦B1:code⟧⟦/B1⟧', attributes)).toThrow(
        IntegrityError,
      );
    });

    it('rejects a mismatched close marker', () => {
      const { attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'a', marks: ['strong'] },
          ],
        },
      ]);
      // Opening M2 but closing as /M3 — wrong id.
      expect(() =>
        parseMarkupToField('⟦B1:p⟧⟦M2:strong⟧a⟦/M3⟧⟦/B1⟧', attributes),
      ).toThrow(IntegrityError);
    });

    it('round trips three-level nested lists', () => {
      const source = [
        {
          type: 'list',
          style: 'bulleted',
          children: [
            {
              type: 'listItem',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'span', value: 'Outer' }],
                },
                {
                  type: 'list',
                  style: 'numbered',
                  children: [
                    {
                      type: 'listItem',
                      children: [
                        {
                          type: 'paragraph',
                          children: [{ type: 'span', value: 'Middle' }],
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
                                    { type: 'span', value: 'Inner' },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips an itemLink whose children carry a strong mark', () => {
      const source = [
        {
          type: 'paragraph',
          children: [
            { type: 'span', value: 'See ' },
            {
              type: 'itemLink',
              item: 'article-99',
              children: [
                {
                  type: 'span',
                  value: 'the referenced article',
                  marks: ['strong'],
                },
              ],
            },
            { type: 'span', value: '.' },
          ],
        },
      ];
      const { markup, attributes } = renderFieldToMarkup(source);
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual(source);
    });

    it('round trips an `unknown` block shape by returning the original verbatim', () => {
      // A hypothetical custom node the renderer does not know about. It is
      // passed through via the attribute store's `original` field.
      const unknownNode = {
        type: 'customNode',
        someProp: 'foo',
        children: [{ type: 'span', value: 'preserved' }],
      };
      const { markup, attributes } = renderFieldToMarkup([unknownNode]);
      // Void marker is emitted; content never hits the model.
      expect(markup).toBe('⟦B1:block/⟧');
      const { children } = parseMarkupToField(markup, attributes);
      expect(children).toEqual([unknownNode]);
    });

    it('discards stray prose before the first block marker', () => {
      // Some models prefix commentary ("Here is the translation:") before the
      // actual markup. We already silently drop anything outside block markers;
      // this test pins that behaviour.
      const { markup, attributes } = renderFieldToMarkup([
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Hello' }],
        },
      ]);
      const withProse = `Here is the translation:\n\n${markup}`;
      const { children } = parseMarkupToField(withProse, attributes);
      expect(children).toEqual([
        {
          type: 'paragraph',
          children: [{ type: 'span', value: 'Hello' }],
        },
      ]);
    });

    it('assigns globally-unique placeholder ids across many leaves with the same token', () => {
      // Ten paragraphs each carrying the same ICU placeholder. The upstream
      // `tokenize` helper uses a per-call counter that would collide across
      // leaves; `phCounter` in RenderState re-numbers them globally.
      const source: unknown[] = [];
      for (let i = 0; i < 10; i++) {
        source.push({
          type: 'paragraph',
          children: [
            { type: 'span', value: `Hello {name}, entry ${i}.` },
          ],
        });
      }
      const { markup, attributes } = renderFieldToMarkup(source);
      // Each leaf got its own unique placeholder id.
      const tokens = markup.match(/⟨PH_\d+⟩/g) ?? [];
      expect(tokens).toHaveLength(10);
      expect(new Set(tokens).size).toBe(10);
      const { children } = parseMarkupToField(markup, attributes);
      // Each paragraph's placeholder is correctly detokenised back.
      expect(
        (children as Array<{ children: Array<{ value: string }> }>).map(
          (p) => p.children[0].value,
        ),
      ).toEqual(
        Array.from(
          { length: 10 },
          (_, i) => `Hello {name}, entry ${i}.`,
        ),
      );
    });
  });
});
