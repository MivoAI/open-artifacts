import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import Ajv2020Import from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import type { Ajv2020 as Ajv2020Constructor } from 'ajv/dist/2020.js';

import type { ArtifactIdentity } from '../runtime/config.js';
import { ArtifactContractError, ArtifactReferenceError, type CliIssue } from './errors.js';

const inputSchemaDraft = 'https://json-schema.org/draft/2020-12/schema';
const fixedResources = [
  'src/index.tsx',
  'input.schema.json',
  'example.json',
  'tsconfig.json',
  'README.md',
] as const;

const artifactManifestSchema = {
  type: 'object',
  required: ['name', 'version', 'type', 'files', 'exports', 'openArtifacts', 'peerDependencies'],
  properties: {
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    type: { const: 'module' },
    files: {
      type: 'array',
      items: { type: 'string' },
      allOf: [
        { contains: { const: 'src' } },
        { contains: { const: 'input.schema.json' } },
        { contains: { const: 'example.json' } },
        { contains: { const: 'tsconfig.json' } },
        { contains: { const: 'README.md' } },
      ],
    },
    exports: {
      type: 'object',
      required: ['.', './schema', './example', './package.json'],
      properties: {
        '.': { const: './src/index.tsx' },
        './schema': { const: './input.schema.json' },
        './example': { const: './example.json' },
        './package.json': { const: './package.json' },
      },
    },
    openArtifacts: {
      type: 'object',
      additionalProperties: false,
      required: ['format'],
      properties: { format: { const: 'react-render/v0' } },
    },
    peerDependencies: {
      type: 'object',
      required: ['react'],
      properties: { react: { type: 'string', minLength: 1 } },
    },
    dependencies: {
      type: 'object',
      properties: { react: false },
      additionalProperties: { type: 'string' },
    },
  },
} as const;

interface ArtifactManifest {
  name: string;
  version: string;
}

export interface ResolvedArtifactPackage {
  exampleInput: unknown;
  identity: ArtifactIdentity;
  validateInput: ValidateFunction;
}

const Ajv2020 = Ajv2020Import as unknown as typeof Ajv2020Constructor;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifest = ajv.compile(artifactManifestSchema);

function jsonPath(instancePath: string, missingProperty?: string) {
  const segments = instancePath
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (missingProperty) segments.push(missingProperty);

  return segments.reduce(
    (path, segment) =>
      /^[A-Za-z_$][\w$]*$/.test(segment)
        ? `${path}.${segment}`
        : `${path}[${JSON.stringify(segment)}]`,
    '$',
  );
}

function errorMessage(error: ErrorObject) {
  if (error.keyword === 'const') return `must equal ${String(error.params.allowedValue)}`;
  return error.message ?? `must satisfy ${error.keyword}`;
}

export function formatValidationIssues(
  errors: ErrorObject[] | null | undefined,
  prefix = '$',
): CliIssue[] {
  return (errors ?? []).map((error) => {
    const missingProperty =
      error.keyword === 'required' && typeof error.params.missingProperty === 'string'
        ? error.params.missingProperty
        : error.keyword === 'additionalProperties' &&
            typeof error.params.additionalProperty === 'string'
          ? error.params.additionalProperty
          : undefined;
    const path = jsonPath(error.instancePath, missingProperty);
    return {
      message: errorMessage(error),
      path: path === '$' ? prefix : `${prefix}${path.slice(1)}`,
    };
  });
}

function resolvePackageFile(root: string, packagePath: string) {
  const resolved = resolve(root, packagePath);
  const pathWithinPackage = relative(root, resolved);
  if (pathWithinPackage.startsWith('..') || isAbsolute(pathWithinPackage)) {
    throw new ArtifactContractError([
      { path: '$.exports', message: `${packagePath} must remain inside the Artifact Package` },
    ]);
  }
  return resolved;
}

async function readJson(path: string, issuePath: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const message =
      error instanceof SyntaxError ? 'must contain valid JSON' : 'must be a readable file';
    throw new ArtifactContractError([{ path: issuePath, message }]);
  }
}

async function requireFixedResources(root: string) {
  const issues: CliIssue[] = [];
  await Promise.all(
    fixedResources.map(async (resource) => {
      const resourcePath = resolvePackageFile(root, resource);
      const resourceStat = await stat(resourcePath).catch(() => undefined);
      if (!resourceStat?.isFile()) {
        issues.push({
          path: `$.files[${JSON.stringify(resource)}]`,
          message: 'must exist as a file',
        });
      }
    }),
  );
  if (issues.length > 0) throw new ArtifactContractError(issues);
}

export async function resolveLocalArtifactPackage(
  reference: string,
  cwd: string,
): Promise<ResolvedArtifactPackage> {
  const isExplicitRelative =
    reference === '.' ||
    reference === '..' ||
    reference.startsWith('./') ||
    reference.startsWith('../');
  if (!isExplicitRelative && !isAbsolute(reference)) {
    throw new ArtifactReferenceError(
      `Issue #3 supports explicit local Artifact References only; received: ${reference}`,
    );
  }

  const root = await realpath(resolve(cwd, reference)).catch(() => {
    throw new ArtifactReferenceError(
      `Artifact Reference does not resolve to a local directory: ${reference}`,
    );
  });
  if (!(await stat(root)).isDirectory()) {
    throw new ArtifactReferenceError(`Artifact Reference is not a directory: ${root}`);
  }

  const manifestValue = await readJson(resolve(root, 'package.json'), '$.packageJson');
  if (!validateManifest(manifestValue)) {
    throw new ArtifactContractError(formatValidationIssues(validateManifest.errors));
  }
  const manifest = manifestValue as ArtifactManifest;
  await requireFixedResources(root);

  const schema = await readJson(resolve(root, 'input.schema.json'), '$.inputContract');
  if (
    !schema ||
    typeof schema !== 'object' ||
    !('$schema' in schema) ||
    schema.$schema !== inputSchemaDraft
  ) {
    throw new ArtifactContractError([
      { path: '$.inputContract.$schema', message: `must equal ${inputSchemaDraft}` },
    ]);
  }

  let validateInput: ValidateFunction;
  try {
    validateInput = ajv.compile(schema as AnySchema);
  } catch (error) {
    throw new ArtifactContractError([
      {
        path: '$.inputContract',
        message: error instanceof Error ? error.message : 'must be a valid JSON Schema',
      },
    ]);
  }

  const exampleInput = await readJson(resolve(root, 'example.json'), '$.example');
  if (!validateInput(exampleInput)) {
    throw new ArtifactContractError(formatValidationIssues(validateInput.errors, '$.example'));
  }

  return {
    exampleInput,
    identity: {
      entryPath: resolvePackageFile(root, './src/index.tsx'),
      name: manifest.name,
      root,
      version: manifest.version,
    },
    validateInput,
  };
}
