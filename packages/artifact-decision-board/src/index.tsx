import { TrendChart } from './TrendChart.tsx';
import type { ActionState, ClaimKind, DecisionBoardInput, StepState } from './model.ts';
import './styles.css';

export interface DecisionBoardProps {
  data: DecisionBoardInput;
}

const claimLabels: Record<ClaimKind, string> = {
  signal: 'Signal',
  principle: 'Principle',
  risk: 'Boundary',
};

const stepLabels: Record<StepState, string> = {
  done: 'validated',
  active: 'running',
  next: 'next',
};

const actionLabels: Record<ActionState, string> = {
  ready: 'ready',
  watch: 'watch',
  later: 'later',
};

export default function DecisionBoard({ data }: DecisionBoardProps) {
  return (
    <article className="oa-decision-board">
      <header className="db-hero">
        <div className="db-hero-copy">
          <p className="db-kicker">{data.meta.eyebrow}</p>
          <h1>{data.meta.title}</h1>
          <p className="db-question">{data.meta.question}</p>
        </div>
        <div className="db-hero-summary">
          <span>Core read</span>
          <p>{data.meta.summary}</p>
          <div className="db-tags">
            {data.meta.tags.map((tag) => (
              <small key={tag}>{tag}</small>
            ))}
          </div>
        </div>
      </header>

      <section className="db-metrics" aria-label="Package contract metrics">
        {data.metrics.map((metric) => (
          <div className="db-metric" key={metric.id}>
            <span>{metric.label}</span>
            <strong>
              {metric.value}
              <small>{metric.unit}</small>
            </strong>
            <p>{metric.note}</p>
          </div>
        ))}
      </section>

      <div className="db-grid">
        <section className="db-panel db-claims">
          <div className="db-section-heading">
            <div>
              <span>01 / contract</span>
              <h2>关键判断</h2>
            </div>
            <strong>{data.claims.length} claims</strong>
          </div>

          <div className="db-claim-list">
            {data.claims.map((claim, index) => (
              <article className={`db-claim db-${claim.kind}`} key={claim.id}>
                <span className="db-claim-index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <p className="db-claim-kind">{claimLabels[claim.kind]}</p>
                  <h3>{claim.title}</h3>
                  <p>{claim.body}</p>
                  <div className="db-confidence">
                    <span style={{ width: `${claim.confidence * 100}%` }} />
                  </div>
                  <footer>
                    {claim.evidence.map((evidence) => (
                      <code key={evidence}>{evidence}</code>
                    ))}
                  </footer>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="db-side-stack">
          <div className="db-panel db-chart-panel">
            <div className="db-section-heading">
              <div>
                <span>02 / dependency</span>
                <h2>ECharts lives here</h2>
              </div>
              <strong>package-owned</strong>
            </div>
            <TrendChart metrics={data.metrics} />
            <p className="db-chart-note">
              宿主没有图表依赖；这个 Artifact Package 自己声明、渲染并清理 ECharts。
            </p>
          </div>

          <div className="db-panel db-steps-panel">
            <div className="db-section-heading">
              <div>
                <span>03 / execution</span>
                <h2>从 JSON 到页面</h2>
              </div>
            </div>
            <ol className="db-steps">
              {data.steps.map((step) => (
                <li className={`db-step db-step-${step.state}`} key={`${step.label}-${step.title}`}>
                  <span>{step.label}</span>
                  <div>
                    <small>{stepLabels[step.state]}</small>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <aside className="db-panel db-actions">
          <div className="db-section-heading">
            <div>
              <span>04 / next</span>
              <h2>格式决策</h2>
            </div>
          </div>
          {data.actions.map((action) => (
            <article className={`db-action db-action-${action.state}`} key={action.title}>
              <div>
                <span>{action.owner}</span>
                <small>{actionLabels[action.state]}</small>
              </div>
              <h3>{action.title}</h3>
              <p>{action.detail}</p>
            </article>
          ))}
          <div className="db-source-stamp">
            <span>source export</span>
            <code>./src/index.tsx</code>
          </div>
        </aside>
      </div>
    </article>
  );
}
