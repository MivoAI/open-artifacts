import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function createTarball(root, name, version, files) {
  const sourceRoot = join(root, `${name}-${version}-source`);
  const packageRoot = join(sourceRoot, 'package');
  const tarball = join(root, `${name}-${version}.tgz`);
  await mkdir(packageRoot, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const destination = join(packageRoot, path);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, content);
    }),
  );
  const packed = spawnSync('tar', ['-czf', tarball, '-C', sourceRoot, 'package'], {
    encoding: 'utf8',
  });
  if (packed.status !== 0) throw new Error(packed.stderr || 'tar failed');
  const contents = await readFile(tarball);
  return {
    integrity: `sha512-${createHash('sha512').update(contents).digest('base64')}`,
    path: tarball,
  };
}

function artifactManifest(name, version, options = {}) {
  return {
    name,
    version,
    description: 'Controlled registry Artifact fixture',
    type: 'module',
    files: ['src', 'input.schema.json', 'example.json', 'tsconfig.json', 'README.md'],
    exports: {
      '.': './src/index.tsx',
      './schema': './input.schema.json',
      './example': './example.json',
      './package.json': './package.json',
    },
    openArtifacts: { format: options.format ?? 'react-render/v0' },
    peerDependencies: { react: '^19.0.0' },
    dependencies: { 'oa-registry-helper': '1.0.0' },
    scripts: {
      install:
        "node -e \"require('node:fs').writeFileSync(process.env.OA_SCRIPT_MARKER, 'artifact install ran')\"",
    },
  };
}

function artifactFiles(name, version, options = {}) {
  const manifest = artifactManifest(name, version, options);
  return {
    'package.json': json(manifest),
    'src/index.tsx':
      "import { helperLabel } from 'oa-registry-helper';\nexport default function RegistryArtifact({ data }) { return <h1>{helperLabel}: {data.message}</h1>; }\n",
    'input.schema.json': json({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string' } },
    }),
    'example.json': json({ message: `version ${version}` }),
    'tsconfig.json': '{}\n',
    'README.md':
      '# Registry fixture\n\nRenders Artifact Input shaped as `{ message: string }` with `oa-registry-helper`. React is provided as a peer dependency. Copy the package to create a Local Fork.\n',
  };
}

export async function createControlledRegistry() {
  const root = await mkdtemp(join(tmpdir(), 'open-artifacts-registry-'));
  const helperManifest = {
    name: 'oa-registry-helper',
    version: '1.0.0',
    type: 'module',
    exports: './index.js',
    scripts: {
      install:
        "node -e \"require('node:fs').writeFileSync(process.env.OA_DEPENDENCY_SCRIPT_MARKER, 'dependency install ran')\"",
    },
  };
  const helperTarball = await createTarball(root, 'helper', '1.0.0', {
    'package.json': json(helperManifest),
    'index.js': "export const helperLabel = 'registry helper';\n",
  });
  const artifactTarballs = new Map();
  for (const version of ['1.0.0', '1.1.0', '2.0.0']) {
    artifactTarballs.set(
      version,
      await createTarball(
        root,
        'artifact',
        version,
        artifactFiles('oa-registry-artifact', version),
      ),
    );
  }
  const invalidTarball = await createTarball(
    root,
    'invalid-artifact',
    '1.0.0',
    artifactFiles('oa-invalid-artifact', '1.0.0', { format: 'unknown/v0' }),
  );

  const tarballs = new Map();
  const requests = new Map();
  let origin;

  function withDist(manifest, tarballPath, tarball) {
    const path = `/tarballs/${tarballPath}`;
    tarballs.set(path, tarball.path);
    return {
      ...manifest,
      dist: {
        integrity: tarball.integrity,
        tarball: `${origin}${path}`,
      },
    };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);

    if (tarballs.has(url.pathname)) {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/octet-stream');
      response.end(await readFile(tarballs.get(url.pathname)));
      return;
    }

    let packument;
    if (decodeURIComponent(url.pathname.slice(1)) === 'oa-registry-artifact') {
      const versions = Object.fromEntries(
        [...artifactTarballs].map(([version, tarball]) => [
          version,
          withDist(
            artifactManifest('oa-registry-artifact', version),
            `oa-registry-artifact-${version}.tgz`,
            tarball,
          ),
        ]),
      );
      packument = {
        name: 'oa-registry-artifact',
        'dist-tags': { latest: '1.1.0', stable: '1.1.0' },
        versions,
      };
    } else if (decodeURIComponent(url.pathname.slice(1)) === 'oa-registry-helper') {
      packument = {
        name: 'oa-registry-helper',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': withDist(helperManifest, 'oa-registry-helper-1.0.0.tgz', helperTarball),
        },
      };
    } else if (decodeURIComponent(url.pathname.slice(1)) === 'oa-invalid-artifact') {
      packument = {
        name: 'oa-invalid-artifact',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': withDist(
            artifactManifest('oa-invalid-artifact', '1.0.0', { format: 'unknown/v0' }),
            'oa-invalid-artifact-1.0.0.tgz',
            invalidTarball,
          ),
        },
      };
    }

    if (!packument) {
      response.statusCode = 404;
      response.end(json({ error: 'not found' }));
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(json(packument));
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Registry fixture did not bind');
  origin = `http://127.0.0.1:${address.port}`;

  return {
    close: async () => {
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      await rm(root, { force: true, recursive: true });
    },
    count(path) {
      return requests.get(path) ?? 0;
    },
    origin,
  };
}
