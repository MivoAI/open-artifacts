import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import npa from 'npm-package-arg';

import { resolveLocalArtifactPackage, type ResolvedArtifactPackage } from './artifact-package.js';
import { ArtifactPackageContractError, ArtifactReferenceError } from './errors.js';

const executeFile = promisify(execFile);
const supportedRegistryTypes = new Set(['range', 'tag', 'version']);
const defaultRegistry = 'https://registry.npmjs.org/';
const windowsNpmScript = [
  "$ErrorActionPreference = 'Stop'",
  '$npmArguments = @(ConvertFrom-Json -InputObject $env:OA_NPM_ARGUMENTS_JSON)',
  '& npm.cmd @npmArguments',
  'exit $LASTEXITCODE',
].join('; ');

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

export function sanitizeRegistryUrl(value: string) {
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

function sanitizeResolvedUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResolvedUrls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      key === 'resolved' && typeof nestedValue === 'string'
        ? sanitizeRegistryUrl(nestedValue)
        : sanitizeResolvedUrls(nestedValue),
    ]),
  );
}

async function sanitizePackageLock(path: string) {
  const lock = JSON.parse(await readFile(path, 'utf8')) as unknown;
  await writeFile(path, `${JSON.stringify(sanitizeResolvedUrls(lock), null, 2)}\n`);
}

export function npmSubprocessCommand(
  arguments_: string[],
  platform: NodeJS.Platform = process.platform,
  windowsPowerShell = 'powershell.exe',
) {
  return platform === 'win32'
    ? {
        arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsNpmScript],
        environment: { OA_NPM_ARGUMENTS_JSON: JSON.stringify(arguments_) },
        executable: windowsPowerShell,
      }
    : { arguments: arguments_, environment: {}, executable: 'npm' };
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

