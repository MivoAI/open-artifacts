export interface CliIssue {
  message: string;
  path: string;
}

type CliErrorKind = 'contract' | 'input' | 'reference' | 'session';

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

export class ArtifactPackageContractError extends CliError {
  constructor(issues: CliIssue[]) {
    super(
      'ARTIFACT_PACKAGE_CONTRACT_INVALID',
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

export class ArtifactInputOptionsConflictError extends CliError {
  constructor() {
    super('ARTIFACT_INPUT_OPTIONS_CONFLICT', 'input', '--input and --data cannot be used together');
  }
}

export class ArtifactInputFileUnreadableError extends CliError {
  constructor(reference: string) {
    super(
      'ARTIFACT_INPUT_FILE_UNREADABLE',
      'input',
      `Artifact Input file is not readable: ${reference}`,
    );
  }
}

export class ArtifactInputJsonError extends CliError {
  constructor(source: string) {
    super('ARTIFACT_INPUT_JSON_INVALID', 'input', `${source} must contain valid JSON`);
  }
}

export class ArtifactInputContractError extends CliError {
  constructor(issues: CliIssue[]) {
    super(
      'ARTIFACT_INPUT_CONTRACT_INVALID',
      'input',
      'Artifact Input does not satisfy the Input Contract',
      issues,
    );
  }
}

export class ArtifactSessionStartError extends CliError {
  constructor() {
    super('ARTIFACT_SESSION_START_FAILED', 'session', 'Artifact Session failed to start');
  }
}

function normalizeError(error: unknown) {
  if (error instanceof CliError) return error;
  return new CliError(
    'OA_INTERNAL_ERROR',
    'session',
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
      ? 'Artifact Package contract error'
      : cliError.kind === 'input'
        ? 'Artifact Input error'
        : cliError.kind === 'reference'
          ? 'Artifact Reference error'
          : 'Artifact Session error';
  const issues =
    cliError.issues?.map((issue) => `\n  - ${issue.path}: ${issue.message}`).join('') ?? '';
  process.stderr.write(`oa: ${heading}: ${cliError.message}${issues}\n`);
}
