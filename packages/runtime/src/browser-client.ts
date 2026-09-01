import type {
  AnnotationApi,
  BindingSnapshot,
  DataApi,
  DataBinding,
  DataCommit,
  JsonSchema,
  OaSdk,
  Registration,
  TargetDescriptor,
  TargetInteraction,
  ToolRegistry,
} from '@open-artifacts/sdk';

import { RuntimeError } from './errors.js';
import type { RuntimeEvent } from './instance-runtime.js';
import { stableJson } from './stable-json.js';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function responseJson<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok) {
    throw new RuntimeError(
      value.error?.code ?? 'RUNTIME_REQUEST_FAILED',
      value.error?.message ?? `Runtime request failed with ${response.status}`,
      value.error?.details,
    );
  }
  return value;
}

class BrowserBinding<T> implements DataBinding<T> {
  readonly #baseUrl: URL;
  readonly #fetch: Fetch;
  readonly #path: string;
  readonly #listeners = new Set<() => void>();
  readonly #ready: Promise<void>;
  #snapshot: BindingSnapshot<T>;

  constructor(options: {
    baseUrl: URL;
    fetch: Fetch;
    initial: T | (() => T);
    path: string;
    schema: JsonSchema;
    kind: 'json' | 'text';
  }) {
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetch;
    this.#path = options.path;
    const initial =
      typeof options.initial === 'function' ? (options.initial as () => T)() : options.initial;
    this.#snapshot = {
      committed: null,
      data: initial,
      revision: null,
      status: 'loading',
    };
    this.#ready = this.#request<{ data: T; revision: string }>('__oa/data/bind', {
      body: JSON.stringify({
        initial,
        kind: options.kind,
        path: options.path,
        schema: options.schema,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }).then((snapshot) => {
      this.#set({
        committed: snapshot,
        data: snapshot.data,
        revision: snapshot.revision,
        status: 'synced',
      });
    });
  }

  getSnapshot() {
    return this.#snapshot;
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async read() {
    await this.#ready;
    const url = new URL('__oa/data', this.#baseUrl);
    url.searchParams.set('path', this.#path);
    const snapshot = await responseJson<{ data: T; revision: string }>(await this.#fetch(url));
    this.#set({
      committed: snapshot,
      data: snapshot.data,
      revision: snapshot.revision,
      status: 'synced',
    });
    return snapshot;
  }

  async update(
    updater: (current: Readonly<T>) => T,
    options?: { reason?: string },
  ): Promise<DataCommit<T>> {
    await this.#ready;
    const current = this.#snapshot.committed;
    if (!current) throw new RuntimeError('DATA_NOT_READY', `Data is not ready: ${this.#path}`);
    const data = updater(current.data);
    this.#set({
      committed: current,
      data,
      draft: { baseRevision: current.revision, data },
      revision: current.revision,
      status: 'saving',
    });
    const url = new URL('__oa/data', this.#baseUrl);
    url.searchParams.set('path', this.#path);
    try {
      const commit = await responseJson<DataCommit<T>>(
        await this.#fetch(url, {
          body: JSON.stringify({
            baseRevision: current.revision,
            data,
            idempotencyKey: globalThis.crypto.randomUUID(),
            ...(options?.reason === undefined ? {} : { reason: options.reason }),
          }),
          headers: { 'content-type': 'application/json' },
          method: 'PUT',
        }),
      );
      this.#set({
        committed: { data: commit.data, revision: commit.revision },
        data: commit.data,
        revision: commit.revision,
        status: 'synced',
      });
      return commit;
    } catch (error) {
      this.#set({
        committed: current,
        data,
        draft: { baseRevision: current.revision, data },
        revision: current.revision,
        status:
          error instanceof RuntimeError && error.code === 'REVISION_CONFLICT'
            ? 'conflict'
            : 'dirty',
      });
      throw error;
    }
  }

  async refresh() {
    if (
      this.#snapshot.status === 'saving' ||
      this.#snapshot.status === 'dirty' ||
      this.#snapshot.status === 'conflict'
    )
      return;
    await this.read();
  }

  #set(snapshot: BindingSnapshot<T>) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  async #request<TResult>(path: string, init?: RequestInit) {
    return responseJson<TResult>(await this.#fetch(new URL(path, this.#baseUrl), init));
  }
}

