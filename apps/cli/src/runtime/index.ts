import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createInstanceRuntime,
  readInstanceBundle,
  RuntimeError,
  setInstanceState,
} from '@open-artifacts/runtime';
import type { InstanceRuntime, RuntimeEvent } from '@open-artifacts/runtime';
import type { Actor, JsonSchema, JsonValue } from '@open-artifacts/sdk';
import { createServer, normalizePath } from 'vite';
import type { Plugin } from 'vite';

import { artifactInputExpression } from './artifact-input.js';
import type { SessionRuntimeConfig } from './config.js';
import { reactAliases, reactRuntimeDirectory } from './react.js';

const virtualEntryId = 'virtual:open-artifacts-session-entry';
const resolvedVirtualEntryId = `\0${virtualEntryId}`;
const require = createRequire(import.meta.url);
const browserRuntimeEntry = fileURLToPath(new URL('./browser.js', import.meta.url));
const runtimeBrowserClientEntry = require.resolve('@open-artifacts/runtime/browser');
const sdkEntry = require.resolve('@open-artifacts/sdk');
const sdkReactEntry = require.resolve('@open-artifacts/sdk/react');
const runtimeSourceDirectory = dirname(runtimeBrowserClientEntry);
const sdkSourceDirectory = dirname(sdkEntry);

function fileSystemRequestPath(requestUrl: string | undefined) {
  try {
    const pathname = decodeURIComponent(new URL(requestUrl ?? '/', 'http://127.0.0.1').pathname);
    if (!pathname.startsWith('/@fs/')) return undefined;
    return pathname.slice('/@fs/'.length);
  } catch {
    return undefined;
  }
}

function isWithinDirectory(directory: string, candidate: string) {
  const relativePath = relative(resolve(directory), resolve(candidate));
  if (relativePath === '') return true;
  if (isAbsolute(relativePath)) return false;
  if (relativePath === '..') return false;
  if (relativePath.startsWith(`..${sep}`)) return false;
  return true;
}

async function isSessionControlPath(sessionDirectory: string, candidate: string) {
  if (isWithinDirectory(sessionDirectory, candidate)) return true;
  const resolvedCandidate = await realpath(candidate).catch(() => undefined);
  if (!resolvedCandidate) return false;
  const resolvedSessionDirectory = await realpath(sessionDirectory).catch(() =>
    resolve(sessionDirectory),
  );
  return isWithinDirectory(resolvedSessionDirectory, resolvedCandidate);
}

function tokenMatches(expected: string, authorization: string | undefined) {
  if (!authorization?.startsWith('Bearer ')) return false;
  const provided = authorization.slice('Bearer '.length);
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function sameOriginRequest(request: IncomingMessage) {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host) return false;
  if (request.headers['sec-fetch-site'] === 'same-origin') return true;
  const referer = request.headers.referer;
  if (referer?.startsWith(`http://${host}/`) || referer?.startsWith(`https://${host}/`))
    return true;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function mayMutate(request: IncomingMessage, instanceToken: string) {
  return tokenMatches(instanceToken, request.headers.authorization) || sameOriginRequest(request);
}

function actorForRequest(request: IncomingMessage, instanceToken: string): Actor {
  if (tokenMatches(instanceToken, request.headers.authorization)) {
    return { id: 'oa-cli', type: 'agent' };
  }
  if (request.headers['x-oa-adapter'] === 'webmcp') {
    return { id: 'webmcp', type: 'agent' };
  }
  return { id: 'artifact-ui', type: 'human' };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function sendRuntimeError(response: ServerResponse, error: unknown) {
  const runtimeError =
    error instanceof RuntimeError
      ? error
      : new RuntimeError(
          'RUNTIME_REQUEST_FAILED',
          error instanceof Error ? error.message : String(error),
        );
  sendJson(response, 400, {
    error: {
      code: runtimeError.code,
      message: runtimeError.message,
      ...(runtimeError.details === undefined ? {} : { details: runtimeError.details }),
    },
  });
}

async function readRequestJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) {
      throw new RuntimeError('REQUEST_TOO_LARGE', 'Runtime request body exceeds 1 MB');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new RuntimeError('REQUEST_JSON_INVALID', 'Runtime request body must contain valid JSON');
  }
}

