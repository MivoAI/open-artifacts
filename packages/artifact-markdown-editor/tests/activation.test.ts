import { describe, expect, it } from 'vitest';

import type { ArtifactActivation } from '@open-artifacts/sdk';

import { createOaTestRuntime } from '../../runtime/src/testing.ts';

import { activate } from '../src/activate.ts';

describe('Markdown Editor activation', () => {
  it('registers read/replace tools and converges the document binding after replacement', async () => {
    const input = {
      markdown: '# Note\n\nOriginal block.\n',
      title: 'Agent note',
    };
    const runtime = await createOaTestRuntime({ input });

    try {
      await runtime.activate(activate as ArtifactActivation<typeof input>, input);
      expect(runtime.listTools().map(({ name }: { name: string }) => name)).toEqual([
        'document.read',
        'document.replaceBlock',
      ]);

      const annotation = await runtime.createAnnotation({
        actor: { id: 'onee', type: 'human' },
        body: 'Rewrite this block.',
        provider: 'markdown.block-range',
        selection: {
          from: 8,
          structuralKey: 'section:0/paragraph:0',
          to: 23,
        },
      });
      expect(annotation.targetSnapshot.context).toMatchObject({
        captureRevision: expect.stringMatching(/^[0-9a-f]{40,64}$/),
        selectedText: 'Original block.',
        startLine: 3,
      });

      const document = runtime.oa.data.bindText('document.md', {
        initial: input.markdown,
      });
      const observed: string[] = [];
      const unsubscribe = document.subscribe(() => observed.push(document.getSnapshot().data));

      const result = await runtime.callTool({
        actor: { id: 'agent-1', type: 'agent' },
        baseRevision: await runtime.data.revision(),
        idempotencyKey: 'replace-original-block',
        input: {
          markdown: 'Updated by the Agent.',
          selector: annotation.target.selector,
        },
        name: 'document.replaceBlock',
      });

      expect(result).toMatchObject({
        output: {
          markdown: '# Note\n\nUpdated by the Agent.\n',
          replaced: {
            structuralKey: 'section:0/paragraph:0',
          },
        },
        status: 'succeeded',
      });
      await expect(runtime.data.read('document.md')).resolves.toMatchObject({
        data: '# Note\n\nUpdated by the Agent.\n',
      });
      expect(document.getSnapshot()).toMatchObject({
        data: '# Note\n\nUpdated by the Agent.\n',
        status: 'synced',
      });
      expect(observed).toContain('# Note\n\nUpdated by the Agent.\n');
      unsubscribe();
    } finally {
      await runtime.dispose();
    }
  });
});
