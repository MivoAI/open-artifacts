import { describe, expect, it } from 'vitest';

import {
  healthMatchesRecord,
  parseProcessSignatureOutput,
  parseSessionRecord,
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
    startedAt: 'Wed Jul 15 12:34:56 2026',
    uid: 501,
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
});

describe('process and health ownership', () => {
  it('parses the macOS process identity fields without losing command arguments', () => {
    expect(
      parseProcessSignatureOutput(
        '  501 Wed Jul 15 12:34:56 2026 /usr/bin/node runtime.js config.json secret-token\n',
      ),
    ).toEqual(record.processSignature);
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
});
