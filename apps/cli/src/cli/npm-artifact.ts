import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import npa from 'npm-package-arg';

import {
  isLocalArtifactReference,
  resolveLocalArtifactPackage,
  type ResolvedArtifactPackage,
} from './artifact-package.js';
import { ArtifactPackageContractError, ArtifactReferenceError } from './errors.js';

const executeFile = promisify(execFile);
const requireFromCli = createRequire(import.meta.url);
const supportedRegistryTypes = new Set(['range', 'tag', 'version']);
const defaultRegistry = 'https://registry.npmjs.org/';
const cacheContentManifestName = 'open-artifacts-content.json';
const cacheLockWaitMilliseconds = 120_000;
const cacheLockHeartbeatMilliseconds = 1_000;
const cacheLockMaximumAgeMilliseconds = 10 * 60_000;
const ownerlessCacheLockGraceMilliseconds = 5_000;
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
  lockGraphDigest: string;
  name: string;
  registry: string;
  resolved: string;
  schemaVersion: 2;
  version: string;
}

interface PackageLock {
  lockfileVersion?: number;
  packages?: Record<
    string,
    {
      integrity?: string;
      resolved?: string;
      version?: string;
    }
  >;
}

interface CacheContentManifest {
  algorithm: 'sha256';
  digest: string;
  schemaVersion: 1;
}

interface CacheGenerationPointer {
  generation: string;
  schemaVersion: 1;
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

function sanitizeResolvedUrl(value: string) {
  try {
    const url = new URL(value);
    // A full Git commit is immutable identity; arbitrary fragments may contain credentials.
    const gitCommit = /^(?:git(?:\+[^:]+)?|ssh):$/.test(url.protocol)
      ? url.hash.slice(1).match(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i)?.[0]
      : undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = gitCommit?.toLowerCase() ?? '';
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
        ? sanitizeResolvedUrl(nestedValue)
        : sanitizeResolvedUrls(nestedValue),
    ]),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalJson(nestedValue)}`)
    .join(',')}}`;
}

export function packageLockGraphDigest(lock: PackageLock) {
  const installedPackages = Object.fromEntries(
    Object.entries(lock.packages ?? {}).filter(([packagePath]) => packagePath !== ''),
  );
  const sanitizedGraph = sanitizeResolvedUrls({
    lockfileVersion: lock.lockfileVersion,
    packages: installedPackages,
  });
  return `sha256:${createHash('sha256').update(canonicalJson(sanitizedGraph)).digest('hex')}`;
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
        lockGraphDigest: provenance.lockGraphDigest,
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

function decodeNpmConfigValue(value: string) {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (quoted) {
    const candidate = trimmed.startsWith("'") ? trimmed.slice(1, -1) : trimmed;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return candidate;
    }
  }

  let escaped = false;
  let decoded = '';
  for (const character of trimmed) {
    if (escaped) {
      decoded += character === ';' || character === '#' ? character : `\\${character}`;
      escaped = false;
    } else if (character === ';' || character === '#') {
      break;
    } else if (character === '\\') {
      escaped = true;
    } else {
      decoded += character;
    }
  }
  if (escaped) decoded += '\\';
  const result = decoded.trim();
  return result === 'true' || result === 'false' || result === 'null'
    ? (JSON.parse(result) as unknown)
    : result;
}

function replaceNpmConfigEnvironment(value: string, environment: NodeJS.ProcessEnv) {
  return value.replace(
    /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g,
    (original, escaping: string, name: string, optional: string | undefined) => {
      if (escaping.length % 2) return original.slice((escaping.length + 1) / 2);
      const replacement = environment[name] ?? (optional ? '' : `\${${name}}`);
      return `${escaping.slice(escaping.length / 2)}${replacement}`;
    },
  );
}

function protectNpmConfigEnvironment(value: string) {
  return value.replace(
    /(\\*)\$\{([^${}?]+)(\?)?\}/g,
    (original, escaping: string) =>
      `${'\\'.repeat(escaping.length * 2 + 1)}${original.slice(escaping.length)}`,
  );
}

