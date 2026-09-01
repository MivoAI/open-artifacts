import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import type {
  AnnotationApi,
  BindingSnapshot,
  DataBinding,
  OaSdk,
  TargetDescriptor,
} from '../src/index.js';
import {
  annotationActionEvent,
  type AnnotationActionCandidate,
  useAnnotationTarget,
  useDataBinding,
} from '../src/react.js';

const snapshot: BindingSnapshot<{ value: number }> = {
  committed: { data: { value: 2 }, revision: 'abc123' },
  data: { value: 2 },
  revision: 'abc123',
  status: 'synced',
};

it('renders the current Data Binding snapshot through the public hook', () => {
  const binding: DataBinding<{ value: number }> = {
    getSnapshot: () => snapshot,
    read: async () => ({ data: { value: 2 }, revision: 'abc123' }),
    subscribe: () => () => undefined,
    update: async () => ({ data: { value: 3 }, receiptId: 'receipt-1', revision: 'def456' }),
  };

  function View() {
    const current = useDataBinding(binding);
    return createElement('span', null, `${current.data.value}@${current.revision}`);
  }

  expect(renderToStaticMarkup(createElement(View))).toBe('<span>2@abc123</span>');
});

it('returns target props and selects a text-range override through AnnotationApi', async () => {
  const descriptor: TargetDescriptor<{ start: number; end: number }, { text: string }> = {
    context: { text: 'selected' },
    presentation: { title: 'Selected text' },
    selector: { start: 2, end: 10 },
  };
  const select = vi.fn(async () => descriptor);
  const annotation = {
    registerTargetProvider: vi.fn(),
    select,
  } as unknown as AnnotationApi;
  const oa = { annotation } as OaSdk;
  let hook:
    | ReturnType<
        typeof useAnnotationTarget<
          { start: number; end: number },
          { start: number; end: number },
          { text: string }
        >
      >
    | undefined;

  function Target() {
    hook = useAnnotationTarget({
      oa,
      provider: 'document.text',
      selection: { start: 0, end: 1 },
    });
    return createElement('span', hook.props, 'Selected text');
  }

  expect(renderToStaticMarkup(createElement(Target))).toContain(
    'data-oa-target-provider="document.text"',
  );
  await expect(hook!.select({ start: 2, end: 10 }, 'selection')).resolves.toEqual(descriptor);
  expect(select).toHaveBeenCalledWith({
    provider: 'document.text',
    selection: { start: 2, end: 10 },
    trigger: 'selection',
  });

  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  hook!.props.onClickCapture?.({
    currentTarget: {
      ownerDocument: {
        documentElement: {
          hasAttribute: (name: string) => name === 'data-oa-inspector-active',
        },
      },
    },
    preventDefault,
    stopPropagation,
  } as never);
  await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
  expect(select).toHaveBeenLastCalledWith({
    provider: 'document.text',
    selection: { start: 0, end: 1 },
    trigger: 'selection',
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(stopPropagation).toHaveBeenCalledOnce();
});

it('offers a Workbench-owned Annotation action and cancels a stale capture', async () => {
  const select = vi.fn(async () => ({
    context: { text: 'selected' },
    presentation: { title: 'Selected text' },
    selector: { start: 2, end: 10 },
  }));
  const annotation = {
    registerTargetProvider: vi.fn(),
    select,
  } as unknown as AnnotationApi;
  const oa = { annotation } as OaSdk;
  const dispatchEvent = vi.fn();
  vi.stubGlobal('dispatchEvent', dispatchEvent);
  vi.stubGlobal(
    'CustomEvent',
    class<T> {
      readonly detail: T | null;
      readonly type: string;

      constructor(type: string, init?: CustomEventInit<T>) {
        this.detail = init?.detail ?? null;
        this.type = type;
      }
    },
  );
  let hook:
    | ReturnType<
        typeof useAnnotationTarget<
          { start: number; end: number },
          { start: number; end: number },
          { text: string }
        >
      >
    | undefined;

  function Target() {
    hook = useAnnotationTarget({
      oa,
      provider: 'document.text',
      selection: { start: 0, end: 1 },
    });
    return createElement('span', hook.props, 'Selected text');
  }

  renderToStaticMarkup(createElement(Target));
  const focusOrigin = { focus: vi.fn() } as unknown as HTMLElement;
  const beforeCapture = vi.fn(async (signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
  });
  hook!.requestAnnotation({
    anchor: { left: 120, placement: 'above', top: 80 },
    beforeCapture,
    focusOrigin,
    selection: { start: 2, end: 10 },
  });
  expect(dispatchEvent).toHaveBeenCalledOnce();
  expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ type: annotationActionEvent });
  const candidate = (dispatchEvent.mock.calls[0]?.[0] as { detail: AnnotationActionCandidate })
    .detail;
  await candidate.capture(new AbortController().signal);
  expect(beforeCapture).toHaveBeenCalledOnce();
  expect(beforeCapture).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(select).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'document.text',
      selection: { start: 2, end: 10 },
      signal: expect.any(AbortSignal),
      trigger: 'capture',
    }),
  );

  let releaseCapture: () => void = () => undefined;
  const slowCapture = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        expect(signal.aborted).toBe(false);
        releaseCapture = resolve;
      }),
  );
  hook!.requestAnnotation({
    anchor: { left: 180, placement: 'below', top: 40 },
    beforeCapture: slowCapture,
    focusOrigin,
    selection: { start: 12, end: 18 },
  });
  const staleCandidate = (dispatchEvent.mock.calls[1]?.[0] as { detail: AnnotationActionCandidate })
    .detail;
  const controller = new AbortController();
  const capturing = staleCandidate.capture(controller.signal);
  controller.abort();
  releaseCapture();
  await capturing;
  expect(select).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
