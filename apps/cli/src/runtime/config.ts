export interface ArtifactIdentity {
  entryPath: string;
  name: string;
  root: string;
  version: string;
}

export interface SessionRuntimeConfig {
  artifact: ArtifactIdentity;
  artifactInput: unknown;
  readyFile: string;
  sessionDirectory: string;
  sessionId: string;
}

export interface RuntimeReadyState {
  pid: number;
  url: string;
}
