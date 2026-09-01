export type MarkdownBlockKind = 'heading' | 'paragraph' | 'list' | 'quote' | 'code';

export interface MarkdownBlock {
  from: number;
  headingPath: string[];
  kind: MarkdownBlockKind;
  structuralKey: string;
  text: string;
  to: number;
}

export interface MarkdownBlockRangeSelection {
  from: number;
  structuralKey: string;
  to: number;
}

export interface MarkdownBlockRangeSelector {
  dataPath: 'document.md';
  digest: string;
  position: {
    blockFrom: number;
    blockTo: number;
    end: number;
    start: number;
  };
  quote: {
    exact: string;
    prefix: string;
    suffix: string;
  };
  structuralKey: string;
  type: 'MarkdownBlockRangeSelector';
  version: 1;
}

export interface MarkdownTargetContext {
  blockFrom: number;
  blockText: string;
  blockTo: number;
  captureRevision: string;
  endLine: number;
  headingPath: string[];
  kind: MarkdownBlockKind;
  selectedText: string;
  startLine: number;
  structuralKey: string;
}

export interface MarkdownTargetPresentation {
  fields: Array<{ label: string; value: string }>;
  summary: string;
  title: string;
}

export interface MarkdownTargetDescriptor {
  context: MarkdownTargetContext;
  presentation: MarkdownTargetPresentation;
  selector: MarkdownBlockRangeSelector;
}

export type MarkdownTargetResolution =
  | {
      context: Omit<MarkdownTargetContext, 'captureRevision'> & { revision: string };
      presentation: MarkdownTargetPresentation;
      status: 'resolved';
    }
  | {
      reason: string;
      status: 'ambiguous' | 'orphaned' | 'unsupported';
    };

interface SourceLine {
  content: string;
  from: number;
  to: number;
}

function lineNumberAt(markdown: string, offset: number) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (markdown[index] === '\n') line += 1;
  }
  return line;
}

