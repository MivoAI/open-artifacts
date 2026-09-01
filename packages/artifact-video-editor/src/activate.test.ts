import type {
  AnnotationApi,
  BindingSnapshot,
  DataBinding,
  OaSdk,
  TargetDescriptor,
  TargetProvider,
  TargetResolution,
  ToolDefinition,
} from '@open-artifacts/sdk';
import { describe, expect, it } from 'vitest';

import exampleInput from '../example.json';
import { activate, bindVideoProject } from './activate.ts';
import type {
  TimelineReadOutput,
  TimelineTrimInput,
  TimelineTrimOutput,
  VideoClipRangeContext,
  VideoClipRangeSelection,
  VideoClipRangeSelector,
  VideoEditorInput,
} from './model.ts';

describe('Video Editor activation', () => {
  it('exposes timeline read and trim through the Artifact Tool seam', async () => {
    const runtime = createActivationRuntime();
    const input = exampleInput as VideoEditorInput;
    const dispose = await activate({
      oa: runtime.oa,
      input,
    });
    const uiBinding = bindVideoProject(runtime.oa, input);

    expect(runtime.listTools()).toEqual(['timeline.read', 'timeline.trim']);
    const before = await runtime.callTool<Record<string, never>, TimelineReadOutput>(
      'timeline.read',
      {},
    );
    expect(before.timeline.tracks[0]?.clips[0]?.sourceRange).toEqual({
      sourceStartUs: 0,
      sourceEndUs: 1_466_667,
    });

    const trimmed = await runtime.callTool<TimelineTrimInput, TimelineTrimOutput>('timeline.trim', {
      clipId: 'opening-clip',
      sourceStartUs: 200_000,
      sourceEndUs: 1_200_000,
    });
    expect(trimmed).toMatchObject({
      clipId: 'opening-clip',
      removedDurationUs: 466_667,
    });

    const after = await runtime.callTool<Record<string, never>, TimelineReadOutput>(
      'timeline.read',
      {},
    );
    expect(after.timeline.tracks[0]?.clips[0]?.sourceRange).toEqual({
      sourceStartUs: 200_000,
      sourceEndUs: 1_200_000,
    });
    expect(uiBinding.getSnapshot().data.timeline.tracks[0]?.clips[0]?.sourceRange).toEqual({
      sourceStartUs: 200_000,
      sourceEndUs: 1_200_000,
    });

    dispose?.();
    expect(runtime.listTools()).toEqual([]);
  });

  it('registers a video time range Target Provider backed by current Instance Data', async () => {
    const runtime = createActivationRuntime();
    await activate({
      oa: runtime.oa,
      input: exampleInput as VideoEditorInput,
    });

    const target = await runtime.capture<
      VideoClipRangeSelection,
      VideoClipRangeSelector,
      VideoClipRangeContext
    >('video.clip-range', {
      clipId: 'opening-clip',
      sourceStartUs: 200_000,
      sourceEndUs: 500_000,
    });
    await runtime.callTool<TimelineTrimInput, TimelineTrimOutput>('timeline.trim', {
      clipId: 'opening-clip',
      sourceStartUs: 300_000,
      sourceEndUs: 1_200_000,
    });

    expect(target.context).toMatchObject({
      clipId: 'opening-clip',
      sourceStartUs: 200_000,
      sourceEndUs: 500_000,
    });
    expect(await runtime.resolve('video.clip-range', target.selector)).toEqual({
      status: 'orphaned',
      reason: 'The selected source range is no longer present in the current clip.',
    });
  });
});

function createActivationRuntime() {
  const bindings = new Map<string, DataBinding<unknown>>();
  const tools = new Map<string, ToolDefinition<unknown, unknown>>();
  const providers = new Map<string, TargetProvider<unknown, unknown, unknown>>();

  const annotation: AnnotationApi = {
    registerTargetProvider(provider) {
      providers.set(provider.name, provider as TargetProvider<unknown, unknown, unknown>);
      return {
        dispose() {
          providers.delete(provider.name);
        },
      };
    },
    async select(request) {
      const provider = providers.get(request.provider);
      if (!provider) throw new Error(`Unknown Target Provider: ${request.provider}`);
      return provider.describe(request.selection, {
        signal: new AbortController().signal,
        trigger: request.trigger,
      }) as Promise<TargetDescriptor<never, never>>;
    },
  };

  const oa: OaSdk = {
    annotation,
    data: {
      bind<T>(path: string, options: { initial: T | (() => T) }) {
        const existing = bindings.get(path);
        if (existing) return existing as DataBinding<T>;

        let revision = 1;
        let snapshot: BindingSnapshot<T> = syncedSnapshot(
          typeof options.initial === 'function'
            ? (options.initial as () => T)()
            : structuredClone(options.initial),
          revision,
        );
        const listeners = new Set<() => void>();
        const binding: DataBinding<T> = {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async read() {
            return {
              data: structuredClone(snapshot.data),
              revision: `r${revision}`,
            };
          },
          async update(updater) {
            revision += 1;
            const data = updater(structuredClone(snapshot.data));
            snapshot = syncedSnapshot(data, revision);
            listeners.forEach((listener) => listener());
            return {
              data,
              receiptId: `receipt-${revision}`,
              revision: `r${revision}`,
            };
          },
        };
        bindings.set(path, binding as DataBinding<unknown>);
        return binding;
      },
      bindText() {
        throw new Error('bindText is outside this activation seam');
      },
    },
    tool: {
      register(definition) {
        tools.set(definition.name, definition as ToolDefinition<unknown, unknown>);
        return {
          dispose() {
            tools.delete(definition.name);
          },
        };
      },
    },
  };

  return {
    oa,
    listTools: () => [...tools.keys()].sort(),
    async callTool<TInput, TOutput>(name: string, input: TInput) {
      const definition = tools.get(name);
      if (!definition) throw new Error(`Unknown Artifact Tool: ${name}`);
      return definition.handler(input, {
        actor: { type: 'agent' },
        callId: 'call-test',
        signal: new AbortController().signal,
      }) as Promise<TOutput>;
    },
    async capture<TSelection, TSelector, TContext>(providerName: string, selection: TSelection) {
      return annotation.select<TSelection, TSelector, TContext>({
        provider: providerName,
        selection,
        trigger: 'capture',
      });
    },
    async resolve<TSelector, TContext>(
      providerName: string,
      selector: TSelector,
    ): Promise<TargetResolution<TContext>> {
      const provider = providers.get(providerName);
      if (!provider) throw new Error(`Unknown Target Provider: ${providerName}`);
      return provider.resolve(selector, {
        signal: new AbortController().signal,
      }) as Promise<TargetResolution<TContext>>;
    },
  };
}

function syncedSnapshot<T>(data: T, revision: number): BindingSnapshot<T> {
  return {
    committed: {
      data,
      revision: `r${revision}`,
    },
    data,
    revision: `r${revision}`,
    status: 'synced',
  };
}
