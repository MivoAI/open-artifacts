export interface CliIssue {
  message: string;
  path: string;
}

type CliErrorKind = 'contract' | 'reference' | 'runtime';

export class CliError extends Error {
  constructor(
    readonly code: string,
    readonly kind: CliErrorKind,
    message: string,
    readonly issues?: CliIssue[],
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class ArtifactContractError extends CliError {
  constructor(issues: CliIssue[]) {
    super(
      'ARTIFACT_CONTRACT_INVALID',
      'contract',
      'Artifact Package does not satisfy react-render/v0',
      [...issues].sort((left, right) => {
        const leftKey = `${left.path}\0${left.message}`;
        const rightKey = `${right.path}\0${right.message}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    );
  }
}

export class ArtifactReferenceError extends CliError {
  constructor(message: string) {
    super('ARTIFACT_REFERENCE_INVALID', 'reference', message);
  }
}

export class ArtifactRuntimeStartError extends CliError {
  constructor() {
    super('ARTIFACT_RUNTIME_START_FAILED', 'runtime', 'Artifact Session Runtime failed to start');
  }
}

function normalizeError(error: unknown) {
  if (error instanceof CliError) return error;
  return new CliError(
    'OA_INTERNAL_ERROR',
    'runtime',
    'Open Artifacts encountered an unexpected error',
  );
}

export function writeCliError(error: unknown, json: boolean) {
  const cliError = normalizeError(error);

  if (json) {
    process.stderr.write(
      `${JSON.stringify({
        error: {
          code: cliError.code,
          kind: cliError.kind,
          message: cliError.message,
          ...(cliError.issues ? { issues: cliError.issues } : {}),
        },
      })}\n`,
    );
    return;
  }

  const heading =
    cliError.kind === 'contract'
      ? 'Artifact Contract error'
      : cliError.kind === 'reference'
        ? 'Artifact Reference error'
        : 'Artifact Runtime error';
  const issues =
    cliError.issues?.map((issue) => `\n  - ${issue.path}: ${issue.message}`).join('') ?? '';
  process.stderr.write(`oa: ${heading}: ${cliError.message}${issues}\n`);
}