function requireRuntime(runtime: InstanceRuntime | undefined): InstanceRuntime {
  if (!runtime) {
    throw new RuntimeError(
      'ARTIFACT_RUNTIME_UNAVAILABLE',
      'This legacy Artifact Package does not expose Runtime capabilities',
    );
  }
  return runtime;
}

function artifactSessionPlugin(
  config: SessionRuntimeConfig,
  instanceToken: string,
  runtime: InstanceRuntime | undefined,
  activationReady: () => Promise<void>,
  requestShutdown: () => void,
): Plugin {
  const entryUrl = `/@fs/${normalizePath(config.artifact.entryPath)}`;
  const browserEntryUrl = `/@fs/${normalizePath(browserRuntimeEntry)}`;

  return {
    name: 'open-artifacts-session',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestedPath = fileSystemRequestPath(request.url);
        if (!requestedPath) {
          next();
          return;
        }
        void isSessionControlPath(config.sessionDirectory, requestedPath)
          .then((isControlPath) => {
            if (!isControlPath) {
              next();
              return;
            }
            response.statusCode = 403;
            response.end('Session control files are not browser-accessible.');
          })
          .catch(next);
      });
      server.middlewares.use('/__oa/tools/call', (request, response) => {
        void (async () => {
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.setHeader('allow', 'POST');
            response.end();
            return;
          }
          if (!mayMutate(request, instanceToken)) {
            sendJson(response, 401, {
              error: { code: 'UNAUTHORIZED', message: 'Runtime authentication is required' },
            });
            return;
          }
          await activationReady();
          const value = await readRequestJson<{
            annotationId?: string;
            baseRevision?: string;
            idempotencyKey: string;
            input: JsonValue;
            name: string;
          }>(request);
          if (
            typeof value.name !== 'string' ||
            typeof value.idempotencyKey !== 'string' ||
            !value.idempotencyKey ||
            (value.baseRevision !== undefined &&
              (typeof value.baseRevision !== 'string' || !value.baseRevision)) ||
            (value.annotationId !== undefined && typeof value.annotationId !== 'string')
          ) {
            throw new RuntimeError(
              'TOOL_CALL_INVALID',
              'Tool Call requires name and idempotencyKey',
            );
          }
          const result = await requireRuntime(runtime).callTool({
            actor: actorForRequest(request, instanceToken),
            ...(value.baseRevision === undefined ? {} : { baseRevision: value.baseRevision }),
            idempotencyKey: value.idempotencyKey,
            input: value.input,
            name: value.name,
            ...(value.annotationId === undefined ? {} : { annotationId: value.annotationId }),
          });
          sendJson(response, 200, result);
        })().catch((error) => sendRuntimeError(response, error));
      });
      server.middlewares.use('/__oa/tools', (request, response) => {
        void (async () => {
          if (request.method !== 'GET') {
            response.statusCode = 405;
            response.setHeader('allow', 'GET');
            response.end();
            return;
          }
          await activationReady();
          const activeRuntime = requireRuntime(runtime);
          sendJson(response, 200, {
            instanceId: config.instanceId,
            revision: await activeRuntime.data.revision(),
            tools: activeRuntime.listTools(),
          });
        })().catch((error) => sendRuntimeError(response, error));
      });
      server.middlewares.use('/__oa/data/bind', (request, response) => {
        void (async () => {
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.setHeader('allow', 'POST');
            response.end();
            return;
          }
          if (!mayMutate(request, instanceToken)) {
            sendJson(response, 401, {
              error: { code: 'UNAUTHORIZED', message: 'Runtime authentication is required' },
            });
            return;
          }
          await activationReady();
          const value = await readRequestJson<{
            initial: JsonValue;
            kind: 'json' | 'text';
            path: string;
            schema: JsonSchema;
          }>(request);
          const activeRuntime = requireRuntime(runtime);
          const binding =
            value.kind === 'text'
              ? activeRuntime.oa.data.bindText(value.path, {
                  initial: String(value.initial),
                })
              : activeRuntime.oa.data.bind(value.path, {
                  initial: value.initial,
                  schema: value.schema,
                });
          sendJson(response, 200, await binding.read());
        })().catch((error) => sendRuntimeError(response, error));
      });
      server.middlewares.use('/__oa/data', (request, response) => {
        void (async () => {
          await activationReady();
          const activeRuntime = requireRuntime(runtime);
          const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
          const path = requestUrl.searchParams.get('path');
          if (!path) throw new RuntimeError('DATA_PATH_INVALID', 'Data path is required');
          if (request.method === 'GET') {
            sendJson(response, 200, await activeRuntime.data.read(path));
            return;
          }
          if (request.method !== 'PUT') {
            response.statusCode = 405;
            response.setHeader('allow', 'GET, PUT');
            response.end();
            return;
          }
          if (!mayMutate(request, instanceToken)) {
            sendJson(response, 401, {
              error: { code: 'UNAUTHORIZED', message: 'Runtime authentication is required' },
            });
            return;
          }
          const value = await readRequestJson<{
            baseRevision: string;
            data: JsonValue;
            idempotencyKey: string;
            reason?: string;
          }>(request);
          const result = await activeRuntime.data.commit({
            actor: actorForRequest(request, instanceToken),
            baseRevision: value.baseRevision,
            data: value.data,
            idempotencyKey: value.idempotencyKey,
            path,
            ...(value.reason === undefined ? {} : { reason: value.reason }),
          });
          sendJson(response, 200, result);
        })().catch((error) => sendRuntimeError(response, error));
      });
      server.middlewares.use('/__oa/targets/select', (request, response) => {
        void (async () => {
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.setHeader('allow', 'POST');
            response.end();
            return;
          }
          if (!mayMutate(request, instanceToken)) {
            sendJson(response, 401, {
              error: { code: 'UNAUTHORIZED', message: 'Runtime authentication is required' },
            });
            return;
          }
          const controller = new AbortController();
          const abort = () => controller.abort();
          const abortIfDisconnected = () => {
            if (!response.writableEnded) abort();
          };
          request.once('aborted', abort);
          response.once('close', abortIfDisconnected);
          if (request.aborted) abort();
          try {
            await activationReady();
            const value = await readRequestJson<{
              provider: string;
              selection: JsonValue;
              trigger: 'capture' | 'context-menu' | 'hover' | 'selection';
            }>(request);
            const descriptor = await requireRuntime(runtime).oa.annotation.select({
              provider: value.provider,
              selection: value.selection,
              signal: controller.signal,
              trigger: value.trigger,
            });
            controller.signal.throwIfAborted();
            sendJson(response, 200, descriptor);
          } finally {
            request.off('aborted', abort);
            response.off('close', abortIfDisconnected);
          }
        })().catch((error) => {
          if (!response.destroyed && !response.writableEnded) sendRuntimeError(response, error);
        });
      });
      server.middlewares.use('/__oa/annotations/resolve', (request, response) => {
        void (async () => {
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.setHeader('allow', 'POST');
            response.end();
            return;
          }
          if (!mayMutate(request, instanceToken)) {
            sendJson(response, 401, {
              error: { code: 'UNAUTHORIZED', message: 'Runtime authentication is required' },
            });
            return;
          }
          await activationReady();
          const value = await readRequestJson<{ id: string }>(request);
          if (typeof value.id !== 'string' || !value.id) {
            throw new RuntimeError('ANNOTATION_ID_INVALID', 'Annotation resolution requires an id');
          }
          const resolution = await requireRuntime(runtime).resolveAnnotation(value.id);
          if (!resolution) {
            throw new RuntimeError(
              'ANNOTATION_NOT_FOUND',
              `Annotation does not exist: ${value.id}`,
            );
          }
          sendJson(response, 200, {
            annotationId: value.id,
            resolution,
          });
        })().catch((error) => sendRuntimeError(response, error));
      });
      server.middlewares.use('/__oa/annotations', (request, response) => {
        void (async () => {
          await activationReady();
          const activeRuntime = requireRuntime(runtime);
          if (request.method === 'GET') {
            sendJson(response, 200, { annotations: await activeRuntime.listAnnotations() });
            return;
          }
          if (request.method !== 'POST') {
            response.statusCode = 405;
            response.setHeader('allow', 'GET, POST');
            response.end();
            return;
          }
          if (!mayMutate(request, instanceToken)) {
            sendJson(response, 401, {
              error: { code: 'UNAUTHORIZED', message: 'Runtime authentication is required' },
            });
            return;
          }
          const value = await readRequestJson<{
            body: string;
            provider: string;
            selection: JsonValue;
          }>(request);
          if (!value.body?.trim()) {
            throw new RuntimeError('ANNOTATION_BODY_INVALID', 'Annotation body is required');
          }
          const annotation = await activeRuntime.createAnnotation({
            actor: actorForRequest(request, instanceToken),
            body: value.body.trim(),
            provider: value.provider,
            selection: value.selection,
          });
          sendJson(response, 201, annotation);
        })().catch((error) => sendRuntimeError(response, error));
      });
      server.middlewares.use('/__oa/events', (request, response) => {
        void (async () => {
          if (request.method !== 'GET') {
            response.statusCode = 405;
            response.setHeader('allow', 'GET');
            response.end();
            return;
          }
          await activationReady();
          const activeRuntime = requireRuntime(runtime);
          response.statusCode = 200;
          response.setHeader('content-type', 'text/event-stream');
          response.setHeader('cache-control', 'no-cache');
          response.setHeader('connection', 'keep-alive');
          response.write(': connected\n\n');
          const send = (event: RuntimeEvent) =>
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          const unsubscribe = activeRuntime.subscribe(send);
          const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
          request.once('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
          });
        })().catch((error) => sendRuntimeError(response, error));
      });
      server.middlewares.use('/__oa/health', (_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            artifact: config.artifact.name,
            instanceId: config.instanceId,
            sessionId: config.sessionId,
            status: 'active',
          }),
        );
      });
      server.middlewares.use('/__oa/shutdown', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.setHeader('allow', 'POST');
          response.end();
          return;
        }
        if (!tokenMatches(instanceToken, request.headers.authorization)) {
          response.statusCode = 401;
          response.end();
          return;
        }
        response.statusCode = 202;
        response.end();
        setImmediate(requestShutdown);
      });
      server.middlewares.use('/__oa/preflight', async (_request, response) => {
        try {
          await activationReady();
          const [sessionEntry, artifactEntry] = await Promise.all([
            server.transformRequest(virtualEntryId),
            server.transformRequest(entryUrl),
          ]);
          if (!sessionEntry || !artifactEntry) {
            throw new Error('Vite could not load the Render entry modules');
          }
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ status: 'ready' }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end(error instanceof Error ? error.message : String(error));
        }
      });
    },
    load(id) {
      if (id !== resolvedVirtualEntryId) return undefined;

      if (config.artifact.format === 'react-runtime/v1') {
        return `
import Artifact from ${JSON.stringify(entryUrl)};
import { mountArtifactWorkbench } from ${JSON.stringify(browserEntryUrl)};

const input = ${artifactInputExpression(config.artifactInput)};
const root = document.getElementById('root');
if (!root) throw new Error('Open Artifacts Runtime root is missing');
mountArtifactWorkbench({
  Artifact,
  artifact: ${JSON.stringify({
    name: config.artifact.name,
    version: config.artifact.version,
  })},
  input,
  instanceId: ${JSON.stringify(config.instanceId)},
  root,
});
`;
      }

      return `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import Render from ${JSON.stringify(entryUrl)};

const data = ${artifactInputExpression(config.artifactInput)};
const root = document.getElementById('root');
if (!root) throw new Error('Open Artifacts Runtime root is missing');
createRoot(root).render(createElement(Render, { data }));
`;
    },
    resolveId(id) {
      return id === virtualEntryId ? resolvedVirtualEntryId : undefined;
    },
  };
}

