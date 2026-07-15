import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { ArtifactIdentity, RuntimeReadyState } from '../runtime/config.js';
import { CliError } from './errors.js';

const execFileAsync = promisify(execFile);
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const processQueryTimeoutMs = 500;
const healthTimeoutMs = 750;
const gracefulShutdownTimeoutMs = 3_000;
const forceShutdownTimeoutMs = 1_000;

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
  | 'ARTIFACT_SESSION_NOT_FOUND'
  | 'ARTIFACT_SESSION_OWNERSHIP_MISMATCH'
  | 'ARTIFACT_SESSION_STOP_FAILED';

export type ProcessSignatureState =
  | { signature: ProcessSignature; status: 'found' }
  | { status: 'missing' }
  | { status: 'unavailable' };

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

export function parseRuntimeReadyState(value: unknown): RuntimeReadyState | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.instanceId) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !isLoopbackSessionUrl(value.url)
  ) {
    return undefined;
  }
  return value as unknown as RuntimeReadyState;
}

export function readyMatchesRecord(record: SessionRecord, ready: RuntimeReadyState): boolean {
  return (
    ready.instanceId === record.instanceId && ready.pid === record.pid && ready.url === record.url
  );
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

export function parseLinuxProcessSignature(
  statOutput: string,
  statusOutput: string,
  commandOutput: string,
): ProcessSignature | undefined {
  const commandEnd = statOutput.lastIndexOf(')');
  if (commandEnd < 0) return undefined;

  const statFields = statOutput
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startedAt = statFields[19];
  const owner = /^Uid:\s+(\d+)(?:\s|$)/m.exec(statusOutput)?.[1];
  const command = commandOutput.replace(/\0$/, '');
  if (!startedAt || !owner || !command) return undefined;

  return { command, owner, startedAt: `linux:${startedAt}` };
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

export function remainingTimeout(deadline: number, now = Date.now()): number {
  return Math.max(0, deadline - now);
}

export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  if (timeoutMs <= 0) return undefined;
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolveTimeout) => {
        timeoutId = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function readLinuxProcessSignature(pid: number, timeoutMs: number) {
  const outputs = await settleWithin(
    Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
    ]),
    timeoutMs,
  );
  if (!outputs) return undefined;
  const [statOutput, statusOutput, commandOutput] = outputs;
  return parseLinuxProcessSignature(statOutput, statusOutput, commandOutput);
}

export function processQueryFailure(error: unknown): 'missing' | 'unavailable' {
  const processError = error as NodeJS.ErrnoException & {
    killed?: boolean;
    stderr?: string;
    stdout?: string;
  };
  if (processError.code === 'ETIMEDOUT' || processError.killed) return 'unavailable';
  if (processError.code === 'ENOENT') return 'unavailable';
  if (processError.code === 'ESRCH') return 'missing';
  const standardOutput = (processError.stdout ?? '').trim();
  const standardError = (processError.stderr ?? '').trim();
  const explicitMissingProcess = /(?:no such process|process id too large|process not found)/i.test(
    standardError,
  );
  return Number(processError.code) === 1 &&
    standardOutput === '' &&
    (standardError === '' || explicitMissingProcess)
    ? 'missing'
    : 'unavailable';
}

