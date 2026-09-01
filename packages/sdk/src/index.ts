export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Readonly<Record<string, unknown>>;

export type Actor = Readonly<{
  type: 'agent' | 'human' | 'system';
  id?: string;
}>;

export type BindingStatus = 'loading' | 'synced' | 'dirty' | 'saving' | 'conflict' | 'offline';

export interface BindingSnapshot<T> {
  readonly data: T;
  readonly revision: string | null;
  readonly status: BindingStatus;
  readonly committed: null | {
    readonly data: T;
    readonly revision: string;
  };
  readonly draft?: {
    readonly data: T;
    readonly baseRevision: string | null;
  };
  readonly conflict?: {
    readonly currentRevision: string;
  };
}

export interface DataCommit<T> {
  readonly data: T;
  readonly revision: string;
  readonly receiptId: string;
}

export interface DataBinding<T> {
  getSnapshot(): BindingSnapshot<T>;
  subscribe(listener: () => void): () => void;
  read(): Promise<{ data: T; revision: string }>;
  update(
    updater: (current: Readonly<T>) => T,
    options?: { reason?: string },
  ): Promise<DataCommit<T>>;
}

export interface DataApi {
  bind<T>(
    path: string,
    options: {
      initial: T | (() => T);
      schema: JsonSchema;
    },
  ): DataBinding<T>;
  bindText(path: string, options: { initial: string | (() => string) }): DataBinding<string>;
}

export interface ToolEffects {
  readonly data: 'none' | 'read' | 'write';
  readonly external?: boolean;
  readonly destructive?: boolean;
}

export interface ToolCallContext {
  readonly callId: string;
  readonly actor: Actor;
  readonly signal: AbortSignal;
  readonly annotation?: { readonly id: string };
}

export interface Registration {
  dispose(): void;
}

export interface ToolDefinition<TInput = JsonValue, TOutput = JsonValue> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly effects: ToolEffects;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly handler: (input: TInput, context: ToolCallContext) => Promise<TOutput> | TOutput;
}

export interface ToolRegistry {
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): Registration;
}

export type TargetInteraction = 'selection' | 'context-menu' | 'hover' | 'capture';

export const domInspectorContract = {
  activeAttribute: 'data-oa-inspector-active',
  maximumAccessibleNameLength: 160,
  maximumItems: 20,
  maximumSelectorLength: 512,
  maximumTextLength: 240,
  provider: 'oa.dom-inspector',
} as const;

export type DomInspectorRect = Readonly<{
  height: number;
  width: number;
  x: number;
  y: number;
}>;

export type DomInspectorRangeBoundary = Readonly<{
  offset: number;
  selector: string;
}>;

export type DomInspectorTextRange = Readonly<{
  end: DomInspectorRangeBoundary;
  start: DomInspectorRangeBoundary;
  textQuote: string;
}>;

export type DomInspectorItem = Readonly<{
  accessibleName?: string;
  rect?: DomInspectorRect;
  role?: string;
  selector: string;
  tagName: string;
  text?: string;
  textRange?: DomInspectorTextRange;
}>;

export type DomInspectorSelection = Readonly<{
  items: readonly DomInspectorItem[];
}>;

export type DomInspectorSelector = Readonly<{
  type: 'DomInspectorSelector';
  version: 1;
  items: ReadonlyArray<
    Readonly<{
      css: string;
      textQuote?: string;
      textRange?: DomInspectorTextRange;
    }>
  >;
}>;

export type DomInspectorContext = Readonly<{
  count: number;
  items: readonly DomInspectorItem[];
}>;

export interface TargetPresentation {
  readonly title: string;
  readonly summary?: string;
  readonly fields?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

export interface TargetDescriptor<TSelector = JsonValue, TContext = JsonValue> {
  readonly selector: TSelector;
  readonly context: TContext;
  readonly presentation: TargetPresentation;
}

export type TargetResolution<TContext = JsonValue> =
  | {
      readonly status: 'resolved';
      readonly context: TContext;
      readonly presentation: TargetPresentation;
    }
  | {
      readonly status: 'ambiguous' | 'orphaned' | 'unsupported';
      readonly reason: string;
    };

export interface TargetProvider<
  TSelection = JsonValue,
  TSelector = JsonValue,
  TContext = JsonValue,
> {
  readonly name: string;
  readonly title: string;
  describe(
    selection: TSelection,
    context: { readonly trigger: TargetInteraction; readonly signal: AbortSignal },
  ): Promise<TargetDescriptor<TSelector, TContext>> | TargetDescriptor<TSelector, TContext>;
  resolve(
    selector: TSelector,
    context: { readonly signal: AbortSignal },
  ): Promise<TargetResolution<TContext>> | TargetResolution<TContext>;
}

export interface AnnotationApi {
  registerTargetProvider<TSelection, TSelector, TContext>(
    provider: TargetProvider<TSelection, TSelector, TContext>,
  ): Registration;
  select<TSelection, TSelector, TContext>(request: {
    provider: string;
    selection: TSelection;
    signal?: AbortSignal;
    trigger: TargetInteraction;
  }): Promise<TargetDescriptor<TSelector, TContext>>;
}

export interface OaSdk {
  readonly data: DataApi;
  readonly tool: ToolRegistry;
  readonly annotation: AnnotationApi;
}

export interface ArtifactActivationContext<TInput> {
  readonly input: Readonly<TInput>;
  readonly oa: OaSdk;
}

export interface ArtifactRenderProps<TInput> {
  readonly input: Readonly<TInput>;
  readonly oa: OaSdk;
}

export type ArtifactActivation<TInput> = (
  context: ArtifactActivationContext<TInput>,
) => void | (() => void) | Promise<void | (() => void)>;
