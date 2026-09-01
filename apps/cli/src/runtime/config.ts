export interface ArtifactIdentity {
  activationPath?: string;
  dependencyRoot?: string;
  entryPath: string;
  format: 'react-render/v0' | 'react-runtime/v1';
  name: string;
  root: string;
  version: string;
}

export interface SessionRuntimeConfig {
  artifact: ArtifactIdentity;
  artifactInput: unknown;
  bundlePath: string;
  instanceId: string;
  instanceSecretFile: string;
  instanceTokenHash: string;
  readyFile: string;
  sessionDirectory: string;
  sessionId: string;
}

export interface RuntimeReadyState {
  instanceId: string;
  pid: number;
  url: string;
}
