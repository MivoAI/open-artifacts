import { expect, it } from 'vitest';

import { domInspectorContract, type ArtifactActivationContext } from '../../sdk/src/index.js';
import { createOaTestRuntime } from '../src/testing.js';

interface CounterInput {
  initialValue: number;
}

function activateCounter({ oa, input }: ArtifactActivationContext<CounterInput>) {
  const counter = oa.data.bind('counter.json', {
    initial: { value: input.initialValue },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['value'],
      additionalProperties: false,
      properties: { value: { type: 'integer' } },
    },
  });
  oa.tool.register<{ by: number }, { value: number }>({
    description: 'Increment the counter',
    effects: { data: 'write' },
    inputSchema: {
      type: 'object',
      required: ['by'],
      additionalProperties: false,
      properties: { by: { type: 'integer', minimum: 1 } },
    },
    name: 'counter.increment',
    outputSchema: {
      type: 'object',
      required: ['value'],
      additionalProperties: false,
      properties: { value: { type: 'integer' } },
    },
    title: 'Increment counter',
    handler: async ({ by }, context) => {
      expect(context.actor).toEqual({ type: 'agent', id: 'test-agent' });
      const result = await counter.update((current) => ({ value: current.value + by }));
      return { value: result.data.value };
    },
  });
  oa.annotation.registerTargetProvider<{ field: 'value' }, { field: 'value' }, { value: number }>({
    describe: async (selection) => ({
      context: { value: (await counter.read()).data.value },
      presentation: { title: 'Counter value' },
      selector: selection,
    }),
    name: 'counter.value',
    resolve: async () => ({
      context: { value: (await counter.read()).data.value },
      presentation: { title: 'Counter value' },
      status: 'resolved',
    }),
    title: 'Counter value',
  });
}

