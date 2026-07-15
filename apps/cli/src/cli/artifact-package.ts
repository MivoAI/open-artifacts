import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import Ajv2020Import from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import type { Ajv2020 as Ajv2020Constructor } from 'ajv/dist/2020.js';
import { init as initModuleLexer, parse as parseModule } from 'es-module-lexer';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, normalizePath, transformWithOxc } from 'vite';

import type { ArtifactIdentity } from '../runtime/config.js';
import { reactResolutionRoot } from '../runtime/react.js';
import { ArtifactPackageContractError, ArtifactReferenceError, type CliIssue } from './errors.js';

const inputSchemaDraft = 'https://json-schema.org/draft/2020-12/schema';
const fixedResources = [
  'src/index.tsx',
  'input.schema.json',
  'example.json',
  'tsconfig.json',
  'README.md',
] as const;

export const artifactPackageManifestSchema = {
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
  validateInput(input: unknown): CliIssue[];
}

const Ajv2020 = Ajv2020Import as unknown as typeof Ajv2020Constructor;
const manifestAjv = new Ajv2020({ allErrors: true, strict: true });
const inputAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateManifest = manifestAjv.compile(artifactPackageManifestSchema);

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

function resolvePackagePath(root: string, packagePath: string) {
  const resolved = resolve(root, packagePath);
  const pathWithinPackage = relative(root, resolved);
  if (pathWithinPackage.startsWith('..') || isAbsolute(pathWithinPackage)) {
    throw new ArtifactPackageContractError([
      { path: '$.exports', message: `${packagePath} must remain inside the Artifact Package` },
    ]);
  }
  return resolved;
}

async function resolvePackageFile(root: string, packagePath: string) {
  const resolvedPath = resolvePackagePath(root, packagePath);
  const canonicalPath = await realpath(resolvedPath).catch(() => undefined);
  if (!canonicalPath) return undefined;

  const pathWithinPackage = relative(root, canonicalPath);
  if (
    pathWithinPackage.startsWith('..') ||
    isAbsolute(pathWithinPackage) ||
    !(await stat(canonicalPath).catch(() => undefined))?.isFile()
  ) {
    return undefined;
  }

  return canonicalPath;
}

async function readJson(path: string, issuePath: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const message =
      error instanceof SyntaxError ? 'must contain valid JSON' : 'must be a readable file';
    throw new ArtifactPackageContractError([{ path: issuePath, message }]);
  }
}

async function requireFixedResources(root: string) {
  const issues: CliIssue[] = [];
  const resources = await Promise.all(
    fixedResources.map(async (resource): Promise<[string, string | undefined]> => {
      const canonicalPath = await resolvePackageFile(root, resource);
      if (!canonicalPath) {
        issues.push({
          path: `$.files[${JSON.stringify(resource)}]`,
          message: 'must exist as a file inside the Artifact Package',
        });
        return [resource, undefined];
      }
      return [resource, canonicalPath];
    }),
  );
  if (issues.length > 0) throw new ArtifactPackageContractError(issues);
  return Object.fromEntries(resources) as Record<(typeof fixedResources)[number], string>;
}

async function validateArtifactSource(entryPath: string) {
  try {
    const source = await readFile(entryPath, 'utf8');
    const transformed = await transformWithOxc(source, entryPath);
    await initModuleLexer;
    const [, exports] = parseModule(transformed.code);
    if (!exports.some((exported) => exported.n === 'default')) {
      throw new Error('missing default export');
    }
  } catch {
    throw new ArtifactPackageContractError([
      {
        path: '$.exports["."]',
        message: 'must contain valid editable TSX Artifact Source with a default export',
      },
    ]);
  }
}

function isArtifactRenderType(value: unknown) {
  if (typeof value === 'function') return true;
  if (!value || typeof value !== 'object') return false;
  const reactType = (value as { $$typeof?: unknown }).$$typeof;
  return reactType === Symbol.for('react.memo') || reactType === Symbol.for('react.forward_ref');
}

