import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { createServer, normalizePath } from 'vite';
import type { Plugin } from 'vite';

import { artifactInputExpression } from './artifact-input.js';
import type { SessionRuntimeConfig } from './config.js';
import { reactAliases, reactRuntimeDirectory } from './react.js';

const virtualEntryId = 'virtual:open-artifacts-session-entry';
const resolvedVirtualEntryId = `\0${virtualEntryId}`;
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

function artifactSessionPlugin(
  config: SessionRuntimeConfig,
  instanceToken: string,
  requestShutdown: () => void,
): Plugin {
  const entryUrl = `/@fs/${normalizePath(config.artifact.entryPath)}`;

  return {
    name: 'open-artifacts-session',
    configureServer(server) {
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
  await mkdir(renderRoot, { recursive: true });
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
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await rm(config.readyFile, { force: true });
    process.exit(0);
  };

  const server = await createServer({
    appType: 'spa',
    clearScreen: false,
    logLevel: 'silent',
    plugins: [artifactSessionPlugin(config, instanceToken, () => void shutdown())],
    resolve: {
      alias: reactAliases(),
      dedupe: ['react', 'react-dom'],
    },
    root: renderRoot,
    server: {
      fs: {
        allow: [config.artifact.root, renderRoot, reactRuntimeDirectory()],
      },
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
  });

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null;
  if (!address) throw new Error('local runtime did not bind an HTTP port');

  await writeFile(
    config.readyFile,
    `${JSON.stringify({ instanceId: config.instanceId, pid: process.pid, url: `http://127.0.0.1:${address.port}/` })}\n`,
  );
}

const configPath = process.argv[2];
if (!configPath) throw new Error('Artifact Session Runtime requires a config path');

const config = JSON.parse(await readFile(configPath, 'utf8')) as SessionRuntimeConfig;
const instanceToken = (await readFile(config.instanceSecretFile, 'utf8')).trim();
if (createHash('sha256').update(instanceToken).digest('hex') !== config.instanceId) {
  throw new Error('Artifact Session Runtime instance token mismatch');
}
await startRuntime(config, instanceToken);
