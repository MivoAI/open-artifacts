import { useEffect, useMemo, useState } from 'react';

import { RenderErrorBoundary } from './RenderErrorBoundary.tsx';
import { artifactPackages } from './artifact-registry.ts';

function packageFromLocation(): string {
  const parameters = new URLSearchParams(window.location.search);
  const requested = parameters.get('render');
  if (requested && artifactPackages.some((item) => item.slug === requested)) return requested;

  if (parameters.get('variant') === 'trace') return 'evidence-trace';
  return artifactPackages[0]?.slug ?? '';
}

function sourceFor(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function App() {
  const [activeSlug, setActiveSlug] = useState(packageFromLocation);
  const activePackage = useMemo(
    () => artifactPackages.find((item) => item.slug === activeSlug) ?? artifactPackages[0],
    [activeSlug],
  );
  const [source, setSource] = useState(() => sourceFor(activePackage?.example));
  const [data, setData] = useState<unknown>(activePackage?.example);
  const [parseError, setParseError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [copyLabel, setCopyLabel] = useState('复制 fork 命令');

  useEffect(() => {
    function syncFromLocation() {
      const nextSlug = packageFromLocation();
      const nextPackage = artifactPackages.find((item) => item.slug === nextSlug);
      if (!nextPackage) return;
      setActiveSlug(nextSlug);
      setSource(sourceFor(nextPackage.example));
      setData(nextPackage.example);
      setParseError(null);
      setRevision((current) => current + 1);
    }

    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  if (!activePackage) {
    return (
      <main className="empty-runtime">No Artifact Packages found under `packages/artifact-*`.</main>
    );
  }

  const selectedPackage = activePackage;

  function selectPackage(slug: string) {
    const nextPackage = artifactPackages.find((item) => item.slug === slug);
    if (!nextPackage) return;

    const url = new URL(window.location.href);
    url.searchParams.delete('variant');
    url.searchParams.set('render', slug);
    window.history.pushState(null, '', url);
    setActiveSlug(slug);
    setSource(sourceFor(nextPackage.example));
    setData(nextPackage.example);
    setParseError(null);
    setRevision((current) => current + 1);
  }

  function updateSource(nextSource: string) {
    setSource(nextSource);
    try {
      const nextData: unknown = JSON.parse(nextSource);
      setData(nextData);
      setParseError(null);
      setRevision((current) => current + 1);
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'JSON 无法解析');
    }
  }

  function resetExample() {
    setSource(sourceFor(selectedPackage.example));
    setData(selectedPackage.example);
    setParseError(null);
    setRevision((current) => current + 1);
  }

  async function copyForkCommand() {
    const command = `cp -R packages/${selectedPackage.directory} packages/artifact-my-artifact`;
    try {
      await navigator.clipboard.writeText(command);
      setCopyLabel('已复制');
    } catch {
      setCopyLabel(command);
    }
    window.setTimeout(() => setCopyLabel('复制 fork 命令'), 1600);
  }

  const Render = selectedPackage.Render;

  return (
    <div className="workbench">
      <header className="workbench-header">
        <div className="brand">
          <span className="brand-mark">OA</span>
          <div>
            <strong>Open Artifacts</strong>
            <small>source artifact workbench</small>
          </div>
        </div>

        <div className="execution-seam" aria-label="Runtime interface">
          <span>Artifact Source</span>
          <i />
          <span>Artifact Input</span>
          <i />
          <strong>{'<Render />'}</strong>
        </div>

        <div className="runtime-status">
          <span className={parseError ? 'status-light is-error' : 'status-light'} />
          <strong>{parseError ? '保留上一份有效 render' : 'source runtime ready'}</strong>
          <code>{selectedPackage.format}</code>
        </div>
      </header>

      <div className="workbench-grid">
        <aside className="package-panel">
          <div className="panel-title">
            <div>
              <span>01 / source</span>
              <strong>Artifact Packages</strong>
            </div>
            <code>{artifactPackages.length}</code>
          </div>

          <nav className="package-list" aria-label="Artifact Packages">
            {artifactPackages.map((item) => (
              <button
                className={item.slug === selectedPackage.slug ? 'is-active' : ''}
                key={item.slug}
                type="button"
                onClick={() => selectPackage(item.slug)}
              >
                <span>{item.title}</span>
                <small>{item.description}</small>
                <code>{item.version}</code>
              </button>
            ))}
          </nav>

          <section className="package-anatomy">
            <header>
              <span>package anatomy</span>
              <code>packages/{selectedPackage.directory}</code>
            </header>
            <div className="file-tree">
              {selectedPackage.sourceFiles.map((file, index) => (
                <div className={file === 'src/index.tsx' ? 'is-entry' : ''} key={file}>
                  <span>{index === selectedPackage.sourceFiles.length - 1 ? '└─' : '├─'}</span>
                  <code>{file}</code>
                  {file === 'src/index.tsx' ? <small>default export</small> : null}
                </div>
              ))}
            </div>
          </section>

          <section className="dependency-block">
            <span>package-owned dependencies</span>
            {selectedPackage.dependencies.length > 0 ? (
              selectedPackage.dependencies.map((dependency) => (
                <code key={dependency}>{dependency}</code>
              ))
            ) : (
              <code>plain React</code>
            )}
          </section>

          <button className="fork-command" type="button" onClick={() => void copyForkCommand()}>
            <span>⌘</span>
            {copyLabel}
          </button>
        </aside>

        <main className="runtime-panel">
          <div className="runtime-toolbar">
            <div>
              <span>02 / render</span>
              <strong>{selectedPackage.title}</strong>
            </div>
            <div>
              <code>{selectedPackage.name}</code>
              <span className="source-badge">TSX source</span>
            </div>
          </div>
          <div className="runtime-canvas">
            <RenderErrorBoundary
              key={`${selectedPackage.slug}-${revision}`}
              packageName={selectedPackage.name}
            >
              <Render data={data} />
            </RenderErrorBoundary>
          </div>
        </main>

        <aside className="input-panel">
          <div className="panel-title">
            <div>
              <span>03 / input</span>
              <strong>Artifact Input</strong>
            </div>
            <button type="button" onClick={resetExample}>
              恢复 example
            </button>
          </div>
          <div className="schema-strip">
            <span>schema</span>
            <strong>{selectedPackage.schemaTitle}</strong>
            <code>./input.schema.json</code>
          </div>
          <textarea
            aria-label={`${selectedPackage.title} JSON input`}
            value={source}
            onChange={(event) => updateSource(event.target.value)}
            spellCheck={false}
          />
          <footer className={parseError ? 'input-state has-error' : 'input-state'}>
            <span>{parseError ?? 'JSON syntax valid · render updated'}</span>
            <code>{new Blob([source]).size} bytes</code>
          </footer>
        </aside>
      </div>
    </div>
  );
}
