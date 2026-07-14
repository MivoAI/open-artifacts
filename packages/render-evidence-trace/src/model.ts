export interface EvidenceTraceInput {
  title: string;
  summary: string;
  sources: Array<{
    id: string;
    type: string;
    label: string;
    detail: string;
  }>;
  claims: Array<{
    id: string;
    label: string;
    statement: string;
    confidence: number;
    sourceIds: string[];
  }>;
  outcomes: Array<{
    id: string;
    title: string;
    detail: string;
    state: 'accepted' | 'testing' | 'deferred';
    claimIds: string[];
  }>;
}
