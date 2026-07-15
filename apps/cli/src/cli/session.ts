import { execFile } from 'node:child_process';
import { readdir, readFile, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { ArtifactIdentity } from '../runtime/config.js';
import { CliError } from './errors.js';

const execFileAsync = promisify(execFile);
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProcessSignature {
  command: string;
  owner: string;
  startedAt: string;
}

export interface SessionRecord {
  artifact: ArtifactIdentity;
  instanceId: string;
  pid: number;
  processSignature: ProcessSignature;
  sessionId: string;
  startedAt: string;
  url: string;
}

export interface ActiveSession {
  artifact: Omit<ArtifactIdentity, 'entryPath'>;
  sessionId: string;
  startedAt: string;
  status: 'active';
  url: string;
}

interface SessionCommandOptions {
  json: boolean;
}

type SessionLifecycleErrorCode =
  'ARTIFACT_SESSION_NOT_FOUND' | 'ARTIFACT_SESSION_OWNERSHIP_MISMATCH';

export class SessionLifecycleError extends CliError {
  constructor(code: SessionLifecycleErrorCode, message: string) {
    super(code, 'session', message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLoopbackSessionUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.port !== ''
    );
  } catch {
    return false;
  }
}

export function parseSessionRecord(value: unknown): SessionRecord | undefined {
  if (!isRecord(value) || !isRecord(value.artifact) || !isRecord(value.processSignature)) {
    return undefined;
  }

  const artifact = value.artifact;
  const signature = value.processSignature;
  if (
    !isNonEmptyString(artifact.entryPath) ||
    !isNonEmptyString(artifact.name) ||
    !isNonEmptyString(artifact.root) ||
    !isNonEmptyString(artifact.version) ||
    !isNonEmptyString(value.instanceId) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !isNonEmptyString(signature.command) ||
    !isNonEmptyString(signature.owner) ||
    !isNonEmptyString(signature.startedAt) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.startedAt) ||
    Number.isNaN(Date.parse(value.startedAt as string)) ||
    !isLoopbackSessionUrl(value.url)
  ) {
    return undefined;
  }

  return value as unknown as SessionRecord;
}

export function parseProcessSignatureOutput(output: string): ProcessSignature | undefined {
  const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s+(.+?)\s*$/.exec(output);
  if (!match) return undefined;

  const [, uidText, startedAt, command] = match;
  if (!uidText || !startedAt || !command) return undefined;
  const uid = Number(uidText);
  if (!Number.isSafeInteger(uid) || uid < 0) return undefined;
  return { command, owner: String(uid), startedAt };
}

export function parseWindowsProcessSignatureOutput(output: string): ProcessSignature | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (
      !isRecord(value) ||
      !isNonEmptyString(value.CommandLine) ||
      !isNonEmptyString(value.CreationDate) ||
      !isNonEmptyString(value.OwnerSid)
    ) {
      return undefined;
    }
    return {
      command: value.CommandLine,
      owner: value.OwnerSid,
      startedAt: value.CreationDate,
    };
  } catch {
    return undefined;
  }
}

