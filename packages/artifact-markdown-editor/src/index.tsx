import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import type { ArtifactRenderProps, DataBinding, OaSdk } from '@open-artifacts/sdk';
import { useAnnotationTarget, useDataBinding } from '@open-artifacts/sdk/react';
import type { AnnotationActionAnchor } from '@open-artifacts/sdk/react';

import { bindDocument } from './contract.ts';
import type { MarkdownEditorInput } from './contract.ts';
import { parseMarkdownBlocks } from './model.ts';
import type {
  MarkdownBlock,
  MarkdownBlockRangeSelection,
  MarkdownBlockRangeSelector,
  MarkdownTargetContext,
} from './model.ts';
import './styles.css';

type ResolvedMarkdownContext = Omit<MarkdownTargetContext, 'captureRevision'> & {
  revision: string;
};
type MarkdownAnnotationContext = MarkdownTargetContext | ResolvedMarkdownContext;

interface EditorSurfaceProps {
  binding?: DataBinding<string>;
  committed: string;
  revision: string | null;
  status: string;
  title: string;
}

interface TextSelectionCandidate {
  anchor: AnnotationActionAnchor;
  focusAction: boolean;
  origin: HTMLElement;
  selection: MarkdownBlockRangeSelection;
}

function textOffsetWithin(container: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

function actionAnchor(
  rect: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>,
) {
  const horizontalInset = Math.min(96, window.innerWidth / 2);
  const left = Math.max(
    horizontalInset,
    Math.min(window.innerWidth - horizontalInset, rect.left + rect.width / 2),
  );
  const placement = rect.top >= 64 ? 'above' : 'below';
  return {
    left,
    placement,
    top: placement === 'above' ? rect.top - 10 : rect.bottom + 10,
  } as const;
}

function selectedRange(event: MouseEvent<HTMLElement>, block: MarkdownBlock) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  const container = event.currentTarget;
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return undefined;
  }
  const start = textOffsetWithin(container, range.startContainer, range.startOffset);
  const end = textOffsetWithin(container, range.endContainer, range.endOffset);
  if (start === end) return undefined;
  const clientRects = range.getClientRects();
  const rect =
    clientRects.item(clientRects.length - 1) ??
    range.getBoundingClientRect() ??
    container.getBoundingClientRect();
  return {
    anchor: actionAnchor(
      rect.width === 0 && rect.height === 0 ? container.getBoundingClientRect() : rect,
    ),
    focusAction: false,
    origin: container,
    selection: {
      from: block.from + Math.min(start, end),
      structuralKey: block.structuralKey,
      to: block.from + Math.max(start, end),
    },
  };
}