class BrowserDataApi implements DataApi {
  readonly #baseUrl: URL;
  readonly #fetch: Fetch;
  readonly #bindings = new Map<string, { contract: string; binding: BrowserBinding<unknown> }>();

  constructor(baseUrl: URL, fetch: Fetch) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetch;
  }

  bind<T>(path: string, options: { initial: T | (() => T); schema: JsonSchema }): DataBinding<T> {
    return this.#bind<T>(path, options.initial, options.schema, 'json');
  }

  bindText(path: string, options: { initial: string | (() => string) }) {
    return this.#bind(path, options.initial, { type: 'string' }, 'text');
  }

  refresh(path: string) {
    return this.#bindings.get(path)?.binding.refresh();
  }

  #bind<T>(path: string, initial: T | (() => T), schema: JsonSchema, kind: 'json' | 'text') {
    const contract = stableJson({ kind, schema });
    const existing = this.#bindings.get(path);
    if (existing) {
      if (existing.contract !== contract) {
        throw new RuntimeError(
          'DATA_BINDING_CONFLICT',
          `Data path ${path} is already bound with another contract`,
        );
      }
      return existing.binding as BrowserBinding<T>;
    }
    const binding = new BrowserBinding({
      baseUrl: this.#baseUrl,
      fetch: this.#fetch,
      initial,
      kind,
      path,
      schema,
    });
    this.#bindings.set(path, {
      binding: binding as unknown as BrowserBinding<unknown>,
      contract,
    });
    return binding;
  }
}

class BrowserAnnotationApi implements AnnotationApi {
  readonly #baseUrl: URL;
  readonly #fetch: Fetch;

  constructor(baseUrl: URL, fetch: Fetch) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetch;
  }

  registerTargetProvider(): Registration {
    throw new RuntimeError(
      'SERVER_ACTIVATION_REQUIRED',
      'Target Providers must be registered during server-side activate',
    );
  }

  async select<TSelection, TSelector, TContext>(request: {
    provider: string;
    selection: TSelection;
    signal?: AbortSignal;
    trigger: TargetInteraction;
  }): Promise<TargetDescriptor<TSelector, TContext>> {
    const descriptor = await responseJson<TargetDescriptor<TSelector, TContext>>(
      await this.#fetch(new URL('__oa/targets/select', this.#baseUrl), {
        body: JSON.stringify({
          provider: request.provider,
          selection: request.selection,
          trigger: request.trigger,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    );
    request.signal?.throwIfAborted();
    if (
      typeof globalThis.dispatchEvent === 'function' &&
      typeof globalThis.CustomEvent === 'function'
    ) {
      globalThis.dispatchEvent(
        new CustomEvent('oa:target-selected', {
          detail: {
            descriptor,
            provider: request.provider,
            selection: request.selection,
          },
        }),
      );
    }
    return descriptor;
  }
}

class BrowserToolRegistry implements ToolRegistry {
  register(): Registration {
    throw new RuntimeError(
      'SERVER_ACTIVATION_REQUIRED',
      'Tools must be registered during server-side activate',
    );
  }
}

export interface OaBrowserClient extends OaSdk {
  dispose(): void;
}

export function createOaBrowserClient(options: {
  baseUrl: string | URL;
  fetch?: Fetch;
  subscribe?: (listener: (event: RuntimeEvent) => void) => () => void;
}): OaBrowserClient {
  const baseUrl = new URL(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  const data = new BrowserDataApi(baseUrl, fetchImplementation);
  const unsubscribe = options.subscribe?.((event) => {
    if (event.type === 'data.changed') void data.refresh(event.path);
  });
  return {
    annotation: new BrowserAnnotationApi(baseUrl, fetchImplementation),
    data,
    dispose: () => unsubscribe?.(),
    tool: new BrowserToolRegistry(),
  };
}
