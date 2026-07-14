import { ArtifactTarget, TrendChart } from './components.tsx';
import { metricValue } from './model.ts';
import type {
  ActionState,
  ArtifactDocument,
  ArtifactInsight,
  InsightTone,
  TimelineState,
} from './model.ts';

interface VariantProps {
  document: ArtifactDocument;
}

const toneLabels: Record<InsightTone, string> = {
  signal: '信号',
  risk: '风险',
  decision: '判断',
};

const timelineLabels: Record<TimelineState, string> = {
  complete: '已完成',
  current: '此刻',
  next: '下一步',
};

const actionLabels: Record<ActionState, string> = {
  ready: '可执行',
  blocked: '需定义边界',
  later: '稍后',
};

function Confidence({ insight }: { insight: ArtifactInsight }) {
  return (
    <div className="confidence" aria-label={`置信度 ${Math.round(insight.confidence * 100)}%`}>
      <span style={{ width: `${insight.confidence * 100}%` }} />
    </div>
  );
}

export function AtlasVariant({ document }: VariantProps) {
  return (
    <article className="artifact-view atlas-view">
      <header className="atlas-hero">
        <ArtifactTarget path="/data/artifact/title" label="主结论" className="atlas-title">
          <p className="kicker">{document.artifact.kind}</p>
          <h1>{document.artifact.title}</h1>
        </ArtifactTarget>
        <ArtifactTarget path="/data/artifact/summary" label="摘要" className="atlas-summary">
          <p>{document.artifact.summary}</p>
          <div className="tag-row">
            {document.artifact.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </ArtifactTarget>
      </header>

      <section className="metric-ribbon" aria-label="关键指标">
        {document.metrics.map((metric, index) => (
          <ArtifactTarget
            key={metric.id}
            path={`/data/metrics/${index}`}
            label={metric.label}
            className="metric-cell"
          >
            <span>{metric.label}</span>
            <strong>{metricValue(metric)}</strong>
            <small>{metric.delta}</small>
          </ArtifactTarget>
        ))}
      </section>

      <div className="atlas-grid">
        <section className="atlas-panel atlas-insights">
          <div className="section-heading">
            <span>Judgments</span>
            <strong>{document.insights.length} 条可定位判断</strong>
          </div>
          {document.insights.map((insight, index) => (
            <ArtifactTarget
              key={insight.id}
              path={`/data/insights/${index}`}
              label={insight.title}
              className={`insight-row tone-${insight.tone}`}
            >
              <div className="insight-index">{String(index + 1).padStart(2, '0')}</div>
              <div>
                <p className="eyebrow">{toneLabels[insight.tone]}</p>
                <h2>{insight.title}</h2>
                <p>{insight.body}</p>
                <Confidence insight={insight} />
              </div>
            </ArtifactTarget>
          ))}
        </section>

        <section className="atlas-panel atlas-telemetry">
          <ArtifactTarget path="/data/metrics" label="指标趋势" className="chart-panel">
            <div className="section-heading">
              <span>Telemetry</span>
              <strong>结构化后的变化</strong>
            </div>
            <TrendChart metrics={document.metrics} />
          </ArtifactTarget>

          <div className="section-heading timeline-heading">
            <span>Render loop</span>
            <strong>从意图到定点修改</strong>
          </div>
          <div className="compact-timeline">
            {document.timeline.map((item, index) => (
              <ArtifactTarget
                key={item.id}
                path={`/data/timeline/${index}`}
                label={item.title}
                className={`timeline-row state-${item.state}`}
              >
                <time>{item.when}</time>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
              </ArtifactTarget>
            ))}
          </div>
        </section>

        <aside className="atlas-panel atlas-actions">
          <div className="section-heading">
            <span>Next</span>
            <strong>决策之后做什么</strong>
          </div>
          {document.actions.map((action, index) => (
            <ArtifactTarget
              key={action.id}
              path={`/data/actions/${index}`}
              label={action.title}
              className={`action-card state-${action.state}`}
            >
              <span>{actionLabels[action.state]}</span>
              <h3>{action.title}</h3>
              <p>{action.detail}</p>
              <small>{action.owner}</small>
            </ArtifactTarget>
          ))}

          <div className="source-stack">
            <p className="eyebrow">Evidence set</p>
            {document.sources.map((source, index) => (
              <ArtifactTarget
                key={source.id}
                path={`/data/sources/${index}`}
                label={source.label}
                className="source-mini"
              >
                <span>{source.kind}</span>
                <strong>{source.label}</strong>
              </ArtifactTarget>
            ))}
          </div>
        </aside>
      </div>
    </article>
  );
}

export function BriefVariant({ document }: VariantProps) {
  return (
    <article className="artifact-view brief-view">
      <header className="brief-cover">
        <ArtifactTarget path="/data/artifact/question" label="核心问题" className="brief-question">
          <span>Open question</span>
          <p>{document.artifact.question}</p>
        </ArtifactTarget>
        <ArtifactTarget path="/data/artifact/title" label="主结论" className="brief-title">
          <p>{document.artifact.kind}</p>
          <h1>{document.artifact.title}</h1>
        </ArtifactTarget>
      </header>

      <div className="brief-layout">
        <aside className="brief-rail">
          <p className="rail-label">一分钟扫读</p>
          {document.metrics.map((metric, index) => (
            <ArtifactTarget
              key={metric.id}
              path={`/data/metrics/${index}`}
              label={metric.label}
              className="brief-metric"
            >
              <strong>{metricValue(metric)}</strong>
              <span>{metric.label}</span>
              <small>{metric.delta}</small>
            </ArtifactTarget>
          ))}
        </aside>

        <main className="brief-story">
          <ArtifactTarget path="/data/artifact/summary" label="执行摘要" className="brief-lede">
            <p className="eyebrow">Executive read</p>
            <p>{document.artifact.summary}</p>
          </ArtifactTarget>

          <section className="brief-section">
            <div className="brief-section-title">
              <span>What changed</span>
              <p>先读判断，再决定是否展开证据。</p>
            </div>
            <div className="brief-insight-list">
              {document.insights.map((insight, index) => (
                <ArtifactTarget
                  key={insight.id}
                  path={`/data/insights/${index}`}
                  label={insight.title}
                  className={`brief-insight tone-${insight.tone}`}
                >
                  <p className="eyebrow">{insight.label}</p>
                  <h2>{insight.title}</h2>
                  <p>{insight.body}</p>
                  <div className="evidence-line">
                    {insight.evidence.map((evidence) => (
                      <span key={evidence}>{evidence}</span>
                    ))}
                  </div>
                </ArtifactTarget>
              ))}
            </div>
          </section>

          <section className="brief-section">
            <div className="brief-section-title">
              <span>How it moves</span>
              <p>回答不是终稿，而是一条可继续操作的路径。</p>
            </div>
            <div className="brief-sequence">
              {document.timeline.map((item, index) => (
                <ArtifactTarget
                  key={item.id}
                  path={`/data/timeline/${index}`}
                  label={item.title}
                  className={`brief-step state-${item.state}`}
                >
                  <div>
                    <time>{item.when}</time>
                    <span>{timelineLabels[item.state]}</span>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.detail}</p>
                </ArtifactTarget>
              ))}
            </div>
          </section>

          <section className="brief-section brief-actions-section">
            <div className="brief-section-title">
              <span>Commitments</span>
              <p>把结论压缩成能被检查的下一步。</p>
            </div>
            {document.actions.map((action, index) => (
              <ArtifactTarget
                key={action.id}
                path={`/data/actions/${index}`}
                label={action.title}
                className="brief-action"
              >
                <span>{action.owner}</span>
                <strong>{action.title}</strong>
                <p>{action.detail}</p>
                <small>{actionLabels[action.state]}</small>
              </ArtifactTarget>
            ))}
          </section>
        </main>
      </div>
    </article>
  );
}

