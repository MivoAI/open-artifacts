export type VideoTreatment = 'tighten-pacing' | 'captions' | 'music-bed';
export type TargetPlatform = 'tiktok' | 'instagram-reels' | 'youtube-shorts';
export type AspectRatio = '9:16' | '1:1' | '16:9';

export interface AgentBrief {
  treatments: VideoTreatment[];
  targetPlatform: TargetPlatform;
  aspectRatio: AspectRatio;
}

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
  brief: AgentBrief;
}