function digestText(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function presentationTitle(block: MarkdownBlock) {
  const kind = `${block.kind.charAt(0).toUpperCase()}${block.kind.slice(1)}`;
  const section = block.headingPath.at(-1);
  return section ? `${kind} in ${section}` : `${kind} at document root`;
}

function presentationFor(
  block: MarkdownBlock,
  selectedText: string,
  startLine: number,
  endLine: number,
  revision: string,
): MarkdownTargetPresentation {
  return {
    fields: [
      { label: 'Data', value: 'document.md' },
      { label: 'Block', value: block.structuralKey },
      { label: 'Lines', value: startLine === endLine ? `${startLine}` : `${startLine}–${endLine}` },
      { label: 'Revision', value: revision },
    ],
    summary: selectedText,
    title: presentationTitle(block),
  };
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;

  while (from < markdown.length) {
    const newline = markdown.indexOf('\n', from);
    const to = newline === -1 ? markdown.length : newline;
    lines.push({
      content: markdown.slice(from, to).replace(/\r$/, ''),
      from,
      to,
    });
    if (newline === -1) break;
    from = newline + 1;
  }

  return lines;
}

function isHeading(line: string) {
  return /^(#{1,6})\s+\S/.test(line);
}

function isFence(line: string) {
  return /^\s*(```|~~~)/.test(line);
}

function isListItem(line: string) {
  return /^\s*(?:[-+*]|\d+[.)])\s+\S/.test(line);
}

function isQuote(line: string) {
  return /^\s*>\s?/.test(line);
}

function startsSpecialBlock(line: string) {
  return isHeading(line) || isFence(line) || isListItem(line) || isQuote(line);
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = sourceLines(markdown);
  const blocks: MarkdownBlock[] = [];
  const headingPath: string[] = [];
  const sectionPath: number[] = [];
  const headingSiblingCounts = new Map<string, number>();
  const blockCounts = new Map<string, number>();

  function appendBlock(
    kind: MarkdownBlockKind,
    fromLine: number,
    throughLine: number,
    options: { headingDepth?: number; headingTitle?: string } = {},
  ) {
    if (options.headingDepth !== undefined && options.headingTitle !== undefined) {
      const depth = options.headingDepth;
      const parentSection = sectionPath.slice(0, depth - 1);
      const siblingKey = `${parentSection.join('.') || 'root'}|h${depth}`;
      const siblingIndex = headingSiblingCounts.get(siblingKey) ?? 0;
      headingSiblingCounts.set(siblingKey, siblingIndex + 1);
      sectionPath.splice(depth - 1, sectionPath.length, siblingIndex);
      headingPath.splice(depth - 1, headingPath.length, options.headingTitle);
    }

    const sectionKey = sectionPath.length > 0 ? sectionPath.join('.') : 'root';
    const countKey = `${sectionKey}|${kind}`;
    const ordinal = kind === 'heading' ? 0 : (blockCounts.get(countKey) ?? 0);
    blockCounts.set(countKey, ordinal + 1);
    const from = lines[fromLine]?.from ?? 0;
    const to = lines[throughLine]?.to ?? from;

    blocks.push({
      from,
      headingPath: [...headingPath],
      kind,
      structuralKey: `section:${sectionKey}/${kind}:${ordinal}`,
      text: markdown.slice(from, to),
      to,
    });
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.content.trim() === '') {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.content);
    if (heading) {
      appendBlock('heading', index, index, {
        headingDepth: heading[1]?.length ?? 1,
        headingTitle: heading[2] ?? '',
      });
      index += 1;
      continue;
    }

    const fence = /^\s*(```|~~~)/.exec(line.content)?.[1];
    if (fence) {
      let end = index + 1;
      while (end < lines.length && !new RegExp(`^\\s*${fence}`).test(lines[end]?.content ?? '')) {
        end += 1;
      }
      appendBlock('code', index, Math.min(end, lines.length - 1));
      index = Math.min(end + 1, lines.length);
      continue;
    }

    if (isListItem(line.content)) {
      let end = index;
      while (end + 1 < lines.length && isListItem(lines[end + 1]?.content ?? '')) end += 1;
      appendBlock('list', index, end);
      index = end + 1;
      continue;
    }

    if (isQuote(line.content)) {
      let end = index;
      while (end + 1 < lines.length && isQuote(lines[end + 1]?.content ?? '')) end += 1;
      appendBlock('quote', index, end);
      index = end + 1;
      continue;
    }

    let end = index;
    while (
      end + 1 < lines.length &&
      lines[end + 1]?.content.trim() !== '' &&
      !startsSpecialBlock(lines[end + 1]?.content ?? '')
    ) {
      end += 1;
    }
    appendBlock('paragraph', index, end);
    index = end + 1;
  }

  return blocks;
}

export function describeBlockRange(
  markdown: string,
  selection: MarkdownBlockRangeSelection,
  revision: string,
): MarkdownTargetDescriptor {
  const block = parseMarkdownBlocks(markdown).find(
    ({ structuralKey }) => structuralKey === selection.structuralKey,
  );
  if (!block) throw new Error(`Markdown block is unavailable: ${selection.structuralKey}`);
  if (
    !Number.isInteger(selection.from) ||
    !Number.isInteger(selection.to) ||
    selection.from < block.from ||
    selection.to > block.to ||
    selection.from >= selection.to
  ) {
    throw new Error('Markdown selection must be a non-empty range inside its block');
  }

  const selectedText = markdown.slice(selection.from, selection.to);
  const startLine = lineNumberAt(markdown, selection.from);
  const endLine = lineNumberAt(markdown, Math.max(selection.from, selection.to - 1));
  const selector: MarkdownBlockRangeSelector = {
    dataPath: 'document.md',
    digest: digestText(selectedText),
    position: {
      blockFrom: block.from,
      blockTo: block.to,
      end: selection.to,
      start: selection.from,
    },
    quote: {
      exact: selectedText,
      prefix: markdown.slice(Math.max(block.from, selection.from - 32), selection.from),
      suffix: markdown.slice(selection.to, Math.min(block.to, selection.to + 32)),
    },
    structuralKey: block.structuralKey,
    type: 'MarkdownBlockRangeSelector',
    version: 1,
  };

  return {
    context: {
      blockFrom: block.from,
      blockText: block.text,
      blockTo: block.to,
      captureRevision: revision,
      endLine,
      headingPath: block.headingPath,
      kind: block.kind,
      selectedText,
      startLine,
      structuralKey: block.structuralKey,
    },
    presentation: presentationFor(block, selectedText, startLine, endLine, revision),
    selector,
  };
}

function isMarkdownBlockRangeSelector(value: unknown): value is MarkdownBlockRangeSelector {
  if (!value || typeof value !== 'object') return false;
  const selector = value as Partial<MarkdownBlockRangeSelector>;
  return (
    selector.type === 'MarkdownBlockRangeSelector' &&
    selector.version === 1 &&
    selector.dataPath === 'document.md' &&
    typeof selector.structuralKey === 'string' &&
    typeof selector.digest === 'string' &&
    !!selector.position &&
    Number.isInteger(selector.position.start) &&
    Number.isInteger(selector.position.end) &&
    Number.isInteger(selector.position.blockFrom) &&
    Number.isInteger(selector.position.blockTo) &&
    !!selector.quote &&
    typeof selector.quote.exact === 'string' &&
    selector.quote.exact.length > 0 &&
    typeof selector.quote.prefix === 'string' &&
    typeof selector.quote.suffix === 'string'
  );
}

function occurrencesInBlock(block: MarkdownBlock, exact: string) {
  const occurrences: number[] = [];
  let from = 0;
  while (from <= block.text.length - exact.length) {
    const index = block.text.indexOf(exact, from);
    if (index === -1) break;
    occurrences.push(block.from + index);
    from = index + Math.max(1, exact.length);
  }
  return occurrences;
}

function resolvedTarget(
  markdown: string,
  block: MarkdownBlock,
  start: number,
  selector: MarkdownBlockRangeSelector,
  revision: string,
): MarkdownTargetResolution {
  const end = start + selector.quote.exact.length;
  const startLine = lineNumberAt(markdown, start);
  const endLine = lineNumberAt(markdown, Math.max(start, end - 1));
  const context = {
    blockFrom: block.from,
    blockText: block.text,
    blockTo: block.to,
    endLine,
    headingPath: block.headingPath,
    kind: block.kind,
    revision,
    selectedText: selector.quote.exact,
    startLine,
    structuralKey: block.structuralKey,
  };
  return {
    context,
    presentation: presentationFor(block, selector.quote.exact, startLine, endLine, revision),
    status: 'resolved',
  };
}

export function resolveBlockRange(
  markdown: string,
  candidate: unknown,
  revision: string,
): MarkdownTargetResolution {
  if (!isMarkdownBlockRangeSelector(candidate)) {
    return {
      reason: 'The Markdown selector type or version is unsupported.',
      status: 'unsupported',
    };
  }

  const selector = candidate;
  const blocks = parseMarkdownBlocks(markdown);
  const structuralBlock = blocks.find(
    ({ structuralKey }) => structuralKey === selector.structuralKey,
  );

  if (structuralBlock) {
    const relativeStart = selector.position.start - selector.position.blockFrom;
    const expectedStart = structuralBlock.from + relativeStart;
    if (
      expectedStart >= structuralBlock.from &&
      expectedStart + selector.quote.exact.length <= structuralBlock.to &&
      markdown.slice(expectedStart, expectedStart + selector.quote.exact.length) ===
        selector.quote.exact
    ) {
      return resolvedTarget(markdown, structuralBlock, expectedStart, selector, revision);
    }
  }

  const matches = blocks.flatMap((block) =>
    occurrencesInBlock(block, selector.quote.exact).map((start) => ({ block, start })),
  );
  if (matches.length === 1 && matches[0]) {
    return resolvedTarget(markdown, matches[0].block, matches[0].start, selector, revision);
  }
  if (matches.length > 1) {
    return {
      reason: 'The exact quote matches more than one Markdown block.',
      status: 'ambiguous',
    };
  }
  return {
    reason: 'The selected Markdown text no longer exists.',
    status: 'orphaned',
  };
}

export function replaceBlock(
  markdown: string,
  selector: MarkdownBlockRangeSelector,
  replacement: string,
) {
  const resolution = resolveBlockRange(markdown, selector, 'current');
  if (resolution.status !== 'resolved') {
    throw new Error(`${resolution.status}: ${resolution.reason}`);
  }

  const { blockFrom: from, blockTo: to, structuralKey } = resolution.context;
  return {
    markdown: `${markdown.slice(0, from)}${replacement}${markdown.slice(to)}`,
    replaced: {
      from,
      structuralKey,
      to,
    },
  };
}