export function TraceVariant({ document }: VariantProps) {
  return (
    <article className="artifact-view trace-view">
      <header className="trace-header">
        <ArtifactTarget path="/data/artifact/title" label="主结论" className="trace-title">
          <span>Evidence trace / v0.1</span>
          <h1>{document.artifact.title}</h1>
        </ArtifactTarget>
        <ArtifactTarget path="/data/artifact/summary" label="摘要" className="trace-summary">
          <p>{document.artifact.summary}</p>
        </ArtifactTarget>
      </header>

      <div className="trace-legend" aria-hidden="true">
        <span>输入证据</span>
        <span>模型判断</span>
        <span>可执行结果</span>
      </div>

      <div className="trace-lanes">
        <section className="trace-lane trace-sources">
          <h2 className="trace-lane-title">01 / 输入证据</h2>
          {document.sources.map((source, index) => (
            <ArtifactTarget
              key={source.id}
              path={`/data/sources/${index}`}
              label={source.label}
              className="trace-node source-node"
            >
              <span>{source.kind}</span>
              <h2>{source.label}</h2>
              <p>{source.detail}</p>
              <code>{source.id}</code>
            </ArtifactTarget>
          ))}
        </section>

        <section className="trace-lane trace-insights">
          <h2 className="trace-lane-title">02 / 模型判断</h2>
          {document.insights.map((insight, index) => (
            <ArtifactTarget
              key={insight.id}
              path={`/data/insights/${index}`}
              label={insight.title}
              className={`trace-node insight-node tone-${insight.tone}`}
            >
              <div className="trace-node-meta">
                <span>{toneLabels[insight.tone]}</span>
                <strong>{Math.round(insight.confidence * 100)}%</strong>
              </div>
              <h2>{insight.title}</h2>
              <p>{insight.body}</p>
              <div className="evidence-line">
                {insight.evidence.map((evidence) => (
                  <span key={evidence}>← {evidence}</span>
                ))}
              </div>
            </ArtifactTarget>
          ))}
        </section>

        <section className="trace-lane trace-actions">
          <h2 className="trace-lane-title">03 / 可执行结果</h2>
          {document.actions.map((action, index) => (
            <ArtifactTarget
              key={action.id}
              path={`/data/actions/${index}`}
              label={action.title}
              className={`trace-node action-node state-${action.state}`}
            >
              <div className="trace-node-meta">
                <span>{action.owner}</span>
                <strong>{actionLabels[action.state]}</strong>
              </div>
              <h2>{action.title}</h2>
              <p>{action.detail}</p>
            </ArtifactTarget>
          ))}

          <ArtifactTarget path="/data/timeline" label="交互闭环" className="trace-loop">
            <span>feedback loop</span>
            <strong>圈注 → 语义路径 → AI patch</strong>
            <p>视觉选择与结构化数据共享同一坐标系。</p>
          </ArtifactTarget>
        </section>
      </div>
    </article>
  );
}
