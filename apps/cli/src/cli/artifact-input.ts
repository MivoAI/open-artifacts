import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ResolvedArtifactPackage } from './artifact-package.js';
import {
  ArtifactInputContractError,
  ArtifactInputFileUnreadableError,
  ArtifactInputJsonError,
  ArtifactInputOptionsConflictError,
} from './errors.js';

export interface ArtifactInputOptions {
  data?: string;
  input?: string;
}

export function assertArtifactInputOptions(options: ArtifactInputOptions) {
  if (options.data !== undefined && options.input !== undefined) {
    throw new ArtifactInputOptionsConflictError();
  }
}

function parseArtifactInput(value: string, source: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ArtifactInputJsonError(source);
  }
}

export async function selectArtifactInput(
  artifactPackage: ResolvedArtifactPackage,
  options: ArtifactInputOptions,
  cwd: string,
) {
  let artifactInput = artifactPackage.exampleInput;

  if (options.data !== undefined) {
    artifactInput = parseArtifactInput(options.data, '--data');
  } else if (options.input !== undefined) {
    const filePath = resolve(cwd, options.input);
    const contents = await readFile(filePath, 'utf8').catch(() => {
      throw new ArtifactInputFileUnreadableError(options.input!);
    });
    artifactInput = parseArtifactInput(contents, `Artifact Input file ${options.input}`);
  }

  const issues = artifactPackage.validateInput(artifactInput);
  if (issues.length > 0) throw new ArtifactInputContractError(issues);
  return artifactInput;
}
