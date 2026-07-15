import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';

import npa from 'npm-package-arg';

import { resolveLocalArtifactPackage, type ResolvedArtifactPackage } from './artifact-package.js';
import { ArtifactPackageContractError, ArtifactReferenceError } from './errors.js';

const executeFile = promisify(execFile);
const supportedRegistryTypes = new Set(['range', 'tag', 'version']);
const defaultRegistry = 'https://registry.npmjs.org/';

export interface NpmArtifactReference {
  name: string;
  selector: string;
  type: 'range' | 'tag' | 'version';
}

export interface NpmArtifactProvenance {
  integrity: string;
  name: string;
  registry: string;
  resolved: string;
  schemaVersion: 1;
  version: string;
}

interface PackageLock {
  packages?: Record<
    string,
    {
      integrity?: string;
      resolved?: string;
      version?: string;
    }
  >;
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return 'invalid-url';
  }
}

function configuredRegistry() {
  return safeUrl(
    process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? defaultRegistry,
  );
}

export function parseNpmArtifactReference(reference: string): NpmArtifactReference {
  let parsed: npa.Result;
  try {
    parsed = npa(reference);
  } catch {
    throw new ArtifactReferenceError(
      'npm Artifact Reference must be a registry package name, tag, range, or exact version',
    );
  }

  if (!parsed.name || !parsed.registry || !supportedRegistryTypes.has(parsed.type)) {
    throw new ArtifactReferenceError(
      'npm Artifact Reference must be a registry package name, tag, range, or exact version',
    );
  }

  const isBarePackageName = parsed.raw === parsed.name;
  return {
    name: parsed.name,
    selector: isBarePackageName ? 'latest' : parsed.rawSpec,
    type: isBarePackageName ? 'tag' : (parsed.type as NpmArtifactReference['type']),
  };
}

export function artifactCacheKey(provenance: NpmArtifactProvenance) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        integrity: provenance.integrity,
        name: provenance.name,
        registry: provenance.registry,
        resolved: provenance.resolved,
        version: provenance.version,
      }),
    )
    .digest('hex');
}

