import { randomUUID } from 'node:crypto';

import { CliError } from './errors.js';
import { findActiveSessionRecordByInstanceId, readInstanceToken } from './session.js';

interface OutputOptions {
  json: boolean;
}

interface InstanceOptions extends OutputOptions {
  instance: string;
}

interface ToolCallOptions extends InstanceOptions {
  baseRevision?: string;
  data?: string;
  idempotencyKey?: string;
}

class InstanceApiError extends CliError {
  constructor(code: string, message: string) {
    super(code, 'session', message);
  }
}

function parseInput(value: string | undefined): unknown {
  if (value === undefined) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new InstanceApiError('TOOL_INPUT_JSON_INVALID', '--data must contain valid JSON');
  }
}

async function requestInstance(
  instanceId: string,
  pathname: string,
  init: RequestInit = {},
): Promise<unknown> {
  const record = await findActiveSessionRecordByInstanceId(instanceId);
  if (!record) {
    throw new InstanceApiError(
      'ARTIFACT_INSTANCE_NOT_ACTIVE',
      `No Active Artifact Instance found: ${instanceId}`,
    );
  }
  const token = await readInstanceToken(record.sessionId);
  if (!token) {
    throw new InstanceApiError(
      'ARTIFACT_INSTANCE_AUTH_UNAVAILABLE',
      `Could not authenticate to Artifact Instance: ${instanceId}`,
    );
  }
  const response = await fetch(new URL(pathname, record.url), {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string } } | undefined;
  if (!response.ok) {
    throw new InstanceApiError(
      payload?.error?.code ?? 'ARTIFACT_INSTANCE_REQUEST_FAILED',
      payload?.error?.message ?? `Artifact Instance request failed (${response.status})`,
    );
  }
  return payload;
}

export async function listArtifactTools(options: InstanceOptions) {
  const result = await requestInstance(options.instance, '__oa/tools');
  process.stdout.write(
    options.json ? `${JSON.stringify(result)}\n` : `${formatToolList(result)}\n`,
  );
}

export async function callArtifactTool(name: string, options: ToolCallOptions) {
  const result = await requestInstance(options.instance, '__oa/tools/call', {
    body: JSON.stringify({
      ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      input: parseInput(options.data),
      name,
    }),
    method: 'POST',
  });
  process.stdout.write(
    options.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`,
  );
}

export async function listArtifactAnnotations(options: InstanceOptions) {
  const result = await requestInstance(options.instance, '__oa/annotations');
  process.stdout.write(
    options.json ? `${JSON.stringify(result)}\n` : `${formatAnnotationList(result)}\n`,
  );
}

export async function resolveArtifactAnnotation(id: string, options: InstanceOptions) {
  const result = await requestInstance(options.instance, '__oa/annotations/resolve', {
    body: JSON.stringify({ id }),
    method: 'POST',
  });
  process.stdout.write(
    options.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`,
  );
}

function formatToolList(value: unknown) {
  const tools =
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { tools?: unknown }).tools)
      ? (value as { tools: Array<{ description?: unknown; name?: unknown }> }).tools
      : [];
  if (tools.length === 0) return 'No Artifact Tools.';
  return tools
    .map((tool) => `${String(tool.name)}\n  ${String(tool.description ?? '')}`)
    .join('\n');
}

function formatAnnotationList(value: unknown) {
  const annotations =
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { annotations?: unknown }).annotations)
      ? (value as { annotations: Array<{ body?: unknown; id?: unknown; status?: unknown }> })
          .annotations
      : [];
  if (annotations.length === 0) return 'No Annotations.';
  return annotations
    .map(
      (annotation) =>
        `${String(annotation.id)} · ${String(annotation.status)}\n  ${String(annotation.body ?? '')}`,
    )
    .join('\n');
}