async function startRuntime(config: SessionRuntimeConfig, instanceToken: string) {
  const renderRoot = resolve(config.sessionDirectory, 'render');
  const bundle = await readInstanceBundle(config.bundlePath);
  const activeBundle = await setInstanceState(bundle, 'active');
  const runtime =
    config.artifact.format === 'react-runtime/v1'
      ? await createInstanceRuntime({
          bundle: activeBundle,
          defaultActor: { id: 'artifact-ui', type: 'human' },
        })
      : undefined;
  let activationPromise: Promise<void> = Promise.resolve();
  await mkdir(renderRoot, { mode: 0o700, recursive: true });
  await writeFile(
    resolve(renderRoot, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${config.artifact.name}</title>
    <style>
      html, body, #root { width: 100%; min-height: 100%; margin: 0; }
      body { min-height: 100vh; }
      #root { min-height: 100vh; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${virtualEntryId}"></script>
  </body>
</html>
`,
    { mode: 0o600 },
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime?.dispose();
    await setInstanceState(activeBundle, 'stopped');
    await server.close();
    await rm(config.readyFile, { force: true });
    process.exit(0);
  };

  const server = await createServer({
    appType: 'spa',
    clearScreen: false,
    logLevel: 'silent',
    plugins: [
      artifactSessionPlugin(
        config,
        instanceToken,
        runtime,
        () => activationPromise,
        () => void shutdown(),
      ),
    ],
    resolve: {
      alias: [
        ...reactAliases(),
        { find: '@open-artifacts/sdk/react', replacement: sdkReactEntry },
        { find: '@open-artifacts/sdk', replacement: sdkEntry },
        {
          find: '@open-artifacts/runtime/browser',
          replacement: runtimeBrowserClientEntry,
        },
      ],
      dedupe: ['react', 'react-dom'],
    },
    root: renderRoot,
    server: {
      fs: {
        allow: [
          config.artifact.root,
          ...(config.artifact.dependencyRoot ? [config.artifact.dependencyRoot] : []),
          dirname(browserRuntimeEntry),
          renderRoot,
          reactRuntimeDirectory(),
          runtimeSourceDirectory,
          sdkSourceDirectory,
        ],
      },
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
  });

  if (runtime) {
    if (!config.artifact.activationPath) {
      throw new Error('react-runtime/v1 Artifact Package is missing its activation entry');
    }
    activationPromise = (async () => {
      const activationUrl = `/@fs/${normalizePath(config.artifact.activationPath!)}`;
      const activationModule = (await server.ssrLoadModule(activationUrl)) as {
        activate?: unknown;
      };
      if (typeof activationModule.activate !== 'function') {
        throw new Error('Artifact activation entry must export activate');
      }
      await runtime.activate(
        activationModule.activate as Parameters<InstanceRuntime['activate']>[0],
        config.artifactInput as JsonValue,
      );
    })();
    await activationPromise;
  }

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null;
  if (!address) throw new Error('local runtime did not bind an HTTP port');

  await writeFile(
    config.readyFile,
    `${JSON.stringify({ instanceId: config.instanceId, pid: process.pid, url: `http://127.0.0.1:${address.port}/` })}\n`,
    { mode: 0o600 },
  );
}

const configPath = process.argv[2];
if (!configPath) throw new Error('Artifact Session Runtime requires a config path');

const config = JSON.parse(await readFile(configPath, 'utf8')) as SessionRuntimeConfig;
const instanceToken = (await readFile(config.instanceSecretFile, 'utf8')).trim();
if (createHash('sha256').update(instanceToken).digest('hex') !== config.instanceTokenHash) {
  throw new Error('Artifact Session Runtime instance token mismatch');
}
await startRuntime(config, instanceToken);