function PreviewBlock({
  block,
  children,
  onSelectionCandidate,
}: {
  block: MarkdownBlock;
  children?: ReactNode;
  onSelectionCandidate?: (candidate: TextSelectionCandidate) => void;
}) {
  function selectWholeBlock(event: KeyboardEvent<HTMLElement>) {
    if (!onSelectionCandidate || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onSelectionCandidate({
      anchor: actionAnchor(event.currentTarget.getBoundingClientRect()),
      focusAction: true,
      origin: event.currentTarget,
      selection: {
        from: block.from,
        structuralKey: block.structuralKey,
        to: block.to,
      },
    });
  }

  return (
    <article
      className={`md-block md-block-${block.kind}`}
      data-structural-key={block.structuralKey}
      onKeyDown={selectWholeBlock}
      onMouseUp={(event) => {
        const candidate = selectedRange(event, block);
        if (candidate && onSelectionCandidate) onSelectionCandidate(candidate);
      }}
      tabIndex={onSelectionCandidate ? 0 : undefined}
    >
      <pre>{children ?? block.text}</pre>
    </article>
  );
}

function RuntimePreviewBlock({
  block,
  ensureCommitted,
  oa,
}: {
  block: MarkdownBlock;
  ensureCommitted(): Promise<void>;
  oa: OaSdk;
}) {
  const target = useAnnotationTarget<
    MarkdownBlockRangeSelection,
    MarkdownBlockRangeSelector,
    MarkdownAnnotationContext
  >({
    oa,
    provider: 'markdown.block-range',
    selection: {
      from: block.from,
      structuralKey: block.structuralKey,
      to: block.to,
    },
  });

  return (
    <div {...target.props} onMouseEnter={undefined}>
      <PreviewBlock
        block={block}
        onSelectionCandidate={(candidate) =>
          target.requestAnnotation({
            anchor: candidate.anchor,
            beforeCapture: async (signal) => {
              signal.throwIfAborted();
              await ensureCommitted();
              signal.throwIfAborted();
            },
            focusOnShow: candidate.focusAction,
            focusOrigin: candidate.origin,
            selection: candidate.selection,
          })
        }
      />
    </div>
  );
}

function EditorSurface({
  binding,
  committed,
  revision,
  status,
  title,
  oa,
}: EditorSurfaceProps & { oa?: OaSdk }) {
  const [draft, setDraft] = useState(committed);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const previousCommitted = useRef(committed);

  useEffect(() => {
    setDraft((current) => (current === previousCommitted.current ? committed : current));
    previousCommitted.current = committed;
  }, [committed]);

  const blocks = useMemo(() => parseMarkdownBlocks(draft), [draft]);
  const dirty = draft !== committed;

  const save = useCallback(async () => {
    if (!binding || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await binding.update(() => draft, { reason: 'human.document.save' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save Markdown');
      throw caught;
    } finally {
      setSaving(false);
    }
  }, [binding, dirty, draft]);

  return (
    <main className="md-artifact">
      <header className="md-header">
        <div>
          <span>Source-first Markdown</span>
          <h1>{title}</h1>
        </div>
        <div className="md-runtime-state" aria-live="polite">
          <strong>{saving ? 'Saving' : dirty ? 'Local draft' : status}</strong>
          <code>{revision ?? 'initializing'}</code>
        </div>
      </header>

      <section className="md-workspace">
        <section className="md-pane" aria-labelledby="source-title">
          <div className="md-pane-heading">
            <div>
              <span>01</span>
              <h2 id="source-title">Markdown source</h2>
            </div>
            <button
              disabled={!binding || !dirty || saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <textarea
            aria-label="Markdown source"
            onChange={(event) => setDraft(event.currentTarget.value)}
            spellCheck={false}
            value={draft}
          />
          <footer className={error ? 'is-error' : ''}>
            <span>{error ?? (dirty ? 'Unsaved local draft' : 'Committed source')}</span>
            <code>{new Blob([draft]).size} bytes</code>
          </footer>
        </section>

        <section className="md-pane md-preview-pane" aria-labelledby="preview-title">
          <div className="md-pane-heading">
            <div>
              <span>02</span>
              <h2 id="preview-title">Block preview</h2>
            </div>
            <small>Drag-select text to annotate</small>
          </div>
          <div className="md-preview">
            {blocks.map((block) =>
              oa && binding ? (
                <RuntimePreviewBlock
                  block={block}
                  ensureCommitted={save}
                  key={block.structuralKey}
                  oa={oa}
                />
              ) : (
                <PreviewBlock block={block} key={block.structuralKey} />
              ),
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function RuntimeMarkdownEditor({ input, oa }: ArtifactRenderProps<MarkdownEditorInput>) {
  const binding = useMemo(() => bindDocument(oa, input), [input, oa]);
  const snapshot = useDataBinding(binding);
  if (snapshot.status === 'loading') {
    return (
      <main aria-busy="true" className="md-artifact md-loading" data-testid="markdown-loading">
        Loading Instance Data…
      </main>
    );
  }
  return (
    <EditorSurface
      binding={binding}
      committed={snapshot.data}
      oa={oa}
      revision={snapshot.revision}
      status={snapshot.status}
      title={input.title}
    />
  );
}

function FallbackMarkdownEditor({ data }: { data: MarkdownEditorInput }) {
  return (
    <EditorSurface
      committed={data.markdown}
      revision={null}
      status="catalog preview"
      title={data.title}
    />
  );
}

export default function MarkdownEditor(
  props: ArtifactRenderProps<MarkdownEditorInput> | { data: MarkdownEditorInput },
) {
  return 'oa' in props ? (
    <RuntimeMarkdownEditor {...props} />
  ) : (
    <FallbackMarkdownEditor {...props} />
  );
}
