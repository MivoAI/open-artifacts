import { describe, expect, it } from 'vitest';

import {
  describeBlockRange,
  parseMarkdownBlocks,
  replaceBlock,
  resolveBlockRange,
} from '../src/model.ts';

describe('parseMarkdownBlocks', () => {
  it('returns exact source positions and stable structural keys for Markdown blocks', () => {
    const markdown = [
      '# Launch',
      '',
      'Opening paragraph.',
      '',
      '## Audience',
      '',
      '- Editors',
      '- Agents',
      '',
      '```ts',
      'const ready = true;',
      '```',
      '',
    ].join('\n');

    expect(
      parseMarkdownBlocks(markdown).map(({ from, kind, structuralKey, text, to }) => ({
        from,
        kind,
        structuralKey,
        text,
        to,
      })),
    ).toEqual([
      {
        from: 0,
        kind: 'heading',
        structuralKey: 'section:0/heading:0',
        text: '# Launch',
        to: 8,
      },
      {
        from: 10,
        kind: 'paragraph',
        structuralKey: 'section:0/paragraph:0',
        text: 'Opening paragraph.',
        to: 28,
      },
      {
        from: 30,
        kind: 'heading',
        structuralKey: 'section:0.0/heading:0',
        text: '## Audience',
        to: 41,
      },
      {
        from: 43,
        kind: 'list',
        structuralKey: 'section:0.0/list:0',
        text: '- Editors\n- Agents',
        to: 61,
      },
      {
        from: 63,
        kind: 'code',
        structuralKey: 'section:0.0/code:0',
        text: '```ts\nconst ready = true;\n```',
        to: 92,
      },
    ]);
  });
});

describe('describeBlockRange', () => {
  it('captures an exact text range with structural, quote, line, and revision evidence', () => {
    const markdown = '# Launch\n\nA precise message for teams.\n';

    expect(
      describeBlockRange(
        markdown,
        {
          from: 12,
          structuralKey: 'section:0/paragraph:0',
          to: 27,
        },
        'r7',
      ),
    ).toMatchObject({
      selector: {
        dataPath: 'document.md',
        position: {
          blockFrom: 10,
          blockTo: 38,
          end: 27,
          start: 12,
        },
        quote: {
          exact: 'precise message',
          prefix: 'A ',
          suffix: ' for teams.',
        },
        structuralKey: 'section:0/paragraph:0',
        type: 'MarkdownBlockRangeSelector',
        version: 1,
      },
      context: {
        captureRevision: 'r7',
        endLine: 3,
        headingPath: ['Launch'],
        selectedText: 'precise message',
        startLine: 3,
      },
      presentation: {
        summary: 'precise message',
        title: 'Paragraph in Launch',
      },
    });
  });
});

describe('replaceBlock', () => {
  it('replaces only the uniquely resolved Markdown block', () => {
    const markdown = '# Launch\n\nFirst block.\n\nSecond block.\n';
    const descriptor = describeBlockRange(
      markdown,
      {
        from: 10,
        structuralKey: 'section:0/paragraph:0',
        to: 22,
      },
      'r1',
    );

    expect(replaceBlock(markdown, descriptor.selector, 'Updated block.')).toEqual({
      markdown: '# Launch\n\nUpdated block.\n\nSecond block.\n',
      replaced: {
        from: 10,
        structuralKey: 'section:0/paragraph:0',
        to: 22,
      },
    });
  });
});

describe('resolveBlockRange', () => {
  it('uses an exact quote to re-anchor when the structural key moved', () => {
    const original = 'Shared phrase.\n';
    const descriptor = describeBlockRange(
      original,
      {
        from: 0,
        structuralKey: 'section:root/paragraph:0',
        to: 14,
      },
      'r1',
    );
    const current = '# Intro\n\nSomething else.\n\n# Message\n\nShared phrase.\n';

    expect(resolveBlockRange(current, descriptor.selector, 'r2')).toMatchObject({
      context: {
        revision: 'r2',
        selectedText: 'Shared phrase.',
      },
      presentation: {
        title: 'Paragraph in Message',
      },
      status: 'resolved',
    });
  });

  it('reports ambiguous, orphaned, and unsupported selectors without fuzzy attachment', () => {
    const original = 'Shared phrase.\n';
    const selector = describeBlockRange(
      original,
      {
        from: 0,
        structuralKey: 'section:root/paragraph:0',
        to: 14,
      },
      'r1',
    ).selector;

    expect(
      resolveBlockRange('# A\n\nShared phrase.\n\n# B\n\nShared phrase.\n', selector, 'r2'),
    ).toEqual({
      reason: 'The exact quote matches more than one Markdown block.',
      status: 'ambiguous',
    });
    expect(resolveBlockRange('# A\n\nDifferent text.\n', selector, 'r2')).toEqual({
      reason: 'The selected Markdown text no longer exists.',
      status: 'orphaned',
    });
    expect(
      resolveBlockRange('# A\n\nShared phrase.\n', { ...selector, version: 2 } as unknown, 'r2'),
    ).toEqual({
      reason: 'The Markdown selector type or version is unsupported.',
      status: 'unsupported',
    });
  });
});
