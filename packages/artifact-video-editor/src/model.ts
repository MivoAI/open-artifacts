export interface VideoEditorInput {
  project: {
    name: string;
    sequence: string;
    status: string;
  };
  agent: {
    eyebrow: string;
    title: string;
    summary: string;
    tasks: string[];
    composerPlaceholder: string;
  };
  media: {
    id: string;
    title: string;
    kind: string;
    durationSeconds: number;
    dimensions: string;
  };
  timeline: {
    title: string;
    trackLabel: string;
  };
}
