import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  healthMatchesRecord,
  parseLinuxProcessSignature,
  parseProcessSignatureOutput,
  parseRuntimeReadyState,
  parseSessionRecord,
  parseWindowsProcessSignatureOutput,
  processQueryFailure,
  publishJsonAtomically,
  readRuntimeReadyStateState,
  readyMatchesRecord,
  settleWithin,
  stopOwnedRuntimeProcess,
  waitUntilProcessChanges,
} from '../src/cli/session.js';

const record = {
  artifact: {
    entryPath: '/tmp/artifact/src/index.tsx',
    name: '@open-artifacts/example',
    root: '/tmp/artifact',
    version: '1.0.0',
  },
  instanceId: 'instance-id',
  pid: 123,
  processSignature: {
    command: '/usr/bin/node runtime.js config.json secret-token',
    owner: '501',
    startedAt: 'Wed Jul 15 12:34:56 2026',
  },
  sessionId: 'session-id',
  startedAt: '2026-07-15T04:34:56.000Z',
  url: 'http://127.0.0.1:43127/',
};

describe('Session Record validation', () => {
  it('accepts the complete owned-process record', () => {
    expect(parseSessionRecord(record)).toEqual(record);
  });

  it.each([
    [{ ...record, instanceId: '' }],
    [{ ...record, pid: 0 }],
    [{ ...record, processSignature: { ...record.processSignature, command: '' } }],
    [{ ...record, url: 'https://example.com/' }],
  ])('rejects an unsafe record', (value) => {
    expect(parseSessionRecord(value)).toBeUndefined();
  });

  it('publishes complete records with a same-directory atomic rename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-artifacts-record-'));
    const path = join(directory, 'record.json');
    const values = Array.from({ length: 40 }, (_, index) => ({ index, payload: 'x'.repeat(512) }));
    await publishJsonAtomically(path, values[0]);
    let reading = true;
    const reader = (async () => {
      while (reading) JSON.parse(await readFile(path, 'utf8'));
    })();

    try {
      await Promise.all(values.map((value) => publishJsonAtomically(path, value)));
      reading = false;
      await reader;
      expect(values).toContainEqual(JSON.parse(await readFile(path, 'utf8')));
      expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      reading = false;
      await reader;
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('process and health ownership', () => {
  it('parses the macOS process identity fields without losing command arguments', () => {
    expect(
      parseProcessSignatureOutput(
        '  501 Wed Jul 15 12:34:56 2026 /usr/bin/node runtime.js config.json secret-token\n',
      ),
    ).toEqual(record.processSignature);
  });

  it('parses a Windows process identity with its owner SID and command line', () => {
    expect(
      parseWindowsProcessSignatureOutput(
        JSON.stringify({
          CommandLine: '"C:\\Program Files\\nodejs\\node.exe" runtime.js config.json secret-token',
          CreationDate: '20260715123456.123456+480',
          ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
          OwnerSid: 'S-1-5-21-111-222-333-1001',
        }),
      ),
    ).toEqual({
      command: '"C:\\Program Files\\nodejs\\node.exe" runtime.js config.json secret-token',
      owner: 'S-1-5-21-111-222-333-1001',
      startedAt: '20260715123456.123456+480',
    });
  });

  it('parses a Linux procfs identity without depending on ps output', () => {
    const statFields = [
      'S',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '987654',
    ];

    expect(
      parseLinuxProcessSignature(
        `123 (node worker) ${statFields.join(' ')} 20 21\n`,
        'Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n',
        '/usr/bin/node\0runtime.js\0config.json\0secret-token\0',
      ),
    ).toEqual({
      command: '/usr/bin/node\0runtime.js\0config.json\0secret-token',
      owner: '1000',
      startedAt: 'linux:987654',
    });
  });

  it('does not treat a generic process-query exit as proof that the PID is missing', () => {
    expect(processQueryFailure({ code: 1, stderr: 'permission denied', stdout: '' })).toBe(
      'unavailable',
    );
    expect(processQueryFailure({ code: 1, stderr: '', stdout: '' })).toBe('missing');
    expect(
      processQueryFailure({ code: 1, stderr: 'ps: process id too large: 999999', stdout: '' }),
    ).toBe('missing');
  });

  it('requires the Runtime health tuple to match the Session Record exactly', () => {
    expect(
      healthMatchesRecord(record, {
        artifact: '@open-artifacts/example',
        instanceId: 'instance-id',
        sessionId: 'session-id',
        status: 'active',
      }),
    ).toBe(true);
    expect(
      healthMatchesRecord(record, {
        artifact: '@open-artifacts/example',
        instanceId: 'different-instance',
        sessionId: 'session-id',
        status: 'active',
      }),
    ).toBe(false);
  });

  it('requires the Runtime-written ready pid, instance, and URL to match together', () => {
    const ready = parseRuntimeReadyState({
      instanceId: record.instanceId,
      pid: record.pid,
      url: record.url,
    });
    expect(ready).toBeDefined();
    expect(readyMatchesRecord(record, ready!)).toBe(true);
    expect(readyMatchesRecord(record, { ...ready!, pid: record.pid + 1 })).toBe(false);
  });

  it('distinguishes a missing ready file from a transient read failure', async () => {
    const error = (code: string) => Object.assign(new Error(code), { code });
    await expect(
      readRuntimeReadyStateState('/missing', async () => Promise.reject(error('ENOENT'))),
    ).resolves.toEqual({ status: 'missing' });
    await expect(
      readRuntimeReadyStateState('/busy', async () => Promise.reject(error('EMFILE'))),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(readRuntimeReadyStateState('/invalid', async () => '{')).resolves.toEqual({
      status: 'invalid',
    });
  });

  it('bounds a stalled process query by the shared stop deadline', async () => {
    const startedAt = Date.now();
    await expect(
      waitUntilProcessChanges(record, Date.now() + 25, async () => new Promise(() => undefined)),
    ).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(250);
    await expect(settleWithin(new Promise(() => undefined), 10)).resolves.toBeUndefined();
  });

  it('reports a force-stop failure when the same process remains after SIGKILL', async () => {
    const kill = vi.fn();
    const readState = async () => ({
      signature: record.processSignature,
      status: 'found' as const,
    });

    await expect(
      stopOwnedRuntimeProcess(
        record,
        { instanceId: record.instanceId, pid: record.pid, url: record.url },
        'a'.repeat(64),
        {
          forceTimeoutMs: 10,
          gracefulTimeoutMs: 10,
          kill,
          platform: 'linux',
          readState,
          requestShutdown: async () => true,
        },
      ),
    ).resolves.toBe(false);
    expect(kill).toHaveBeenCalledWith(record.pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(record.pid, 'SIGKILL');
  });
});
