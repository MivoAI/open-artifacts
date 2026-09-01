import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type {
  Actor,
  AnnotationApi,
  ArtifactActivation,
  BindingSnapshot,
  DataApi,
  DataBinding,
  DataCommit,
  JsonSchema,
  JsonValue,
  OaSdk,
  Registration,
  TargetDescriptor,
  TargetInteraction,
  TargetProvider,
  TargetResolution,
  ToolCallContext,
  ToolDefinition,
  ToolRegistry,
} from '@open-artifacts/sdk';

import { AnnotationStore } from './annotation-store.js';
import type { AnnotationRecord } from './annotation-store.js';
import {
  artifactRuntimeFormat,
  readInstanceBundle,
  setInstanceState,
  type InstanceBundle,
} from './bundle.js';
import { GitDataAuthority } from './data-authority.js';
import type { DataChangedEvent } from './data-authority.js';
import { createDomInspectorTargetProvider } from './dom-inspector.js';
import { RuntimeError } from './errors.js';
import { readJson, writeJsonAtomically } from './fs.js';
import { validateSchema } from './schema.js';
import { stableJson } from './stable-json.js';

interface Invocation {
  actor: Actor;
  baseRevision?: string;
  idempotencyKey: string;
  mutationIndex: number;
  writeAllowed: boolean;
}

export type RuntimeEvent =
  | DataChangedEvent
  | { readonly type: 'annotation.created'; readonly annotationId: string }
  | { readonly type: 'tool.called'; readonly callId: string; readonly name: string };

export interface ToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly effects: ToolDefinition['effects'];
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
}

export interface ToolCallResult<TOutput extends JsonValue = JsonValue> {
  readonly callId: string;
  readonly status: 'succeeded';
  readonly revision?: string;
  readonly output: TOutput;
}

interface StoredToolCallError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

interface ToolCallAudit {
  readonly actor: Actor;
  readonly annotationId?: string;
  readonly baseRevision?: string;
  readonly input: JsonValue;
  readonly name: string;
  readonly startedAt: string;
}

type StoredToolCall =
  | {
      readonly audit: ToolCallAudit;
      readonly requestHash: string;
      readonly status: 'running';
      readonly callId: string;
    }
  | {
      readonly audit: ToolCallAudit;
      readonly requestHash: string;
      readonly status: 'failed';
      readonly callId: string;
      readonly error: StoredToolCallError;
      readonly revision: string;
    }
  | {
      readonly audit: ToolCallAudit;
      readonly requestHash: string;
      readonly status: 'succeeded';
      readonly result: ToolCallResult;
    }
  | {
      // v0.1 compatibility for Tool Call receipts written before status was persisted.
      readonly requestHash: string;
      readonly result: ToolCallResult;
    };

interface ToolCallFile {
  calls: Record<string, StoredToolCall>;
}

