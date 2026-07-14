// PROTOTYPE: three render structures for one Artifact Document, switchable via ?variant=.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import { PrototypeSwitcher } from './components.tsx';
import { isVariantKey, parseArtifactPackage, VARIANTS } from './model.ts';
import type {
  ArtifactAnnotation,
  ArtifactDocument,
  ArtifactPackage,
  ArtifactSelection,
  VariantKey,
} from './model.ts';
import { samplePackage } from './sample-document.ts';
import { AtlasVariant, BriefVariant, TraceVariant } from './variants.tsx';

const initialSource = JSON.stringify(samplePackage, null, 2);

function variantFromLocation(): VariantKey {
  const candidate = new URLSearchParams(window.location.search).get('variant');
  return isVariantKey(candidate) ? candidate : 'atlas';
}

function selectionFromElement(element: HTMLElement): ArtifactSelection | null {
  const path = element.dataset.artifactPath;
  if (!path) return null;

  return {
    path,
    label: element.dataset.artifactLabel ?? path,
    quote: element.innerText.replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

function ArtifactRenderer({
  variant,
  document,
}: {
  variant: VariantKey;
  document: ArtifactDocument;
}) {
  if (variant === 'brief') return <BriefVariant document={document} />;
  if (variant === 'trace') return <TraceVariant document={document} />;
  return <AtlasVariant document={document} />;
}

export function PrototypeApp() {
  const [source, setSource] = useState(initialSource);
  const [artifactPackage, setArtifactPackage] = useState<ArtifactPackage>(samplePackage);
  const [parseError, setParseError] = useState<string | null>(null);
  const [variant, setVariant] = useState<VariantKey>(variantFromLocation);
  const [selection, setSelection] = useState<ArtifactSelection | null>(null);
  const [note, setNote] = useState('');
  const [annotations, setAnnotations] = useState<ArtifactAnnotation[]>([]);
  const [copyState, setCopyState] = useState('复制反馈 JSON');
  const surface = useRef<HTMLDivElement>(null);

  const payload = useMemo(
    () => ({
      schemaVersion: '0.1',
      artifactId: artifactPackage.id,
      artifactRevision: artifactPackage.revision,
      renderer: artifactPackage.renderer,
      template: variant,
      annotations,
    }),
    [annotations, artifactPackage.id, artifactPackage.renderer, artifactPackage.revision, variant],
  );

  const document = artifactPackage.data;

  useEffect(() => {
    function syncVariant() {
      setVariant(variantFromLocation());
      setSelection(null);
      if (surface.current) surface.current.scrollTop = 0;
    }

    window.addEventListener('popstate', syncVariant);
    return () => window.removeEventListener('popstate', syncVariant);
  }, []);

  useEffect(() => {
    const targets = surface.current?.querySelectorAll<HTMLElement>('[data-artifact-path]');
    targets?.forEach((target) => {
      target.classList.toggle('is-selected', target.dataset.artifactPath === selection?.path);
    });
  }, [document, selection, variant]);

  function changeVariant(next: VariantKey) {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState(null, '', url);
    setVariant(next);
    setSelection(null);
    if (surface.current) surface.current.scrollTop = 0;
  }

  function updateSource(next: string) {
    setSource(next);

    try {
      const parsed = parseArtifactPackage(next);
      setArtifactPackage(parsed);
      setParseError(null);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'JSON 无法解析');
    }
  }

  function selectTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return;
    const element = target.closest<HTMLElement>('[data-artifact-path]');
    if (!element || !surface.current?.contains(element)) return;
    setSelection(selectionFromElement(element));
  }

  function handleSurfaceClick(event: ReactMouseEvent<HTMLDivElement>) {
    selectTarget(event.target);
  }

  function handleSurfaceKeydown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    selectTarget(event.target);
    event.preventDefault();
  }

  function addAnnotation() {
    const cleanNote = note.trim();
    if (!selection || !cleanNote) return;

    setAnnotations((current) => [
      ...current,
      {
        ...selection,
        id: `annotation-${current.length + 1}`,
        note: cleanNote,
        variant,
        createdAt: new Date().toISOString(),
      },
    ]);
    setNote('');
  }

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyState('已复制');
    } catch {
      setCopyState('复制失败，请展开 payload');
    }
    window.setTimeout(() => setCopyState('复制反馈 JSON'), 1400);
  }

  const activeVariant = VARIANTS.find((item) => item.key === variant) ?? VARIANTS[0];

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            OA
          </span>
          <div>
            <strong>Open Artifacts</strong>
            <span>interaction prototype / v0.1</span>
          </div>
        </div>
        <div className="runtime-state">
          <span className={parseError ? 'status-dot status-error' : 'status-dot'} />
          <strong>{parseError ? '保留上一版渲染' : 'JSON 即时渲染中'}</strong>
          <span>{activeVariant.label}</span>
          <span>{annotations.length} 条圈注</span>
        </div>
      </header>

      <div className="studio-workspace">
        <aside className="source-panel">
          <div className="panel-heading">
            <div>
              <span>01 / input</span>
              <strong>Artifact Package</strong>
            </div>
            <button type="button" onClick={() => updateSource(initialSource)}>
              恢复样例
            </button>
          </div>
          <textarea
            aria-label="Artifact Package JSON"
            value={source}
            onChange={(event) => updateSource(event.target.value)}
            spellCheck={false}
          />
          <footer className={parseError ? 'source-state has-error' : 'source-state'}>
            <span>{parseError ?? '符合 Artifact Package v0.1'}</span>
            <code>{new Blob([source]).size} bytes</code>
          </footer>
        </aside>

        <main className="render-panel">
          <div className="canvas-toolbar">
            <div>
              <span>02 / render</span>
              <strong>{activeVariant.description}</strong>
            </div>
            <p>
              <span className="annotation-swatch" /> 点击任一内容块开始圈注
            </p>
          </div>
          <div
            className="artifact-surface"
            ref={surface}
            onClick={handleSurfaceClick}
            onKeyDown={handleSurfaceKeydown}
          >
            <ArtifactRenderer variant={variant} document={document} />
          </div>
        </main>

        <aside className="annotation-panel">
          <div className="panel-heading">
            <div>
              <span>03 / feedback</span>
              <strong>定点反馈</strong>
            </div>
            {annotations.length > 0 ? (
              <button type="button" onClick={() => setAnnotations([])}>
                清空
              </button>
            ) : null}
          </div>

          {selection ? (
            <section className="selection-card">
              <span>当前圈选</span>
              <strong>{selection.label}</strong>
              <code>{selection.path}</code>
              <blockquote>{selection.quote}</blockquote>
              <label htmlFor="annotation-note">告诉 AI 这里要怎么改</label>
              <textarea
                id="annotation-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="例如：这个判断缺少与现有方案的直接对比。"
              />
              <button type="button" className="primary-action" onClick={addAnnotation}>
                加入反馈
              </button>
            </section>
          ) : (
            <section className="selection-empty">
              <div className="empty-ring" aria-hidden="true" />
              <strong>先在页面里圈一个东西</strong>
              <p>每个可选块都带稳定的 JSON Pointer，AI 能知道你说的是哪一条数据。</p>
            </section>
          )}

          <section className="annotation-list">
            {annotations.map((annotation, index) => (
              <article key={annotation.id}>
                <div>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <code>{annotation.path}</code>
                </div>
                <strong>{annotation.label}</strong>
                <p>{annotation.note}</p>
              </article>
            ))}
          </section>

          <details className="payload-preview" open={annotations.length > 0}>
            <summary>AI 收到的 payload</summary>
            <pre>{JSON.stringify(payload, null, 2)}</pre>
          </details>

          <button type="button" className="copy-action" onClick={() => void copyPayload()}>
            {copyState}
          </button>
        </aside>
      </div>

      <PrototypeSwitcher current={variant} onChange={changeVariant} />
    </div>
  );
}