function isNpmConfigFilePathKey(key: string) {
  const normalized = key.toLowerCase();
  return (
    normalized === 'cafile' ||
    normalized === 'certfile' ||
    normalized === 'keyfile' ||
    normalized.endsWith(':certfile') ||
    normalized.endsWith(':keyfile')
  );
}

export function absolutizeProjectNpmConfigPaths(
  contents: string,
  configDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const parsedAssignments = new Map<
    string,
    { rawKey: string; value: ReturnType<typeof decodeNpmConfigValue> }
  >();
  let section = false;
  for (const line of contents.split(/[\r\n]+/)) {
    if (!line || /^\s*[;#]/.test(line)) continue;
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) {
      section = true;
      continue;
    }
    if (section) continue;
    const assignment = line.match(/^([^=]+)=(.*)$/);
    if (!assignment) continue;
    const [, rawKey, rawValue] = assignment;
    if (rawKey === undefined || rawValue === undefined) continue;
    const key = decodeNpmConfigValue(rawKey);
    if (typeof key !== 'string') continue;
    parsedAssignments.set(key, { rawKey: rawKey.trim(), value: decodeNpmConfigValue(rawValue) });
  }

  const overrides = new Map<string, string>();
  for (const [key, { rawKey, value }] of parsedAssignments) {
    const effectiveKey = replaceNpmConfigEnvironment(key, environment);
    if (!isNpmConfigFilePathKey(effectiveKey)) continue;
    if (typeof value !== 'string') {
      overrides.delete(effectiveKey);
      continue;
    }

    const expandedValue = replaceNpmConfigEnvironment(value, environment);
    if (isAbsolute(expandedValue) || /^~[\\/]/.test(expandedValue)) {
      overrides.delete(effectiveKey);
      continue;
    }
    const absoluteValue = protectNpmConfigEnvironment(resolve(configDirectory, expandedValue));
    overrides.set(effectiveKey, `${rawKey}=${JSON.stringify(absoluteValue)}`);
  }

  if (overrides.size === 0) return contents;
  const separator = contents.endsWith('\n') || contents.endsWith('\r') ? '' : '\n';
  return `${contents}${separator}${[...overrides.values()].join('\n')}\n`;
}

export function removeProjectNpmWorkspaceSelectors(
  contents: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const parts = contents.split(/(\r\n|\r|\n)/);
  let section = false;

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    if (line === undefined || /^\s*[;#]/.test(line)) continue;
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) {
      section = true;
      continue;
    }
    if (section) continue;

    const assignment = line.match(/^([^=]+)=/);
    const rawKey = assignment?.[1];
    if (rawKey === undefined) continue;
    const key = decodeNpmConfigValue(rawKey);
    if (typeof key !== 'string') continue;
    const effectiveKey = replaceNpmConfigEnvironment(key, environment).toLowerCase();
    if (effectiveKey === 'workspace' || effectiveKey === 'workspace[]') {
      parts[index] = '';
      parts[index + 1] = '';
    }
  }

  return parts.join('');
}

async function copyProjectNpmConfig(root: string, projectConfig: string | undefined) {
  if (!projectConfig) return;
  const contents = await readFile(projectConfig, 'utf8');
  const isolatedContents = removeProjectNpmWorkspaceSelectors(contents);
  await writeFile(
    join(root, '.npmrc'),
    absolutizeProjectNpmConfigPaths(isolatedContents, dirname(projectConfig)),
  );
}

async function runNpm(cwd: string, arguments_: string[]) {
  try {
    const command = npmSubprocessCommand([
      ...arguments_,
      '--legacy-peer-deps=false',
      '--workspaces=false',
      '--include-workspace-root=false',
    ]);
    const environment: NodeJS.ProcessEnv = { ...process.env, ...command.environment };
    for (const key of Object.keys(environment)) {
      if (
        key.toLowerCase() === 'npm_config_workspace' ||
        key.toLowerCase() === 'npm_config_workspace[]' ||
        key.toLowerCase() === 'npm_config_workspaces' ||
        key.toLowerCase() === 'npm_config_include_workspace_root' ||
        key.toLowerCase() === 'npm_config_legacy_peer_deps'
      ) {
        delete environment[key];
      }
    }
    return await executeFile(command.executable, command.arguments, {
      cwd,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    });
  } catch {
    throw new ArtifactReferenceError('Unable to resolve or install the npm Artifact Package');
  }
}

async function configuredRegistry(root: string, reference: NpmArtifactReference) {
  const scope = reference.name.startsWith('@') ? reference.name.split('/')[0] : undefined;
  if (scope) {
    const scopedRegistry = (
      await runNpm(root, ['config', 'get', `${scope}:registry`])
    ).stdout.trim();
    if (scopedRegistry && scopedRegistry !== 'undefined') {
      return sanitizeRegistryUrl(scopedRegistry);
    }
  }
  const registry = (await runNpm(root, ['config', 'get', 'registry'])).stdout.trim();
  return sanitizeRegistryUrl(registry || defaultRegistry);
}

function dependencyPath(name: string) {
  return join('node_modules', ...name.split('/'));
}

export function packageLockDependencyKey(name: string) {
  return `node_modules/${name}`;
}

async function writeResolutionProject(root: string, reference: NpmArtifactReference) {
  const reactPackage = JSON.parse(
    await readFile(requireFromCli.resolve('react/package.json'), 'utf8'),
  ) as { version?: string };
  if (!reactPackage.version) {
    throw new ArtifactReferenceError('OA Runtime React identity is unavailable');
  }
  const dependencies: Record<string, string> = { [reference.name]: reference.selector };
  if (reference.name !== 'react') dependencies.react = reactPackage.version;
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'open-artifacts-resolution',
      private: true,
      version: '0.0.0',
      dependencies,
    })}\n`,
  );
}

async function resolveProvenance(root: string, reference: NpmArtifactReference) {
  await runNpm(root, [
    'install',
    '--package-lock-only',
    '--lockfile-version=3',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ]);

  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as PackageLock;
  const locked = lock.packages?.[packageLockDependencyKey(reference.name)];
  if (!locked?.version || !locked.resolved || !locked.integrity) {
    throw new ArtifactReferenceError('npm did not resolve the Artifact Package immutably');
  }

  return {
    integrity: locked.integrity,
    lockGraphDigest: packageLockGraphDigest(lock),
    name: reference.name,
    registry: await configuredRegistry(root, reference),
    resolved: sanitizeRegistryUrl(locked.resolved),
    schemaVersion: 2,
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
    left.schemaVersion === 2 &&
    left.name === right.name &&
    left.version === right.version &&
    left.integrity === right.integrity &&
    left.lockGraphDigest === right.lockGraphDigest &&
    left.resolved === right.resolved &&
    left.registry === right.registry,
  );
}

async function cacheContentDigest(root: string) {
  const records: Array<Record<string, number | string>> = [];

  async function visit(directory: string, directoryRelativePath = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = directoryRelativePath
        ? `${directoryRelativePath}/${entry.name}`
        : entry.name;
      if (relativePath === cacheContentManifestName) continue;

      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        await visit(path, relativePath);
      } else if (metadata.isSymbolicLink()) {
        records.push({ path: relativePath, target: await readlink(path), type: 'symlink' });
      } else if (metadata.isFile()) {
        const contents = await readFile(path);
        records.push({
          digest: createHash('sha256').update(contents).digest('hex'),
          mode: metadata.mode & 0o777,
          path: relativePath,
          size: metadata.size,
          type: 'file',
        });
      } else {
        records.push({ path: relativePath, type: 'other' });
      }
    }
  }

  await visit(root);
  return createHash('sha256').update(canonicalJson(records)).digest('hex');
}

async function writeCacheContentManifest(cacheEntry: string) {
  const manifest: CacheContentManifest = {
    algorithm: 'sha256',
    digest: await cacheContentDigest(cacheEntry),
    schemaVersion: 1,
  };
  await writeFile(
    join(cacheEntry, cacheContentManifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function hasValidCacheContent(cacheEntry: string) {
  try {
    const manifest = JSON.parse(
      await readFile(join(cacheEntry, cacheContentManifestName), 'utf8'),
    ) as CacheContentManifest;
    return (
      manifest.schemaVersion === 1 &&
      manifest.algorithm === 'sha256' &&
      manifest.digest === (await cacheContentDigest(cacheEntry))
    );
  } catch {
    return false;
  }
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
  if (!(await hasValidCacheContent(canonicalEntry))) return undefined;

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

function cacheGenerationPrefix(cacheKey: string) {
  return `.${cacheKey}.generation-`;
}

function cacheGenerationPointerPath(cacheRoot: string, cacheKey: string) {
  return join(cacheRoot, `.${cacheKey}.current.json`);
}

async function readCacheGeneration(cacheRoot: string, cacheKey: string) {
  try {
    const pointer = JSON.parse(
      await readFile(cacheGenerationPointerPath(cacheRoot, cacheKey), 'utf8'),
    ) as CacheGenerationPointer;
    if (pointer.schemaVersion !== 1 || typeof pointer.generation !== 'string') return undefined;
    if (pointer.generation !== basename(pointer.generation)) return undefined;
    if (!pointer.generation.startsWith(cacheGenerationPrefix(cacheKey))) return undefined;
    const generation = resolve(cacheRoot, pointer.generation);
    return isPathInside(resolve(cacheRoot), generation) ? generation : undefined;
  } catch {
    return undefined;
  }
}

async function publishCacheGeneration(cacheRoot: string, cacheKey: string, generation: string) {
  const pointerPath = cacheGenerationPointerPath(cacheRoot, cacheKey);
  const temporaryPath = `${pointerPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ generation: basename(generation), schemaVersion: 1 })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await rename(temporaryPath, pointerPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function validateCurrentCacheEntry(
  cacheRoot: string,
  cacheKey: string,
  cacheEntry: string,
  provenance: NpmArtifactProvenance,
) {
  const generation = await readCacheGeneration(cacheRoot, cacheKey);
  if (generation) {
    const current = await validateCachedPackage(cacheRoot, generation, provenance);
    if (current) return current;
  }
  return validateCachedPackage(cacheRoot, cacheEntry, provenance);
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
    await copyProjectNpmConfig(installRoot, projectConfig);
    await runNpm(installRoot, [
      'ci',
      '--lockfile-version=3',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ]);
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
    await writeCacheContentManifest(commitRoot);
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

export async function withCacheEntryLock<T>(
  cacheRoot: string,
  cacheKey: string,
  work: () => Promise<T>,
) {
  const lockRoot = join(cacheRoot, `.${cacheKey}.lock`);
  // A claim path is never reused, so stale cleanup and release cannot target a successor owner.
  const ownerToken = `owner-${randomUUID()}`;
  const ownerPath = join(lockRoot, ownerToken);
  const acquiredPath = join(ownerPath, 'acquired');
  const deadline = Date.now() + cacheLockWaitMilliseconds;

  async function readOwner(path: string) {
    return readFile(join(path, 'owner.json'), 'utf8')
      .then(
        (contents) => JSON.parse(contents) as { createdAt?: string; pid?: number; token?: string },
      )
      .catch(() => undefined);
  }

  async function claimIsAlive(claimPath: string, token: string) {
    const [owner, metadata] = await Promise.all([
      readOwner(claimPath),
      stat(claimPath).catch(() => undefined),
    ]);
    if (!metadata) return false;
    const age = Date.now() - metadata.mtimeMs;
    if (age >= cacheLockMaximumAgeMilliseconds) return false;
    if (owner?.token === token && owner.pid && Number.isSafeInteger(owner.pid)) {
      try {
        process.kill(owner.pid, 0);
        return true;
      } catch (error) {
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
      }
    }
    return age < ownerlessCacheLockGraceMilliseconds;
  }

  async function quarantineClaim(token: string) {
    const claimPath = join(lockRoot, token);
    const owner = await readOwner(claimPath);
    if (owner && owner.token !== token) return;

    const quarantinePath = join(cacheRoot, `.${cacheKey}.stale-${token}-${randomUUID()}`);
    try {
      await rename(claimPath, quarantinePath);
      // The claim may have finished publishing its owner while the rename was in flight.
      if (await claimIsAlive(quarantinePath, token)) {
        await rename(quarantinePath, claimPath);
        return;
      }
      await rm(quarantinePath, { force: true, recursive: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  async function activeClaims() {
    const entries = await readdir(lockRoot, { withFileTypes: true });
    const claims: Array<{ acquired: boolean; token: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('owner-')) continue;
      const claimPath = join(lockRoot, entry.name);
      if (!(await claimIsAlive(claimPath, entry.name))) {
        await quarantineClaim(entry.name);
        continue;
      }
      claims.push({
        acquired: Boolean(await stat(join(claimPath, 'acquired')).catch(() => undefined)),
        token: entry.name,
      });
    }
    return claims.sort((left, right) =>
      left.token < right.token ? -1 : left.token > right.token ? 1 : 0,
    );
  }

  async function releaseOwnerClaim() {
    if ((await readOwner(ownerPath))?.token === ownerToken) {
      await rm(ownerPath, { force: true, recursive: true });
    }
    await rmdir(lockRoot).catch((error) => {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')
      )) {
        throw error;
      }
    });
  }

  while (true) {
    await mkdir(lockRoot, { recursive: true });
    try {
      await mkdir(ownerPath);
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  let heartbeat: NodeJS.Timeout | undefined;
  try {
    await writeFile(
      join(ownerPath, 'owner.json'),
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        pid: process.pid,
        token: ownerToken,
      })}\n`,
    );
    heartbeat = setInterval(() => {
      const timestamp = new Date();
      void utimes(ownerPath, timestamp, timestamp).catch(() => undefined);
    }, cacheLockHeartbeatMilliseconds);
    heartbeat.unref();

    while (true) {
      const claims = await activeClaims();
      const ownClaim = claims.find(({ token }) => token === ownerToken);
      if (!ownClaim) {
        throw new ArtifactReferenceError('Lost ownership of the npm Artifact cache lock');
      }
      const anotherOwnerHasLock = claims.some(
        ({ acquired, token }) => acquired && token !== ownerToken,
      );
      if (ownClaim.acquired) {
        if (claims[0]?.token === ownerToken) break;
        await rm(acquiredPath, { force: true });
      } else if (!anotherOwnerHasLock && claims[0]?.token === ownerToken) {
        await writeFile(acquiredPath, `${ownerToken}\n`);
        continue;
      }

      if (Date.now() >= deadline) {
        throw new ArtifactReferenceError('Timed out waiting for the npm Artifact cache lock');
      }
      await delay(25);
    }

    return await work();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await releaseOwnerClaim();
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
    await copyProjectNpmConfig(resolutionRoot, projectConfig);
    const provenance = await resolveProvenance(resolutionRoot, reference);
    const cacheKey = artifactCacheKey(provenance);
    const cacheEntry = join(cacheRoot, cacheKey);
    const cached = await validateCurrentCacheEntry(cacheRoot, cacheKey, cacheEntry, provenance);
    if (cached) return cached;

    return await withCacheEntryLock(cacheRoot, cacheKey, async () => {
      const concurrentlyInstalled = await validateCurrentCacheEntry(
        cacheRoot,
        cacheKey,
        cacheEntry,
        provenance,
      );
      if (concurrentlyInstalled) return concurrentlyInstalled;

      const canonicalEntryExists = Boolean(await lstat(cacheEntry).catch(() => undefined));
      const installationEntry = canonicalEntryExists
        ? join(cacheRoot, `${cacheGenerationPrefix(cacheKey)}${randomUUID()}`)
        : cacheEntry;
      try {
        await installCacheEntry(
          resolutionRoot,
          cacheRoot,
          installationEntry,
          provenance,
          projectConfig,
        );
        const installed = await validateCachedPackage(cacheRoot, installationEntry, provenance);
        if (!installed) {
          throw new ArtifactReferenceError(
            'Installed npm Artifact Package failed cache verification',
          );
        }
        if (installationEntry !== cacheEntry) {
          await publishCacheGeneration(cacheRoot, cacheKey, installationEntry);
        }
        return installed;
      } catch (error) {
        await rm(installationEntry, { force: true, recursive: true });
        throw error;
      }
    });
  } finally {
    await rm(resolutionRoot, { force: true, recursive: true });
  }
}

export function resolveArtifactPackageReference(reference: string, cwd: string) {
  return isLocalArtifactReference(reference)
    ? resolveLocalArtifactPackage(reference, cwd)
    : resolveNpmArtifactPackage(reference, cwd);
}