class RuntimeToolRegistry implements ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<unknown, unknown>>();
  #disposed = false;

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): Registration {
    if (this.#disposed) throw new RuntimeError('INSTANCE_STOPPED', 'Runtime is stopped');
    if (this.#tools.has(definition.name)) {
      throw new RuntimeError(
        'TOOL_ALREADY_REGISTERED',
        `Tool is already registered: ${definition.name}`,
      );
    }
    this.#tools.set(definition.name, definition as ToolDefinition<unknown, unknown>);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        this.#tools.delete(definition.name);
      },
    };
  }

  get(name: string) {
    return this.#tools.get(name);
  }

  list(): ToolDescriptor[] {
    return [...this.#tools.values()]
      .map((definition) => ({
        description: definition.description,
        effects: definition.effects,
        inputSchema: definition.inputSchema,
        name: definition.name,
        outputSchema: definition.outputSchema,
        title: definition.title,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  dispose() {
    this.#disposed = true;
    this.#tools.clear();
  }
}

class TargetProviderRegistry implements AnnotationApi {
  readonly #providers = new Map<string, TargetProvider<unknown, unknown, unknown>>();
  #disposed = false;

  registerTargetProvider<TSelection, TSelector, TContext>(
    provider: TargetProvider<TSelection, TSelector, TContext>,
  ): Registration {
    if (this.#disposed) throw new RuntimeError('INSTANCE_STOPPED', 'Runtime is stopped');
    if (this.#providers.has(provider.name)) {
      throw new RuntimeError(
        'TARGET_PROVIDER_ALREADY_REGISTERED',
        `Target Provider is already registered: ${provider.name}`,
      );
    }
    this.#providers.set(provider.name, provider as TargetProvider<unknown, unknown, unknown>);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        this.#providers.delete(provider.name);
      },
    };
  }

  async select<TSelection, TSelector, TContext>(request: {
    provider: string;
    selection: TSelection;
    signal?: AbortSignal;
    trigger: TargetInteraction;
  }): Promise<TargetDescriptor<TSelector, TContext>> {
    const provider = this.#providers.get(request.provider);
    if (!provider) {
      throw new RuntimeError(
        'TARGET_PROVIDER_NOT_FOUND',
        `Unknown Target Provider: ${request.provider}`,
      );
    }
    return provider.describe(request.selection, {
      signal: request.signal ?? new AbortController().signal,
      trigger: request.trigger,
    }) as Promise<TargetDescriptor<TSelector, TContext>>;
  }

  async resolve<TContext extends JsonValue>(
    providerName: string,
    selector: JsonValue,
  ): Promise<TargetResolution<TContext>> {
    const provider = this.#providers.get(providerName);
    if (!provider) {
      return {
        reason: `Unknown Target Provider: ${providerName}`,
        status: 'unsupported',
      };
    }
    return provider.resolve(selector, {
      signal: new AbortController().signal,
    }) as Promise<TargetResolution<TContext>>;
  }

  dispose() {
    this.#disposed = true;
    this.#providers.clear();
  }
}

class RuntimeDataBinding<T> implements DataBinding<T> {
  readonly #authority: GitDataAuthority;
  readonly #path: string;
  readonly #context: () => Invocation | undefined;
  readonly #defaultActor: Actor;
  readonly #listeners = new Set<() => void>();
  readonly #ready: Promise<void>;
  #snapshot: BindingSnapshot<T>;
  #unsubscribe: () => void;

  constructor(options: {
    authority: GitDataAuthority;
    context: () => Invocation | undefined;
    defaultActor: Actor;
    initial: T | (() => T);
    path: string;
    schema?: JsonSchema;
    text: boolean;
  }) {
    this.#authority = options.authority;
    this.#path = options.path;
    this.#context = options.context;
    this.#defaultActor = options.defaultActor;
    const initial =
      typeof options.initial === 'function' ? (options.initial as () => T)() : options.initial;
    this.#snapshot = {
      committed: null,
      data: initial,
      revision: null,
      status: 'loading',
    };
    this.#unsubscribe = this.#authority.subscribe((event) => {
      if (event.path === this.#path) void this.#refresh();
    });
    const bind: Promise<{ data: T; revision: string }> = options.text
      ? this.#authority
          .bindText({ initial: initial as string, path: options.path })
          .then((snapshot) => ({ data: snapshot.data as T, revision: snapshot.revision }))
      : this.#authority.bind<T>({
          initial,
          path: options.path,
          schema: options.schema ?? {},
        });
    this.#ready = bind.then((snapshot) => {
      this.#setSnapshot({
        committed: snapshot,
        data: snapshot.data as T,
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

  ready() {
    return this.#ready;
  }

  async read() {
    await this.#ready;
    return this.#authority.read<T>(this.#path);
  }

  async update(
    updater: (current: Readonly<T>) => T,
    options?: { reason?: string },
  ): Promise<DataCommit<T>> {
    await this.#ready;
    const invocation = this.#context();
    if (invocation && !invocation.writeAllowed) {
      throw new RuntimeError(
        'TOOL_EFFECT_VIOLATION',
        'A read-only Tool attempted to mutate Instance Data',
      );
    }
    const current = invocation
      ? await this.#authority.read<T>(this.#path)
      : (this.#snapshot.committed ?? (await this.#authority.read<T>(this.#path)));
    const data = updater(current.data);
    this.#setSnapshot({
      committed: current,
      data,
      draft: { baseRevision: current.revision, data },
      revision: current.revision,
      status: 'saving',
    });
    try {
      const commit = await this.#authority.commit({
        actor: invocation?.actor ?? this.#defaultActor,
        baseRevision: invocation?.baseRevision ?? current.revision,
        data,
        idempotencyKey: invocation
          ? `${invocation.idempotencyKey}:data:${invocation.mutationIndex++}`
          : randomUUID(),
        path: this.#path,
        ...(options?.reason === undefined ? {} : { reason: options.reason }),
      });
      this.#setSnapshot({
        committed: { data: commit.data, revision: commit.revision },
        data: commit.data,
        revision: commit.revision,
        status: 'synced',
      });
      if (invocation) invocation.baseRevision = commit.revision;
      return commit;
    } catch (error) {
      const currentRevision = await this.#authority.revision();
      this.#setSnapshot({
        committed: current,
        conflict: { currentRevision },
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

  dispose() {
    this.#unsubscribe();
    this.#listeners.clear();
  }

  async #refresh() {
    await this.#ready;
    const snapshot = await this.#authority.read<T>(this.#path);
    if (
      this.#snapshot.status === 'saving' ||
      this.#snapshot.status === 'dirty' ||
      this.#snapshot.status === 'conflict'
    )
      return;
    this.#setSnapshot({
      committed: snapshot,
      data: snapshot.data,
      revision: snapshot.revision,
      status: 'synced',
    });
  }

  #setSnapshot(snapshot: BindingSnapshot<T>) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

