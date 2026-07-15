export interface ArtifactIdentity {
  dependencyRoot?: string;
  entryPath: string;
  name: string;
  root: string;
  version: string;
}

export interface SessionRuntimeConfig {
  artifact: ArtifactIdentity;
  artifactInput: unknown;
  instanceId: string;
  instanceSecretFile: string;
  readyFile: string;
  sessionDirectory: string;
  sessionId: string;
}

export interface RuntimeReadyState {
  instanceId: string;
  pid: number;
  url: string;
}
