import { expect, it, vi } from 'vitest';

import { createOaBrowserClient } from '../src/index.js';
import { RuntimeError } from '../src/errors.js';

it('keeps instance and revision context inside the Browser SDK binding', async () => {
  let revision = 'r1';
  let data = { value: 1 };
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Response.json({ data, revision });
    }
    if (init?.method === 'PUT') {
      const request = JSON.parse(String(init.body)) as {
        baseRevision: string;
        data: { value: number };
        idempotencyKey: string;
      };
      expect(request.baseRevision).toBe('r1');
      expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      data = request.data;
      revision = 'r2';
      return Response.json({ data, receiptId: 'receipt-1', revision });
    }
    return Response.json({ data, revision });
  });
  const client = createOaBrowserClient({
    baseUrl: 'http://127.0.0.1:43127/',
    fetch,
  });
  const binding = client.data.bind('counter.json', {
    initial: { value: 1 },
    schema: { type: 'object' },
  });

  await expect(binding.read()).resolves.toEqual({ data: { value: 1 }, revision: 'r1' });
  await expect(binding.update((current) => ({ value: current.value + 1 }))).resolves.toEqual({
    data: { value: 2 },
    receiptId: 'receipt-1',
    revision: 'r2',
  });
  expect(fetch).toHaveBeenCalledWith(
    new URL('__oa/data/bind', 'http://127.0.0.1:43127/'),
    expect.objectContaining({ method: 'POST' }),
  );
  client.dispose();
});

it('does not overwrite a conflicted browser draft when an SSE change arrives', async () => {
  let notify:
    ((event: { path: string; revision: string; type: 'data.changed' }) => void) | undefined;
  let getRequests = 0;
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Response.json({ data: { value: 1 }, revision: 'r1' });
    }
    if (init?.method === 'PUT') {
      return Response.json(
        {
          error: {
            code: 'REVISION_CONFLICT',
            message: 'Managed Data revision is stale',
          },
        },
        { status: 400 },
      );
    }
    getRequests += 1;
    return Response.json({ data: { value: 9 }, revision: 'r9' });
  });
  const client = createOaBrowserClient({
    baseUrl: 'http://127.0.0.1:43127/',
    fetch,
    subscribe(listener) {
      notify = listener;
      return () => undefined;
    },
  });
  const binding = client.data.bind('counter.json', {
    initial: { value: 1 },
    schema: { type: 'object' },
  });
  await binding.read();

  await expect(binding.update(() => ({ value: 2 }))).rejects.toBeInstanceOf(RuntimeError);
  expect(binding.getSnapshot()).toMatchObject({
    data: { value: 2 },
    status: 'conflict',
  });
  notify?.({ path: 'counter.json', revision: 'r9', type: 'data.changed' });
  await Promise.resolve();
  expect(getRequests).toBe(1);
  expect(binding.getSnapshot()).toMatchObject({
    data: { value: 2 },
    status: 'conflict',
  });
  client.dispose();
});

it('does not publish a Target when its browser selection is cancelled', async () => {
  let releaseResponse: (response: Response) => void = () => undefined;
  const fetch = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        releaseResponse = resolve;
      }),
  );
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
  const client = createOaBrowserClient({
    baseUrl: 'http://127.0.0.1:43127/',
    fetch,
  });
  const controller = new AbortController();

  try {
    const selection = client.annotation.select({
      provider: 'document.text',
      selection: { end: 10, start: 2 },
      signal: controller.signal,
      trigger: 'capture',
    });
    controller.abort();
    releaseResponse(
      Response.json({
        context: { text: 'selected' },
        presentation: { title: 'Selected text' },
        selector: { end: 10, start: 2 },
      }),
    );

    await expect(selection).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispatchEvent).not.toHaveBeenCalled();
  } finally {
    client.dispose();
    vi.unstubAllGlobals();
  }
});