it('runs Package tools with implicit SDK mutation context and idempotent dispatch', async () => {
  const runtime = await createOaTestRuntime({ input: { initialValue: 0 } });
  await runtime.activate(activateCounter);
  const changes: string[] = [];
  const unsubscribe = runtime.subscribe((event) => changes.push(event.type));
  await expect(
    runtime.callTool({
      actor: { type: 'agent', id: 'test-agent' },
      idempotencyKey: 'missing-revision',
      input: { by: 1 },
      name: 'counter.increment',
    }),
  ).rejects.toMatchObject({ code: 'TOOL_BASE_REVISION_REQUIRED' });
  const baseRevision = await runtime.data.revision();

  const first = await runtime.callTool({
    actor: { type: 'agent', id: 'test-agent' },
    baseRevision,
    idempotencyKey: 'increment-once',
    input: { by: 2 },
    name: 'counter.increment',
  });
  const replay = await runtime.callTool({
    actor: { type: 'agent', id: 'test-agent' },
    baseRevision,
    idempotencyKey: 'increment-once',
    input: { by: 2 },
    name: 'counter.increment',
  });

  expect(first).toMatchObject({ output: { value: 2 }, status: 'succeeded' });
  expect(replay).toEqual(first);
  await expect(
    runtime.callTool({
      actor: { type: 'agent', id: 'test-agent' },
      baseRevision,
      idempotencyKey: 'stale-tool-call',
      input: { by: 1 },
      name: 'counter.increment',
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(runtime.data.read('counter.json')).resolves.toMatchObject({ data: { value: 2 } });
  expect(changes).toContain('data.changed');
  unsubscribe();
  await runtime.dispose();
});

it('captures immutable Annotation context and resolves against current Data', async () => {
  const runtime = await createOaTestRuntime({ input: { initialValue: 1 } });
  await runtime.activate(activateCounter);

  const annotation = await runtime.createAnnotation({
    actor: { type: 'human', id: 'onee' },
    body: 'Why this value?',
    provider: 'counter.value',
    selection: { field: 'value' },
  });
  await runtime.callTool({
    actor: { type: 'agent', id: 'test-agent' },
    baseRevision: await runtime.data.revision(),
    idempotencyKey: 'increment-after-capture',
    input: { by: 2 },
    name: 'counter.increment',
  });
  const resolution = await runtime.resolveAnnotation(annotation.id);

  expect(annotation.targetSnapshot.context).toEqual({ value: 1 });
  expect(resolution).toMatchObject({ context: { value: 3 }, status: 'resolved' });
  expect(await runtime.listAnnotations()).toHaveLength(1);
  expect(await runtime.getAnnotation(annotation.id)).toEqual(annotation);
  await runtime.dispose();
});

it('captures bounded OA DOM Inspector fallback targets without Package registration', async () => {
  const runtime = await createOaTestRuntime({ input: { initialValue: 1 } });
  await runtime.activate(activateCounter);
  const selection = {
    items: [
      {
        accessibleName: 'Markdown source',
        rect: { height: 28, width: 180, x: 372, y: 116 },
        selector: '#source-title',
        tagName: 'h2',
        text: 'Markdown source',
      },
      {
        accessibleName: 'Markdown source',
        rect: { height: 420, width: 512, x: 372, y: 160 },
        selector: '[aria-label="Markdown source"]',
        tagName: 'textarea',
      },
    ],
  };

  await expect(
    runtime.oa.annotation.select({
      provider: domInspectorContract.provider,
      selection,
      trigger: 'selection',
    }),
  ).resolves.toMatchObject({
    context: {
      count: 2,
      items: [
        { selector: '#source-title', tagName: 'h2', text: 'Markdown source' },
        { selector: '[aria-label="Markdown source"]', tagName: 'textarea' },
      ],
    },
    presentation: {
      title: '2 elements selected',
    },
    selector: {
      items: [
        { css: '#source-title', textQuote: 'Markdown source' },
        { css: '[aria-label="Markdown source"]' },
      ],
      type: 'DomInspectorSelector',
      version: 1,
    },
  });

  await expect(
    runtime.oa.annotation.select({
      provider: domInspectorContract.provider,
      selection: {
        items: [
          {
            selector: '#source-title',
            tagName: 'h2',
            text: 'Markdown',
            textRange: {
              end: { offset: 8, selector: '#source-title' },
              start: { offset: 0, selector: '#source-title' },
              textQuote: 'Markdown',
            },
          },
        ],
      },
      trigger: 'selection',
    }),
  ).resolves.toMatchObject({
    presentation: { title: 'Text selected' },
    selector: {
      items: [
        {
          textRange: {
            end: { offset: 8, selector: '#source-title' },
            start: { offset: 0, selector: '#source-title' },
            textQuote: 'Markdown',
          },
        },
      ],
    },
  });

  const annotation = await runtime.createAnnotation({
    actor: { type: 'human', id: 'onee' },
    body: 'Align these two parts.',
    provider: domInspectorContract.provider,
    selection,
  });
  expect(annotation.target.provider).toBe(domInspectorContract.provider);
  expect(annotation.targetSnapshot.context).toMatchObject({ count: 2 });
  await expect(runtime.resolveAnnotation(annotation.id)).resolves.toEqual({
    reason:
      'DOM Inspector fallback targets require the live Artifact UI; select the target again before acting.',
    status: 'unsupported',
  });

  await expect(
    runtime.oa.annotation.select({
      provider: domInspectorContract.provider,
      selection: { items: Array.from({ length: 21 }, () => selection.items[0]) },
      trigger: 'selection',
    }),
  ).rejects.toMatchObject({ code: 'DOM_INSPECTOR_SELECTION_INVALID' });
  await runtime.dispose();
});

it('validates Tool input before invoking the Package handler', async () => {
  const runtime = await createOaTestRuntime({ input: { initialValue: 0 } });
  await runtime.activate(activateCounter);
  await expect(
    runtime.callTool({
      actor: { type: 'agent' },
      idempotencyKey: 'invalid-input',
      input: { by: 0 },
      name: 'counter.increment',
    }),
  ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  await expect(runtime.data.read('counter.json')).resolves.toMatchObject({ data: { value: 0 } });
  await runtime.dispose();
});

it('persists a failed Tool receipt before a retry can repeat a committed mutation', async () => {
  const runtime = await createOaTestRuntime({ input: { initialValue: 0 } });
  await runtime.activate(({ oa, input }) => {
    const counter = oa.data.bind('counter.json', {
      initial: { value: input.initialValue },
      schema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'integer' } },
      },
    });
    oa.tool.register<Record<string, never>, { value: number }>({
      description: 'Commit once, then return an invalid output',
      effects: { data: 'write' },
      handler: async () => {
        await counter.update((current) => ({ value: current.value + 1 }));
        return { value: 'invalid' } as unknown as { value: number };
      },
      inputSchema: { type: 'object', additionalProperties: false },
      name: 'counter.invalid-output',
      outputSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { type: 'integer' } },
      },
      title: 'Invalid output',
    });
  });
  const request = {
    actor: { type: 'agent' as const },
    baseRevision: await runtime.data.revision(),
    idempotencyKey: 'failed-once',
    input: {},
    name: 'counter.invalid-output',
  };

  await expect(runtime.callTool(request)).rejects.toMatchObject({
    code: 'TOOL_OUTPUT_INVALID',
  });
  await expect(runtime.callTool(request)).rejects.toMatchObject({
    code: 'TOOL_OUTPUT_INVALID',
  });
  await expect(runtime.data.read('counter.json')).resolves.toMatchObject({
    data: { value: 1 },
  });
  await runtime.dispose();
});