async function runNpm(cwd: string, arguments_: string[]) {
  try {
    await executeFile('npm', arguments_, {
      cwd,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
  } catch {
    throw new ArtifactReferenceError('Unable to resolve or install the npm Artifact Package');
  }
}

function dependencyPath(name: string) {
  return join('node_modules', ...name.split('/'));
}

async function writeResolutionProject(root: string, reference: NpmArtifactReference) {
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'open-artifacts-resolution',
      private: true,
      version: '0.0.0',
      dependencies: { [reference.name]: reference.selector },
    })}\n`,
  );
}

async function resolveProvenance(root: string, reference: NpmArtifactReference) {
  await runNpm(root, [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ]);

  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as PackageLock;
  const locked = lock.packages?.[dependencyPath(reference.name)];
  if (!locked?.version || !locked.resolved || !locked.integrity) {
    throw new ArtifactReferenceError('npm did not resolve the Artifact Package immutably');
  }

  return {
    integrity: locked.integrity,
    name: reference.name,
    registry: configuredRegistry(),
    resolved: safeUrl(locked.resolved),
    schemaVersion: 1,
    version: locked.version,
  } satisfies NpmArtifactProvenance;
}

function isPathInside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

async function readCachedProvenance(cacheEntry: string) {
  try {
    return JSON.parse(
      await readFile(join(cacheEntry, 'open-artifacts-provenance.json'), 'utf8'),
    ) as NpmArtifactProvenance;
  } catch {
    return undefined;
  }
}

function sameProvenance(left: NpmArtifactProvenance | undefined, right: NpmArtifactProvenance) {
  return Boolean(
    left &&
    left.schemaVersion === 1 &&
    left.name === right.name &&
    left.version === right.version &&
    left.integrity === right.integrity &&
    left.resolved === right.resolved &&
    left.registry === right.registry,
  );
}

async function validateCachedPackage(
  cacheRoot: string,
  cacheEntry: string,
  provenance: NpmArtifactProvenance,
): Promise<ResolvedArtifactPackage | undefined> {
  const canonicalCacheRoot = await realpath(cacheRoot);
  const canonicalEntry = await realpath(cacheEntry).catch(() => undefined);
  if (!canonicalEntry || !isPathInside(canonicalCacheRoot, canonicalEntry)) return undefined;
  if (!(await stat(canonicalEntry).catch(() => undefined))?.isDirectory()) return undefined;

  const cachedProvenance = await readCachedProvenance(canonicalEntry);
  if (!sameProvenance(cachedProvenance, provenance)) return undefined;

  const packageRoot = await realpath(join(canonicalEntry, dependencyPath(provenance.name))).catch(
    () => undefined,
  );
  if (!packageRoot || !isPathInside(canonicalEntry, packageRoot)) return undefined;

  const artifactPackage = await resolveLocalArtifactPackage(packageRoot, canonicalEntry, {
    dependencyRoot: canonicalEntry,
  });
  if (
    artifactPackage.identity.name !== provenance.name ||
    artifactPackage.identity.version !== provenance.version
  ) {
    throw new ArtifactPackageContractError([
      {
        message: `must equal resolved package ${provenance.name}@${provenance.version}`,
        path: '$.name',
      },
    ]);
  }
  return artifactPackage;
}

async function installCacheEntry(
  resolutionRoot: string,
  cacheRoot: string,
  cacheEntry: string,
  provenance: NpmArtifactProvenance,
) {
  const staging = await mkdtemp(join(cacheRoot, '.staging-'));
  try {
    await writeFile(
      join(staging, 'package.json'),
      await readFile(join(resolutionRoot, 'package.json')),
    );
    await writeFile(
      join(staging, 'package-lock.json'),
      await readFile(join(resolutionRoot, 'package-lock.json')),
    );
    await runNpm(staging, [
      'ci',
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ]);
    await writeFile(
      join(staging, 'open-artifacts-provenance.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    await validateCachedPackage(cacheRoot, staging, provenance).then((artifactPackage) => {
      if (!artifactPackage) throw new Error('staged npm Artifact Package is not contained');
    });

    try {
      await rename(staging, cacheEntry);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
      )) {
        throw error;
      }
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

export async function resolveNpmArtifactPackage(
  referenceValue: string,
): Promise<ResolvedArtifactPackage> {
  const reference = parseNpmArtifactReference(referenceValue);
  const cacheRoot = join(homedir(), '.open-artifacts', 'cache', 'artifacts');
  await mkdir(cacheRoot, { recursive: true });
  const resolutionRoot = await mkdtemp(join(cacheRoot, '.resolve-'));

  try {
    await writeResolutionProject(resolutionRoot, reference);
    const provenance = await resolveProvenance(resolutionRoot, reference);
    const cacheEntry = join(cacheRoot, artifactCacheKey(provenance));
    const cached = await validateCachedPackage(cacheRoot, cacheEntry, provenance);
    if (cached) return cached;

    await rm(cacheEntry, { force: true, recursive: true });
    await installCacheEntry(resolutionRoot, cacheRoot, cacheEntry, provenance);
    const installed = await validateCachedPackage(cacheRoot, cacheEntry, provenance);
    if (!installed) {
      await rm(cacheEntry, { force: true, recursive: true });
      throw new ArtifactReferenceError('Installed npm Artifact Package failed cache verification');
    }
    return installed;
  } finally {
    await rm(resolutionRoot, { force: true, recursive: true });
  }
}

export function isLocalArtifactReference(reference: string) {
  return (
    isAbsolute(reference) ||
    reference === '.' ||
    reference === '..' ||
    reference.startsWith('./') ||
    reference.startsWith('../')
  );
}

export function resolveArtifactPackageReference(reference: string, cwd: string) {
  return isLocalArtifactReference(reference)
    ? resolveLocalArtifactPackage(reference, cwd)
    : resolveNpmArtifactPackage(reference);
}