async function smokeRenderArtifactSource(
  artifactRoot: string,
  entryPath: string,
  exampleInput: unknown,
) {
  const runtimeRoot = reactResolutionRoot();
  const cacheDirectory = await mkdtemp(resolve(tmpdir(), 'open-artifacts-smoke-render-'));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  try {
    server = await createServer({
      appType: 'custom',
      cacheDir: cacheDirectory,
      clearScreen: false,
      logLevel: 'silent',
      resolve: { dedupe: ['react', 'react-dom'] },
      root: runtimeRoot,
      server: {
        middlewareMode: true,
        fs: { allow: [artifactRoot, runtimeRoot] },
      },
    });
    const artifactModule = (await server.ssrLoadModule(`/@fs/${normalizePath(entryPath)}`)) as {
      default?: unknown;
    };
    if (!isArtifactRenderType(artifactModule.default)) {
      throw new ArtifactPackageContractError([
        {
          path: '$.exports["."]',
          message: 'default export must be a React component',
        },
      ]);
    }

    try {
      const Render = artifactModule.default as ComponentType<{ data: unknown }>;
      renderToStaticMarkup(createElement(Render, { data: exampleInput }));
    } catch {
      throw new ArtifactPackageContractError([
        {
          path: '$.example',
          message: 'Example Input must complete a smoke Render through the default export',
        },
      ]);
    }
  } catch (error) {
    if (error instanceof ArtifactPackageContractError) throw error;
    throw new ArtifactPackageContractError([
      {
        path: '$.exports["."]',
        message: `default export must load through the public Artifact Source entry${
          error instanceof Error ? `: ${error.message}` : ''
        }`,
      },
    ]);
  } finally {
    await server?.close();
    await rm(cacheDirectory, { force: true, recursive: true });
  }
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
      `Only explicit local Artifact References are currently supported; received: ${reference}`,
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

  const manifestPath = await resolvePackageFile(root, 'package.json');
  if (!manifestPath) {
    throw new ArtifactPackageContractError([
      {
        path: '$.packageJson',
        message: 'must exist as a file inside the Artifact Package',
      },
    ]);
  }
  const manifestValue = await readJson(manifestPath, '$.packageJson');
  if (!validateManifest(manifestValue)) {
    throw new ArtifactPackageContractError(formatValidationIssues(validateManifest.errors));
  }
  const manifest = manifestValue as ArtifactManifest;
  const resources = await requireFixedResources(root);
  await validateArtifactSource(resources['src/index.tsx']);

  const schema = await readJson(resources['input.schema.json'], '$.inputContract');
  if (
    !schema ||
    typeof schema !== 'object' ||
    !('$schema' in schema) ||
    schema.$schema !== inputSchemaDraft
  ) {
    throw new ArtifactPackageContractError([
      { path: '$.inputContract.$schema', message: `must equal ${inputSchemaDraft}` },
    ]);
  }

  let validateInput: ValidateFunction;
  try {
    validateInput = inputAjv.compile(schema as AnySchema);
  } catch (error) {
    throw new ArtifactPackageContractError([
      {
        path: '$.inputContract',
        message: error instanceof Error ? error.message : 'must be a valid JSON Schema',
      },
    ]);
  }
  if ((validateInput as ValidateFunction & { $async?: true }).$async === true) {
    throw new ArtifactPackageContractError([
      {
        path: '$.inputContract.$async',
        message: 'asynchronous Input Contracts are not supported',
      },
    ]);
  }

  const exampleInput = await readJson(resources['example.json'], '$.example');
  const validateResolvedInput = (input: unknown, prefix = '$') => {
    if (validateInput(input)) return [];
    return formatValidationIssues(validateInput.errors, prefix);
  };
  const exampleIssues = validateResolvedInput(exampleInput, '$.example');
  if (exampleIssues.length > 0) throw new ArtifactPackageContractError(exampleIssues);
  await smokeRenderArtifactSource(root, resources['src/index.tsx'], exampleInput);

  return {
    exampleInput,
    identity: {
      entryPath: resources['src/index.tsx'],
      name: manifest.name,
      root,
      version: manifest.version,
    },
    validateInput: validateResolvedInput,
  };
}