async function findProjectNpmConfig(invocationCwd: string) {
  const userHome = resolve(homedir());
  const userConfigPaths = new Set(
    [process.env.NPM_CONFIG_USERCONFIG, process.env.npm_config_userconfig, join(userHome, '.npmrc')]
      .filter((path): path is string => Boolean(path))
      .map((path) => resolve(path)),
  );
  let directory = resolve(invocationCwd);

  while (directory !== userHome) {
    const configPath = join(directory, '.npmrc');
    if (userConfigPaths.has(resolve(configPath))) return undefined;
    if ((await stat(configPath).catch(() => undefined))?.isFile()) return configPath;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return undefined;
}

function npmEnvironment(projectConfig: string | undefined) {
  if (!projectConfig) return process.env;
  const environment = { ...process.env };
  const originalUserConfig =
    environment.NPM_CONFIG_USERCONFIG ??
    environment.npm_config_userconfig ??
    join(homedir(), '.npmrc');
  delete environment.NPM_CONFIG_GLOBALCONFIG;
  delete environment.NPM_CONFIG_USERCONFIG;
  delete environment.npm_config_globalconfig;
  delete environment.npm_config_userconfig;
  environment.NPM_CONFIG_GLOBALCONFIG = originalUserConfig;
  environment.NPM_CONFIG_USERCONFIG = projectConfig;
  return environment;
}

async function runNpm(cwd: string, arguments_: string[], projectConfig?: string) {
  try {
    const command = npmSubprocessCommand(arguments_);
    return await executeFile(command.executable, command.arguments, {
      cwd,
      encoding: 'utf8',
      env: { ...npmEnvironment(projectConfig), ...command.environment },
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
  } catch {
    throw new ArtifactReferenceError('Unable to resolve or install the npm Artifact Package');
  }
}

async function configuredRegistry(
  root: string,
  reference: NpmArtifactReference,
  projectConfig?: string,
) {
  const scope = reference.name.startsWith('@') ? reference.name.split('/')[0] : undefined;
  if (scope) {
    const scopedRegistry = (
      await runNpm(root, ['config', 'get', `${scope}:registry`], projectConfig)
    ).stdout.trim();
    if (scopedRegistry && scopedRegistry !== 'undefined') {
      return sanitizeRegistryUrl(scopedRegistry);
    }
  }
  const registry = (await runNpm(root, ['config', 'get', 'registry'], projectConfig)).stdout.trim();
  return sanitizeRegistryUrl(registry || defaultRegistry);
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

async function resolveProvenance(
  root: string,
  reference: NpmArtifactReference,
  projectConfig?: string,
) {
  await runNpm(
    root,
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ],
    projectConfig,
  );

  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as PackageLock;
  const locked = lock.packages?.[dependencyPath(reference.name)];
  if (!locked?.version || !locked.resolved || !locked.integrity) {
    throw new ArtifactReferenceError('npm did not resolve the Artifact Package immutably');
  }

  return {
    integrity: locked.integrity,
    name: reference.name,
    registry: await configuredRegistry(root, reference, projectConfig),
    resolved: sanitizeRegistryUrl(locked.resolved),
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
  projectConfig?: string,
) {
  const installRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-install-'));
  let commitRoot: string | undefined;
  try {
    await writeFile(
      join(installRoot, 'package.json'),
      await readFile(join(resolutionRoot, 'package.json')),
    );
    await writeFile(
      join(installRoot, 'package-lock.json'),
      await readFile(join(resolutionRoot, 'package-lock.json')),
    );
    await runNpm(
      installRoot,
      ['ci', '--ignore-scripts', '--legacy-peer-deps', '--omit=dev', '--no-audit', '--no-fund'],
      projectConfig,
    );
    const installedLockPath = join(installRoot, 'package-lock.json');
    await Promise.all([
      sanitizePackageLock(installedLockPath),
      sanitizePackageLock(join(installRoot, 'node_modules', '.package-lock.json')),
    ]);
    await writeFile(
      join(installRoot, 'open-artifacts-provenance.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );

    commitRoot = await mkdtemp(join(cacheRoot, '.commit-'));
    await Promise.all([
      cp(join(installRoot, 'node_modules'), join(commitRoot, 'node_modules'), { recursive: true }),
      writeFile(
        join(commitRoot, 'package.json'),
        await readFile(join(installRoot, 'package.json')),
      ),
      writeFile(join(commitRoot, 'package-lock.json'), await readFile(installedLockPath)),
      writeFile(
        join(commitRoot, 'open-artifacts-provenance.json'),
        await readFile(join(installRoot, 'open-artifacts-provenance.json')),
      ),
    ]);
    await validateCachedPackage(cacheRoot, commitRoot, provenance).then((artifactPackage) => {
      if (!artifactPackage) throw new Error('staged npm Artifact Package is not contained');
    });

    try {
      await rename(commitRoot, cacheEntry);
      commitRoot = undefined;
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
    await Promise.all([
      rm(installRoot, { force: true, recursive: true }),
      commitRoot ? rm(commitRoot, { force: true, recursive: true }) : Promise.resolve(),
    ]);
  }
}

export async function resolveNpmArtifactPackage(
  referenceValue: string,
  invocationCwd = process.cwd(),
): Promise<ResolvedArtifactPackage> {
  const reference = parseNpmArtifactReference(referenceValue);
  const projectConfig = await findProjectNpmConfig(invocationCwd);
  const cacheRoot = join(homedir(), '.open-artifacts', 'cache', 'artifacts');
  await mkdir(cacheRoot, { recursive: true });
  const resolutionRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-resolve-'));

  try {
    await writeResolutionProject(resolutionRoot, reference);
    const provenance = await resolveProvenance(resolutionRoot, reference, projectConfig);
    const cacheEntry = join(cacheRoot, artifactCacheKey(provenance));
    const cached = await validateCachedPackage(cacheRoot, cacheEntry, provenance);
    if (cached) return cached;

    await rm(cacheEntry, { force: true, recursive: true });
    await installCacheEntry(resolutionRoot, cacheRoot, cacheEntry, provenance, projectConfig);
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
    : resolveNpmArtifactPackage(reference, cwd);
}
