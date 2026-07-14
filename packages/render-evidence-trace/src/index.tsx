import { useState } from 'react';

import type { EvidenceTraceInput } from './model.ts';
import './styles.css';

export interface EvidenceTraceProps {
  data: EvidenceTraceInput;
}

const stateLabels: Record<EvidenceTraceInput['outcomes'][number]['state'], string> = {
  accepted: 'accepted',
  testing: 'in test',
  deferred: 'deferred',
};

export default function EvidenceTrace({ data }: EvidenceTraceProps) {
  const [selectedClaimId, setSelectedClaimId] = useState(data.claims[0]?.id ?? '');
  const selectedClaim = data.claims.find((claim) => claim.id === selectedClaimId) ?? data.claims[0];
  const selectedSourceIds = new Set(selectedClaim?.sourceIds ?? []);

  return (
    <article className="oa-evidence-trace">
      <header className="et-header">
        <div>
          <span>Evidence Trace / source package</span>
          <h1>{data.title}</h1>
        </div>
        <p>{data.summary}</p>
      </header>

      <div className="et-route" aria-hidden="true">
        <span>JSON input</span>
        <i />
        <span>React reasoning view</span>
        <i />
        <span>format decision</span>
      </div>

      <div className="et-lanes">
        <section className="et-lane et-source-lane">
          <header>
            <span>01</span>
            <div>
              <strong>Inputs</strong>
              <small>package constraints</small>
            </div>
          </header>
          <div className="et-card-stack">
            {data.sources.map((source) => {
              const isActive = selectedSourceIds.has(source.id);
              return (
                <article
                  className={`et-source-card ${isActive ? 'is-active' : ''}`}
                  key={source.id}
                >
                  <div>
                    <span>{source.type}</span>
                    <code>{source.id}</code>
                  </div>
                  <h2>{source.label}</h2>
                  <p>{source.detail}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="et-lane et-claim-lane">
          <header>
            <span>02</span>
            <div>
              <strong>Claims</strong>
              <small>click to trace</small>
            </div>
          </header>
          <div className="et-card-stack">
            {data.claims.map((claim) => {
              const isActive = claim.id === selectedClaim?.id;
              return (
                <button
                  className={`et-claim-card ${isActive ? 'is-active' : ''}`}
                  key={claim.id}
                  type="button"
                  onClick={() => setSelectedClaimId(claim.id)}
                  aria-pressed={isActive}
                >
                  <div>
                    <span>{claim.label}</span>
                    <strong>{Math.round(claim.confidence * 100)}%</strong>
                  </div>
                  <h2>{claim.statement}</h2>
                  <footer>
                    {claim.sourceIds.map((sourceId) => (
                      <code key={sourceId}>← {sourceId}</code>
                    ))}
                  </footer>
                </button>
              );
            })}
          </div>
        </section>

        <section className="et-lane et-outcome-lane">
          <header>
            <span>03</span>
            <div>
              <strong>Outcomes</strong>
              <small>format choices</small>
            </div>
          </header>
          <div className="et-card-stack">
            {data.outcomes.map((outcome) => {
              const isActive = selectedClaim ? outcome.claimIds.includes(selectedClaim.id) : false;
              return (
                <article
                  className={`et-outcome-card et-${outcome.state} ${isActive ? 'is-active' : ''}`}
                  key={outcome.id}
                >
                  <span>{stateLabels[outcome.state]}</span>
                  <h2>{outcome.title}</h2>
                  <p>{outcome.detail}</p>
                  <footer>
                    {outcome.claimIds.map((claimId) => (
                      <code key={claimId}>{claimId}</code>
                    ))}
                  </footer>
                </article>
              );
            })}
          </div>
          <div className="et-runtime-note">
            <span>runtime interface</span>
            <code>{'<Render data={input} />'}</code>
          </div>
        </section>
      </div>
    </article>
  );
}
