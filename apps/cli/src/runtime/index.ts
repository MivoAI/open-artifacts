import { createRequire } from 'node:module';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';

import { createServer, normalizePath } from 'vite';
import type { Alias, Plugin } from 'vite';

import type { SessionRuntimeConfig } from './config.js';

const virtualEntryId = 'virtual:open-artifacts-session-entry';
const resolvedVirtualEntryId = `\0${virtualEntryId}`;
const require = createRequire(import.meta.url);

function reactAliases(): Alias[] {
  return [
    { find: 'react/jsx-dev-runtime', replacement: require.resolve('react/jsx-dev-runtime') },
    { find: 'react/jsx-runtime', replacement: require.resolve('react/jsx-runtime') },
    { find: 'react-dom/client', replacement: require.resolve('react-dom/client') },
    { find: 'react-dom', replacement: require.resolve('react-dom') },
    { find: 'react', replacement: require.resolve('react') },
  ];
}

function artifactSessionPlugin(config: SessionRuntimeConfig): Plugin {
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
            sessionId: config.sessionId,
            status: 'active',
          }),
        );
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

const data = ${JSON.stringify(config.exampleInput)};
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

async function startRuntime(config: SessionRuntimeConfig) {
  await writeFile(
    `${config.sessionDirectory}/index.html`,
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

  const server = await createServer({
    appType: 'spa',
    clearScreen: false,
    logLevel: 'silent',
    plugins: [artifactSessionPlugin(config)],
    resolve: {
      alias: reactAliases(),
      dedupe: ['react', 'react-dom'],
    },
    root: config.sessionDirectory,
    server: {
      fs: {
        allow: [config.artifact.root, config.sessionDirectory, dirname(require.resolve('react'))],
      },
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
  });

  const shutdown = async () => {
    await server.close();
    await rm(config.readyFile, { force: true });
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null;
  if (!address) throw new Error('Artifact Session Runtime did not bind an HTTP port');

  await writeFile(
    config.readyFile,
    `${JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}/` })}\n`,
  );
}

const configPath = process.argv[2];
if (!configPath) throw new Error('Artifact Session Runtime requires a config path');

const config = JSON.parse(await readFile(configPath, 'utf8')) as SessionRuntimeConfig;
await startRuntime(config);