class RuntimeDataApi implements DataApi {
  readonly #bindings = new Map<
    string,
    { binding: RuntimeDataBinding<unknown>; contract: string }
  >();
  readonly #authority: GitDataAuthority;
  readonly #context: () => Invocation | undefined;
  readonly #defaultActor: Actor;

  constructor(
    authority: GitDataAuthority,
    context: () => Invocation | undefined,
    defaultActor: Actor,
  ) {
    this.#authority = authority;
    this.#context = context;
    this.#defaultActor = defaultActor;
  }

  bind<T>(path: string, options: { initial: T | (() => T); schema: JsonSchema }): DataBinding<T> {
    return this.#binding(path, options.initial, options.schema, false);
  }

  bindText(path: string, options: { initial: string | (() => string) }): DataBinding<string> {
    return this.#binding(path, options.initial, { type: 'string' }, true);
  }

  dispose() {
    for (const { binding } of this.#bindings.values()) binding.dispose();
    this.#bindings.clear();
  }

  async ready() {
    await Promise.all([...this.#bindings.values()].map(({ binding }) => binding.ready()));
  }

  #binding<T>(path: string, initial: T | (() => T), schema: JsonSchema, text: boolean) {
    const contract = stableJson({ schema, text });
    const existing = this.#bindings.get(path);
    if (existing) {
      if (existing.contract !== contract) {
        throw new RuntimeError(
          'DATA_BINDING_CONFLICT',
          `Data path ${path} is already bound with another contract`,
        );
      }
      return existing.binding as RuntimeDataBinding<T>;
    }
    const binding = new RuntimeDataBinding({
      authority: this.#authority,
      context: this.#context,
      defaultActor: this.#defaultActor,
      initial,
      path,
      schema,
      text,
    });
    this.#bindings.set(path, {
      binding: binding as unknown as RuntimeDataBinding<unknown>,
      contract,
    });
    return binding;
  }
}

export class InstanceRuntime<TInput = JsonValue> {
  readonly bundle: InstanceBundle<TInput>;
  readonly instanceId: string;
  readonly data: GitDataAuthority;
  readonly oa: OaSdk;
  readonly #annotations: AnnotationStore;
  readonly #dataApi: RuntimeDataApi;
  readonly #tools = new RuntimeToolRegistry();
  readonly #targets = new TargetProviderRegistry();
  readonly #invocation = new AsyncLocalStorage<Invocation>();
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #cleanup: (() => Promise<void>) | undefined;
  #activationDisposer?: () => void;
  #activated = false;
  #disposed = false;
  #toolTail: Promise<unknown> = Promise.resolve();