export async function readProcessSignature(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessSignature | undefined> {
  try {
    if (platform === 'win32') {
      const script = [
        `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
        'if ($null -eq $process) { exit 1 }',
        '$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid',
        '[pscustomobject]@{ CommandLine = $process.CommandLine; CreationDate = $process.CreationDate; OwnerSid = $owner.Sid } | ConvertTo-Json -Compress',
      ].join('; ');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8' },
      );
      return parseWindowsProcessSignatureOutput(stdout);
    }

    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      },
    );
    return parseProcessSignatureOutput(stdout);
  } catch {
    return undefined;
  }
}

function signaturesMatch(left: ProcessSignature, right: ProcessSignature) {
  return (
    left.command === right.command &&
    left.owner === right.owner &&
    left.startedAt === right.startedAt
  );
}

export function healthMatchesRecord(record: SessionRecord, health: unknown): boolean {
  return (
    isRecord(health) &&
    health.artifact === record.artifact.name &&
    health.instanceId === record.instanceId &&
    health.sessionId === record.sessionId &&
    health.status === 'active'
  );
}

async function readHealth(record: SessionRecord): Promise<unknown> {
  try {
    const response = await fetch(new URL('__oa/health', record.url), {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

function sessionsRoot() {
  return resolve(homedir(), '.open-artifacts', 'sessions');
}

function sessionDirectory(sessionId: string) {
  return resolve(sessionsRoot(), sessionId);
}

async function removeSessionDirectory(sessionId: string) {
  await rm(sessionDirectory(sessionId), { force: true, recursive: true });
}

async function removeSessionRecord(sessionId: string) {
  await unlink(resolve(sessionDirectory(sessionId), 'record.json')).catch(() => undefined);
}

async function loadSessionRecord(sessionId: string): Promise<SessionRecord | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(resolve(sessionDirectory(sessionId), 'record.json'), 'utf8'),
    );
    const record = parseSessionRecord(value);
    return record?.sessionId === sessionId ? record : undefined;
  } catch {
    return undefined;
  }
}

async function verifyOwnedProcess(record: SessionRecord) {
  const signature = await readProcessSignature(record.pid);
  return Boolean(signature && signaturesMatch(record.processSignature, signature));
}

async function verifyOwnedActiveSession(record: SessionRecord) {
  const [ownedProcess, health] = await Promise.all([
    verifyOwnedProcess(record),
    readHealth(record),
  ]);
  return ownedProcess && healthMatchesRecord(record, health);
}

function activeSessionFromRecord(record: SessionRecord): ActiveSession {
  return {
    artifact: {
      name: record.artifact.name,
      root: record.artifact.root,
      version: record.artifact.version,
    },
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    status: 'active',
    url: record.url,
  };
}

export async function findActiveSessions(): Promise<ActiveSession[]> {
  const entries = await readdir(sessionsRoot(), { withFileTypes: true }).catch(() => []);
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const record = await loadSessionRecord(entry.name);
        if (!record || !(await verifyOwnedActiveSession(record))) {
          await removeSessionRecord(entry.name);
          return undefined;
        }
        return activeSessionFromRecord(record);
      }),
  );

  return sessions
    .filter((session): session is ActiveSession => session !== undefined)
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );
}

export async function listArtifactSessions(options: SessionCommandOptions) {
  const sessions = await findActiveSessions();
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ sessions })}\n`);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write('No Active Artifact Sessions.\n');
    return;
  }

  const lines = sessions.flatMap((session) => [
    session.sessionId,
    `  ${session.artifact.name}@${session.artifact.version}`,
    `  ${session.url}`,
    `  active · started ${session.startedAt}`,
  ]);
  process.stdout.write(`Active Artifact Sessions\n${lines.join('\n')}\n`);
}

async function waitUntilProcessChanges(record: SessionRecord, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const signature = await readProcessSignature(record.pid);
    if (!signature || !signaturesMatch(record.processSignature, signature)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return false;
}

export async function stopArtifactSession(sessionId: string, options: SessionCommandOptions) {
  if (!sessionIdPattern.test(sessionId)) {
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_NOT_FOUND',
      `Unknown Artifact Session: ${sessionId}`,
    );
  }

  const record = await loadSessionRecord(sessionId);
  if (!record) {
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_NOT_FOUND',
      `Unknown Artifact Session: ${sessionId}`,
    );
  }
  if (!(await verifyOwnedProcess(record))) {
    await removeSessionRecord(sessionId);
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
      `Process ${record.pid} no longer belongs to this Artifact Session: ${sessionId}`,
    );
  }

  const signalSignature = await readProcessSignature(record.pid);
  if (!signalSignature || !signaturesMatch(record.processSignature, signalSignature)) {
    await removeSessionRecord(sessionId);
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
      `Process ${record.pid} no longer belongs to this Artifact Session: ${sessionId}`,
    );
  }

  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }

  if (!(await waitUntilProcessChanges(record, 3_000))) {
    const signature = await readProcessSignature(record.pid);
    if (signature && signaturesMatch(record.processSignature, signature)) {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await waitUntilProcessChanges(record, 1_000);
    }
  }

  await removeSessionDirectory(sessionId);
  const result = { sessionId, status: 'stopped' as const };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result)}\n`
      : `Stopped Artifact Session ${result.sessionId}.\n`,
  );
}