export async function readProcessSignatureState(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = processQueryTimeoutMs,
): Promise<ProcessSignatureState> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  try {
    if (platform === 'win32') {
      const script = [
        `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
        'if ($null -eq $process) { exit 1 }',
        '$owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid',
        '[pscustomobject]@{ CommandLine = $process.CommandLine; CreationDate = $process.CreationDate; OwnerSid = $owner.Sid } | ConvertTo-Json -Compress',
      ].join('; ');
      const timeout = remainingTimeout(deadline);
      const result = await settleWithin(
        execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          timeout,
        }),
        timeout,
      );
      if (!result) return { status: 'unavailable' };
      const signature = parseWindowsProcessSignatureOutput(result.stdout);
      return signature ? { signature, status: 'found' } : { status: 'unavailable' };
    }

    if (platform === 'linux') {
      try {
        const signature = await readLinuxProcessSignature(pid, remainingTimeout(deadline));
        if (signature) return { signature, status: 'found' };
        if (remainingTimeout(deadline) === 0) return { status: 'unavailable' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const [procSelfStat, processDirectory] = await Promise.all([
            stat('/proc/self/stat').catch(() => undefined),
            stat(`/proc/${pid}`).catch(() => undefined),
          ]);
          if (procSelfStat?.isFile() && !processDirectory) return { status: 'missing' };
        }
        // Fall back to a ps implementation available through PATH.
      }
    }

    const timeout = remainingTimeout(deadline);
    if (timeout === 0) return { status: 'unavailable' };

    const result = await settleWithin(
      execFileAsync(
        'ps',
        ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          timeout,
        },
      ),
      timeout,
    );
    if (!result) return { status: 'unavailable' };
    const signature = parseProcessSignatureOutput(result.stdout);
    return signature ? { signature, status: 'found' } : { status: 'missing' };
  } catch (error) {
    return { status: processQueryFailure(error) };
  }
}

export async function readProcessSignature(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = processQueryTimeoutMs,
): Promise<ProcessSignature | undefined> {
  const state = await readProcessSignatureState(pid, platform, timeoutMs);
  return state.status === 'found' ? state.signature : undefined;
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

async function readHealth(record: SessionRecord) {
  let response: Response;
  try {
    response = await fetch(new URL('__oa/health', record.url), {
      signal: AbortSignal.timeout(healthTimeoutMs),
    });
  } catch {
    return { status: 'unreachable' as const };
  }

  if (!response.ok) return { status: 'mismatch' as const };
  try {
    const health: unknown = await response.json();
    return {
      status: healthMatchesRecord(record, health) ? ('matching' as const) : ('mismatch' as const),
    };
  } catch {
    return { status: 'mismatch' as const };
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

export async function publishJsonAtomically(path: string, value: unknown) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export type RuntimeReadyStateRead =
  { ready: RuntimeReadyState; status: 'found' } | { status: 'invalid' | 'missing' | 'unavailable' };

export async function readRuntimeReadyStateState(
  path: string,
  read: (path: string) => Promise<string> = (readyPath) => readFile(readyPath, 'utf8'),
): Promise<RuntimeReadyStateRead> {
  try {
    const value: unknown = JSON.parse(await read(path));
    const ready = parseRuntimeReadyState(value);
    return ready ? { ready, status: 'found' } : { status: 'invalid' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    if (error instanceof SyntaxError) return { status: 'invalid' };
    return { status: 'unavailable' };
  }
}

export async function readRuntimeReadyState(path: string): Promise<RuntimeReadyState | undefined> {
  const state = await readRuntimeReadyStateState(path);
  return state.status === 'found' ? state.ready : undefined;
}

async function loadRuntimeReadyState(sessionId: string) {
  return readRuntimeReadyStateState(resolve(sessionDirectory(sessionId), 'ready.json'));
}

type SessionRecordRead =
  { record: SessionRecord; status: 'found' } | { status: 'invalid' | 'missing' | 'unavailable' };

async function loadSessionRecord(sessionId: string): Promise<SessionRecordRead> {
  try {
    const value: unknown = JSON.parse(
      await readFile(resolve(sessionDirectory(sessionId), 'record.json'), 'utf8'),
    );
    const record = parseSessionRecord(value);
    return record?.sessionId === sessionId ? { record, status: 'found' } : { status: 'invalid' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    if (error instanceof SyntaxError) return { status: 'invalid' };
    return { status: 'unavailable' };
  }
}

async function inspectSession(record: SessionRecord) {
  const processState = await readProcessSignatureState(record.pid);
  if (processState.status === 'missing') return { status: 'prune' as const };
  if (processState.status === 'unavailable') return { status: 'hidden' as const };
  if (!signaturesMatch(record.processSignature, processState.signature)) {
    return { status: 'prune' as const };
  }

  const readyState = await loadRuntimeReadyState(record.sessionId);
  if (readyState.status === 'unavailable') return { status: 'hidden' as const };
  if (readyState.status !== 'found' || !readyMatchesRecord(record, readyState.ready)) {
    return { status: 'prune' as const };
  }
  const health = await readHealth(record);
  return { status: health.status === 'matching' ? ('active' as const) : ('hidden' as const) };
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
        const recordState = await loadSessionRecord(entry.name);
        if (recordState.status === 'invalid') {
          await removeSessionRecord(entry.name);
          return undefined;
        }
        if (recordState.status !== 'found') return undefined;
        const inspection = await inspectSession(recordState.record);
        if (inspection.status === 'prune') {
          await removeSessionRecord(entry.name);
          return undefined;
        }
        if (inspection.status === 'hidden') return undefined;
        return activeSessionFromRecord(recordState.record);
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

type ProcessStateReader = (pid: number, timeoutMs: number) => Promise<ProcessSignatureState>;

async function readProcessStateWithin(
  pid: number,
  deadline: number,
  readState: ProcessStateReader,
): Promise<ProcessSignatureState> {
  const timeout = Math.min(processQueryTimeoutMs, remainingTimeout(deadline));
  if (timeout === 0) return { status: 'unavailable' };
  return (
    (await settleWithin(readState(pid, timeout), timeout)) ?? { status: 'unavailable' as const }
  );
}

export async function waitUntilProcessChanges(
  record: SessionRecord,
  deadline: number,
  readState: ProcessStateReader = (pid, timeoutMs) =>
    readProcessSignatureState(pid, process.platform, timeoutMs),
) {
  while (remainingTimeout(deadline) > 0) {
    const state = await readProcessStateWithin(record.pid, deadline, readState);
    if (state.status === 'missing') return true;
    if (state.status === 'found' && !signaturesMatch(record.processSignature, state.signature)) {
      return true;
    }
    const delay = Math.min(50, remainingTimeout(deadline));
    if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  return false;
}

export async function requestRuntimeShutdown(
  ready: RuntimeReadyState,
  token: string | undefined,
  timeoutMs = healthTimeoutMs,
) {
  if (!token || timeoutMs <= 0) return false;
  try {
    const response = await fetch(new URL('__oa/shutdown', ready.url), {
      headers: { authorization: `Bearer ${token}` },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status === 202;
  } catch {
    return false;
  }
}

async function readInstanceToken(sessionId: string) {
  try {
    const token = (
      await readFile(resolve(sessionDirectory(sessionId), 'instance.secret'), 'utf8')
    ).trim();
    return /^[0-9a-f]{64}$/i.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

interface StopRuntimeOptions {
  forceTimeoutMs?: number;
  gracefulTimeoutMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
  readState?: ProcessStateReader;
  requestShutdown?: typeof requestRuntimeShutdown;
}

export async function stopOwnedRuntimeProcess(
  record: SessionRecord,
  ready: RuntimeReadyState,
  token: string | undefined,
  options: StopRuntimeOptions = {},
) {
  const readState =
    options.readState ??
    ((pid: number, timeoutMs: number) =>
      readProcessSignatureState(pid, process.platform, timeoutMs));
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const platform = options.platform ?? process.platform;
  const gracefulDeadline = Date.now() + (options.gracefulTimeoutMs ?? gracefulShutdownTimeoutMs);
  if (platform === 'win32') {
    const shutdownTimeout = Math.min(healthTimeoutMs, remainingTimeout(gracefulDeadline));
    await settleWithin(
      (options.requestShutdown ?? requestRuntimeShutdown)(ready, token, shutdownTimeout),
      shutdownTimeout,
    );
  } else {
    const signalState = await readProcessStateWithin(record.pid, gracefulDeadline, readState);
    if (signalState.status === 'missing') return true;
    if (signalState.status === 'unavailable') return false;
    if (!signaturesMatch(record.processSignature, signalState.signature)) return true;
    try {
      kill(record.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  }

  if (await waitUntilProcessChanges(record, gracefulDeadline, readState)) return true;

  const signalState = await readProcessStateWithin(
    record.pid,
    Date.now() + processQueryTimeoutMs,
    readState,
  );
  if (signalState.status === 'missing') return true;
  if (signalState.status === 'unavailable') return false;
  if (!signaturesMatch(record.processSignature, signalState.signature)) return true;

  try {
    kill(record.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }

  return waitUntilProcessChanges(
    record,
    Date.now() + (options.forceTimeoutMs ?? forceShutdownTimeoutMs),
    readState,
  );
}

export async function stopArtifactSession(sessionId: string, options: SessionCommandOptions) {
  if (!sessionIdPattern.test(sessionId)) {
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_NOT_FOUND',
      `Unknown Artifact Session: ${sessionId}`,
    );
  }

  const recordState = await loadSessionRecord(sessionId);
  if (recordState.status === 'unavailable') {
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_STOP_FAILED',
      `Artifact Session ${sessionId} ownership state is temporarily unavailable`,
    );
  }
  if (recordState.status !== 'found') {
    if (recordState.status === 'invalid') await removeSessionRecord(sessionId);
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_NOT_FOUND',
      `Unknown Artifact Session: ${sessionId}`,
    );
  }
  const record = recordState.record;
  const processState = await readProcessSignatureState(record.pid);
  if (processState.status !== 'found') {
    if (processState.status === 'missing') await removeSessionRecord(sessionId);
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
      `Process ${record.pid} no longer belongs to this Artifact Session: ${sessionId}`,
    );
  }
  if (!signaturesMatch(record.processSignature, processState.signature)) {
    await removeSessionRecord(sessionId);
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
      `Process ${record.pid} no longer belongs to this Artifact Session: ${sessionId}`,
    );
  }

  const readyState = await loadRuntimeReadyState(sessionId);
  if (readyState.status === 'unavailable') {
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_STOP_FAILED',
      `Artifact Session ${sessionId} ownership state is temporarily unavailable`,
    );
  }
  if (readyState.status !== 'found' || !readyMatchesRecord(record, readyState.ready)) {
    await removeSessionRecord(sessionId);
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
      `Process ${record.pid} no longer belongs to this Artifact Session: ${sessionId}`,
    );
  }

  const health = await readHealth(record);
  if (health.status === 'mismatch') {
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
      `Process ${record.pid} no longer belongs to this Artifact Session: ${sessionId}`,
    );
  }

  const stopped = await stopOwnedRuntimeProcess(
    record,
    readyState.ready,
    await readInstanceToken(sessionId),
  );
  if (!stopped) {
    throw new SessionLifecycleError(
      'ARTIFACT_SESSION_STOP_FAILED',
      `Artifact Session ${sessionId} process ${record.pid} did not stop`,
    );
  }

  await removeSessionDirectory(sessionId);
  const result = { sessionId, status: 'stopped' as const };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result)}\n`
      : `Stopped Artifact Session ${result.sessionId}.\n`,
  );
}
