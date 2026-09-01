import type { ArtifactActivationContext } from '@open-artifacts/sdk';

import { bindDocument } from './contract.ts';
import type { MarkdownEditorInput } from './contract.ts';
import {
  describeBlockRange,
  parseMarkdownBlocks,
  replaceBlock,
  resolveBlockRange,
} from './model.ts';
import type {
  MarkdownBlockRangeSelection,
  MarkdownBlockRangeSelector,
  MarkdownTargetContext,
} from './model.ts';

type ResolvedMarkdownContext = Omit<MarkdownTargetContext, 'captureRevision'> & {
  revision: string;
};
type MarkdownAnnotationContext = MarkdownTargetContext | ResolvedMarkdownContext;

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
} as const;

const selectorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'version', 'dataPath', 'structuralKey', 'position', 'quote', 'digest'],
  properties: {
    type: { const: 'MarkdownBlockRangeSelector' },
    version: { const: 1 },
    dataPath: { const: 'document.md' },
    structuralKey: { type: 'string', minLength: 1 },
    digest: { type: 'string', minLength: 1 },
    position: {
      type: 'object',
      additionalProperties: false,
      required: ['blockFrom', 'blockTo', 'start', 'end'],
      properties: {
        blockFrom: { type: 'integer', minimum: 0 },
        blockTo: { type: 'integer', minimum: 0 },
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
      },
    },
    quote: {
      type: 'object',
      additionalProperties: false,
      required: ['exact', 'prefix', 'suffix'],
      properties: {
        exact: { type: 'string', minLength: 1 },
        prefix: { type: 'string' },
        suffix: { type: 'string' },
      },
    },
  },
} as const;

export function activate({ oa, input }: ArtifactActivationContext<MarkdownEditorInput>) {
  const document = bindDocument(oa, input);
  const targetProvider = oa.annotation.registerTargetProvider<
    MarkdownBlockRangeSelection,
    MarkdownBlockRangeSelector,
    MarkdownAnnotationContext
  >({
    name: 'markdown.block-range',
    title: 'Markdown block text',
    describe: async (selection: MarkdownBlockRangeSelection) => {
      const current = await document.read();
      return describeBlockRange(current.data, selection, current.revision);
    },
    resolve: async (selector: MarkdownBlockRangeSelector) => {
      const current = await document.read();
      return resolveBlockRange(current.data, selector, current.revision);
    },
  });

  const readTool = oa.tool.register<
    Record<string, never>,
    {
      blocks: Array<{
        from: number;
        headingPath: string[];
        kind: string;
        structuralKey: string;
        text: string;
        to: number;
      }>;
      markdown: string;
      revision: string;
    }
  >({
    name: 'document.read',
    title: 'Read Markdown document',
    description: 'Read the current committed Markdown source and its addressable blocks.',
    effects: { data: 'read' },
    inputSchema: emptyObjectSchema,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['markdown', 'revision', 'blocks'],
      properties: {
        markdown: { type: 'string' },
        revision: { type: 'string', minLength: 1 },
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['from', 'to', 'kind', 'structuralKey', 'headingPath', 'text'],
            properties: {
              from: { type: 'integer', minimum: 0 },
              to: { type: 'integer', minimum: 0 },
              kind: { type: 'string' },
              structuralKey: { type: 'string' },
              headingPath: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' },
            },
          },
        },
      },
    },
    handler: async () => {
      const current = await document.read();
      return {
        blocks: parseMarkdownBlocks(current.data),
        markdown: current.data,
        revision: current.revision,
      };
    },
  });

  const replaceTool = oa.tool.register<
    { markdown: string; selector: MarkdownBlockRangeSelector },
    {
      markdown: string;
      replaced: { from: number; structuralKey: string; to: number };
      revision: string;
    }
  >({
    name: 'document.replaceBlock',
    title: 'Replace Markdown block',
    description:
      'Resolve an exact Markdown block-range selector, then replace the containing source block.',
    effects: { data: 'write' },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['selector', 'markdown'],
      properties: {
        selector: selectorSchema,
        markdown: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['markdown', 'replaced', 'revision'],
      properties: {
        markdown: { type: 'string' },
        revision: { type: 'string', minLength: 1 },
        replaced: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to', 'structuralKey'],
          properties: {
            from: { type: 'integer', minimum: 0 },
            to: { type: 'integer', minimum: 0 },
            structuralKey: { type: 'string' },
          },
        },
      },
    },
    handler: async ({ markdown, selector }) => {
      let replacement: ReturnType<typeof replaceBlock> | undefined;
      const commit = await document.update(
        (current: Readonly<string>) => {
          replacement = replaceBlock(current, selector, markdown);
          return replacement.markdown;
        },
        { reason: 'tool.document.replaceBlock' },
      );
      if (!replacement) throw new Error('Markdown replacement did not run');
      return {
        markdown: commit.data,
        replaced: replacement.replaced,
        revision: commit.revision,
      };
    },
  });

  return () => {
    replaceTool.dispose();
    readTool.dispose();
    targetProvider.dispose();
  };
}