  constructor(
    bundle: InstanceBundle<TInput>,
    options: { defaultActor?: Actor; cleanup?: () => Promise<void> } = {},
  ) {
    if (bundle.packageBinding.format !== artifactRuntimeFormat) {
      throw new RuntimeError(
        'ARTIFACT_RUNTIME_FORMAT_UNSUPPORTED',
        `Instance Runtime requires ${artifactRuntimeFormat}; received ${bundle.packageBinding.format}`,
      );
    }
    this.bundle = bundle;
    this.instanceId = bundle.instance.instanceId;
    this.data = new GitDataAuthority(bundle);
    this.#annotations = new AnnotationStore(bundle);
    this.#targets.registerTargetProvider(createDomInspectorTargetProvider());
    const defaultActor = options.defaultActor ?? { type: 'human' };
    this.#dataApi = new RuntimeDataApi(this.data, () => this.#invocation.getStore(), defaultActor);
    this.oa = {
      annotation: this.#targets,
      data: this.#dataApi,
      tool: this.#tools,
    };
    this.#cleanup = options.cleanup;
    this.data.subscribe((event) => this.#emit(event));
  }

  async activate(activation: ArtifactActivation<TInput>, input: TInput = this.bundle.input) {
    this.#assertActive();
    if (this.#activated) {
      throw new RuntimeError('INSTANCE_ALREADY_ACTIVE', 'Package is already activated');
    }
    this.#activated = true;
    try {
      const disposer = await activation({ input, oa: this.oa });
      await this.#dataApi.ready();
      if (disposer) this.#activationDisposer = disposer;
    } catch (error) {
      this.#activated = false;
      throw error;
    }
  }

  listTools() {
    this.#assertActive();
    return this.#tools.list();
  }

  callTool<TOutput extends JsonValue = JsonValue>(request: {
    name: string;
    input: JsonValue;
    actor: Actor;
    baseRevision?: string;
    idempotencyKey: string;
    annotationId?: string;
  }): Promise<ToolCallResult<TOutput>> {
    return this.#serializeTool(() => this.#dispatchTool<TOutput>(request));
  }

  async #dispatchTool<TOutput extends JsonValue = JsonValue>(request: {
    name: string;
    input: JsonValue;
    actor: Actor;
    baseRevision?: string;
    idempotencyKey: string;
    annotationId?: string;
  }): Promise<ToolCallResult<TOutput>> {
    this.#assertActive();
    const callsPath = join(this.bundle.path, 'tool-calls.json');
    const calls = await readJson<ToolCallFile>(callsPath);
    const requestHash = createHash('sha256')
      .update(
        stableJson({
          actor: request.actor,
          ...(request.baseRevision === undefined ? {} : { baseRevision: request.baseRevision }),
          input: request.input,
          name: request.name,
          ...(request.annotationId === undefined ? {} : { annotationId: request.annotationId }),
        }),
      )
      .digest('hex');
    const replay = calls.calls[request.idempotencyKey];
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new RuntimeError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was already used for another Tool Call',
        );
      }
      if ('result' in replay) return replay.result as ToolCallResult<TOutput>;
      if (replay.status === 'failed') {
        throw new RuntimeError(replay.error.code, replay.error.message, replay.error.details);
      }
      throw new RuntimeError(
        'TOOL_CALL_INCOMPLETE',
        `Tool Call ${replay.callId} did not reach a durable result; use a new idempotency key only after reviewing Instance Data`,
        { callId: replay.callId },
      );
    }
    const definition = this.#tools.get(request.name);
    if (!definition) throw new RuntimeError('TOOL_NOT_FOUND', `Unknown Tool: ${request.name}`);
    validateSchema(definition.inputSchema, request.input, 'TOOL_INPUT_INVALID');
    const currentRevision = await this.data.revision();
    if (definition.effects.data === 'write') {
      if (!request.baseRevision) {
        throw new RuntimeError(
          'TOOL_BASE_REVISION_REQUIRED',
          'A write Tool Call requires the Data revision observed by the caller',
          { currentRevision },
        );
      }
      if (request.baseRevision !== currentRevision) {
        throw new RuntimeError('REVISION_CONFLICT', 'Tool Call Data revision is stale', {
          currentRevision,
        });
      }
    }
    const callId = randomUUID();
    const audit: ToolCallAudit = {
      actor: request.actor,
      ...(request.annotationId === undefined ? {} : { annotationId: request.annotationId }),
      ...(request.baseRevision === undefined ? {} : { baseRevision: request.baseRevision }),
      input: request.input,
      name: request.name,
      startedAt: new Date().toISOString(),
    };
    calls.calls[request.idempotencyKey] = {
      audit,
      callId,
      requestHash,
      status: 'running',
    };
    await writeJsonAtomically(callsPath, calls);
    const controller = new AbortController();
    const context: ToolCallContext = {
      actor: request.actor,
      callId,
      signal: controller.signal,
      ...(request.annotationId === undefined ? {} : { annotation: { id: request.annotationId } }),
    };
    try {
      const output = await this.#invocation.run(
        {
          actor: request.actor,
          ...(request.baseRevision === undefined ? {} : { baseRevision: request.baseRevision }),
          idempotencyKey: request.idempotencyKey,
          mutationIndex: 0,
          writeAllowed: definition.effects.data === 'write',
        },
        () => definition.handler(request.input, context),
      );
      validateSchema(definition.outputSchema, output, 'TOOL_OUTPUT_INVALID');
      const result: ToolCallResult<TOutput> = {
        callId,
        output: output as TOutput,
        revision: await this.data.revision(),
        status: 'succeeded',
      };
      calls.calls[request.idempotencyKey] = {
        audit,
        requestHash,
        result,
        status: 'succeeded',
      };
      await writeJsonAtomically(callsPath, calls);
      this.#emit({ callId, name: request.name, type: 'tool.called' });
      return result;
    } catch (error) {
      const runtimeError =
        error instanceof RuntimeError
          ? error
          : new RuntimeError(
              'TOOL_HANDLER_FAILED',
              error instanceof Error ? error.message : String(error),
            );
      calls.calls[request.idempotencyKey] = {
        audit,
        callId,
        error: {
          code: runtimeError.code,
          message: runtimeError.message,
          ...(runtimeError.details === undefined ? {} : { details: runtimeError.details }),
        },
        requestHash,
        revision: await this.data.revision(),
        status: 'failed',
      };
      await writeJsonAtomically(callsPath, calls);
      throw runtimeError;
    }
  }

  async createAnnotation(request: {
    body: string;
    provider: string;
    selection: JsonValue;
    actor: Actor;
  }) {
    this.#assertActive();
    const descriptor = await this.#targets.select<JsonValue, JsonValue, JsonValue>({
      provider: request.provider,
      selection: request.selection,
      trigger: 'capture',
    });
    const annotation = await this.#annotations.create({
      actor: request.actor,
      body: request.body,
      target: {
        provider: request.provider,
        selector: descriptor.selector,
      },
      targetSnapshot: {
        context: descriptor.context,
        dataRevision: await this.data.revision(),
        presentation: descriptor.presentation,
      },
    });
    this.#emit({ annotationId: annotation.id, type: 'annotation.created' });
    return annotation;
  }

  listAnnotations() {
    return this.#annotations.list();
  }

  getAnnotation(id: string) {
    return this.#annotations.get(id);
  }

  resolveAnnotation<TContext extends JsonValue = JsonValue>(id: string) {
    return this.#annotations.resolve<TContext>(id, (annotation) =>
      this.#targets.resolve<TContext>(annotation.target.provider, annotation.target.selector),
    );
  }

  subscribe(listener: (event: RuntimeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activationDisposer?.();
    this.#dataApi.dispose();
    this.#tools.dispose();
    this.#targets.dispose();
    this.#listeners.clear();
    if (this.bundle.instance.state === 'active') {
      await setInstanceState(this.bundle, 'stopped');
    }
    await this.#cleanup?.();
  }

  #assertActive() {
    if (this.#disposed) throw new RuntimeError('INSTANCE_STOPPED', 'Runtime is stopped');
  }

  #emit(event: RuntimeEvent) {
    for (const listener of this.#listeners) listener(event);
  }

  #serializeTool<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#toolTail.then(operation, operation);
    this.#toolTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function createInstanceRuntime<TInput = JsonValue>(options: {
  bundle?: InstanceBundle<TInput>;
  bundlePath?: string;
  defaultActor?: Actor;
}): Promise<InstanceRuntime<TInput>> {
  const bundle =
    options.bundle ??
    (options.bundlePath ? await readInstanceBundle(options.bundlePath) : undefined);
  if (!bundle) {
    throw new RuntimeError(
      'INSTANCE_BUNDLE_REQUIRED',
      'createInstanceRuntime requires bundle or bundlePath',
    );
  }
  if (bundle.packageBinding.format !== artifactRuntimeFormat) {
    throw new RuntimeError(
      'ARTIFACT_RUNTIME_FORMAT_UNSUPPORTED',
      `Instance Runtime requires ${artifactRuntimeFormat}; received ${bundle.packageBinding.format}`,
    );
  }
  return new InstanceRuntime<TInput>(bundle as InstanceBundle<TInput>, {
    ...(options.defaultActor === undefined ? {} : { defaultActor: options.defaultActor }),
  });
}

export type { AnnotationRecord };
