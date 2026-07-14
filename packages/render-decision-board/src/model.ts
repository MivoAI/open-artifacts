export type ClaimKind = 'signal' | 'principle' | 'risk';
export type StepState = 'done' | 'active' | 'next';
export type ActionState = 'ready' | 'watch' | 'later';

export interface DecisionBoardInput {
  meta: {
    eyebrow: string;
    title: string;
    question: string;
    summary: string;
    tags: string[];
  };
  metrics: Array<{
    id: string;
    label: string;
    value: number;
    unit: string;
    note: string;
    trend: number[];
  }>;
  claims: Array<{
    id: string;
    kind: ClaimKind;
    title: string;
    body: string;
    confidence: number;
    evidence: string[];
  }>;
  steps: Array<{
    label: string;
    title: string;
    detail: string;
    state: StepState;
  }>;
  actions: Array<{
    title: string;
    detail: string;
    owner: string;
    state: ActionState;
  }>;
}
