export const VARIANTS = [
  {
    key: 'atlas',
    label: 'Atlas',
    description: '全景情报板',
  },
  {
    key: 'brief',
    label: 'Brief',
    description: '快速阅读路径',
  },
  {
    key: 'trace',
    label: 'Trace',
    description: '证据到行动',
  },
] as const;

export type VariantKey = (typeof VARIANTS)[number]['key'];
export type InsightTone = 'signal' | 'risk' | 'decision';
export type TimelineState = 'complete' | 'current' | 'next';
export type ActionState = 'ready' | 'blocked' | 'later';

export interface ArtifactMetric {
  id: string;
  label: string;
  value: number;
  unit: string;
  delta: string;
  trend: number[];
}

export interface ArtifactInsight {
  id: string;
  label: string;
  title: string;
  body: string;
  confidence: number;
  evidence: string[];
  tone: InsightTone;
}

export interface ArtifactSource {
  id: string;
  label: string;
  detail: string;
  kind: string;
}

export interface ArtifactTimelineItem {
  id: string;
  when: string;
  title: string;
  detail: string;
  state: TimelineState;
}

export interface ArtifactAction {
  id: string;
  title: string;
  detail: string;
  owner: string;
  state: ActionState;
}

export interface ArtifactDocument {
  artifact: {
    id: string;
    kind: string;
    title: string;
    question: string;
    summary: string;
    generatedAt: string;
    tags: string[];
  };
  metrics: ArtifactMetric[];
  insights: ArtifactInsight[];
  sources: ArtifactSource[];
  timeline: ArtifactTimelineItem[];
  actions: ArtifactAction[];
}

export interface ArtifactPackage {
  artifactVersion: '0.1';
  id: string;
  revision: number;
  renderer: {
    kind: 'template';
    id: string;
    version: string;
  };
  inputSchema: string;
  capabilities: {
    network: 'none' | 'declared';
    code: 'trusted-components' | 'sandbox';
  };
  provenance: {
    generator: string;
    createdAt: string;
  };
  editPolicy: 'patchable' | 'replace-only';
  data: ArtifactDocument;
}

export interface ArtifactSelection {
  path: string;
  label: string;
  quote: string;
}

export interface ArtifactAnnotation extends ArtifactSelection {
  id: string;
  note: string;
  variant: VariantKey;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseArtifactPackage(source: string): ArtifactPackage {
  const value: unknown = JSON.parse(source);

  if (!isRecord(value) || value.artifactVersion !== '0.1') {
    throw new Error('artifactVersion 必须是 0.1');
  }

  if (!isRecord(value.renderer) || value.renderer.kind !== 'template') {
    throw new Error('renderer.kind 必须是 template');
  }

  if (!isRecord(value.data) || !isRecord(value.data.artifact)) {
    throw new Error('data.artifact 缺失');
  }

  if (typeof value.data.artifact.title !== 'string') {
    throw new Error('data.artifact.title 缺失');
  }

  for (const field of ['metrics', 'insights', 'sources', 'timeline', 'actions']) {
    if (!Array.isArray(value.data[field])) throw new Error(`data.${field} 必须是数组`);
  }

  return value as unknown as ArtifactPackage;
}

export function isVariantKey(value: string | null): value is VariantKey {
  return VARIANTS.some((variant) => variant.key === value);
}

export function metricValue(metric: ArtifactMetric): string {
  return `${metric.value}${metric.unit}`;
}
