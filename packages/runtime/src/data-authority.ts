import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Actor, DataCommit, JsonSchema, JsonValue } from '@open-artifacts/sdk';

import type { InstanceBundle } from './bundle.js';
import { runGit } from './bundle.js';
import { RuntimeError } from './errors.js';
import { readJson, writeJsonAtomically } from './fs.js';
import { validateSchema } from './schema.js';
import { stableJson } from './stable-json.js';

interface BindingRecord {
  readonly kind: 'json' | 'text';
  readonly schema: JsonSchema;
}

interface SchemaFile {
  bindings: Record<string, BindingRecord>;
}

type StoredReceipt =
  | {
      requestHash: string;
      status: 'pending';
    }
  | {
      requestHash: string;
      status: 'succeeded';
      commit: DataCommit<unknown>;
    }
  | {
      // v0.1 compatibility for receipts written before status was persisted.
      requestHash: string;
      commit: DataCommit<unknown>;
    };

interface ReceiptFile {
  receipts: Record<string, StoredReceipt>;
}

export interface DataSnapshot<T = JsonValue> {
  readonly data: T;
  readonly revision: string;
}

export interface DataChangedEvent {
  readonly type: 'data.changed';
  readonly path: string;
  readonly revision: string;
}

export class GitDataAuthority {
  readonly #bundle: InstanceBundle<unknown>;
  readonly #listeners = new Set<(event: DataChangedEvent) => void>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(bundle: InstanceBundle<unknown>) {
    this.#bundle = bundle;
  }

  subscribe(listener: (event: DataChangedEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async revision() {
    const result = await runGit(this.#bundle.dataPath, ['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async bind<T>(options: {
    path: string;
    initial: T | (() => T);
    schema: JsonSchema;
  }): Promise<DataSnapshot<T>> {
    return this.#serialize(async () => {
      const path = this.#resolvePath(options.path);
      await this.#assertSafeResolvedPath(options.path, true);
      const schemasPath = join(this.#bundle.dataPath, '.oa', 'schemas.json');
      const schemas = await readJson<SchemaFile>(schemasPath);
      const existing = schemas.bindings[options.path];
      if (existing && stableJson(existing.schema) !== stableJson(options.schema)) {
        throw new RuntimeError(
          'DATA_BINDING_CONFLICT',
          `Data path ${options.path} is already bound with another Schema`,
        );
      }
      if (existing) return this.#readResolved<T>(options.path, path, existing.kind);

      const initial =
        typeof options.initial === 'function' ? (options.initial as () => T)() : options.initial;
      this.#validate(options.schema, initial);
      await mkdir(resolve(path, '..'), { mode: 0o700, recursive: true });
      await this.#writeResolvedAtomically(path, `${JSON.stringify(initial, null, 2)}\n`);
      schemas.bindings[options.path] = { kind: 'json', schema: options.schema };
      await writeJsonAtomically(schemasPath, schemas);
      const revision = await this.#commitGit(`Bind managed Data ${options.path}`);
      this.#emit({ path: options.path, revision, type: 'data.changed' });
      return { data: initial, revision };
    });
  }

  async bindText(options: {
    path: string;
    initial: string | (() => string);
  }): Promise<DataSnapshot<string>> {
    return this.#serialize(async () => {
      const path = this.#resolvePath(options.path);
      await this.#assertSafeResolvedPath(options.path, true);
      const schemasPath = join(this.#bundle.dataPath, '.oa', 'schemas.json');
      const schemas = await readJson<SchemaFile>(schemasPath);
      const existing = schemas.bindings[options.path];
      if (existing && existing.kind !== 'text') {
        throw new RuntimeError(
          'DATA_BINDING_CONFLICT',
          `Data path ${options.path} is already bound as JSON`,
        );
      }
      if (existing) return this.#readResolved<string>(options.path, path, 'text');

      const initial = typeof options.initial === 'function' ? options.initial() : options.initial;
      await mkdir(resolve(path, '..'), { mode: 0o700, recursive: true });
      await this.#writeResolvedAtomically(path, initial);
      schemas.bindings[options.path] = { kind: 'text', schema: { type: 'string' } };
      await writeJsonAtomically(schemasPath, schemas);
      const revision = await this.#commitGit(`Bind managed text Data ${options.path}`);
      this.#emit({ path: options.path, revision, type: 'data.changed' });
      return { data: initial, revision };
    });
  }

  async read<T = JsonValue>(path: string): Promise<DataSnapshot<T>> {
    const resolved = this.#resolvePath(path);
    await this.#assertSafeResolvedPath(path, false);
    const schemas = await readJson<SchemaFile>(join(this.#bundle.dataPath, '.oa', 'schemas.json'));
    const binding = schemas.bindings[path];
    if (!binding) throw new RuntimeError('DATA_NOT_FOUND', `Data path is not bound: ${path}`);
    return this.#readResolved<T>(path, resolved, binding.kind);
  }

  async commit<T>(request: {
    path: string;
    data: T;
    baseRevision: string;
    idempotencyKey: string;
    actor: Actor;
    reason?: string;
  }): Promise<DataCommit<T>> {
    return this.#serialize(async () => {
      const resolved = this.#resolvePath(request.path);
      await this.#assertSafeResolvedPath(request.path, false);
      const receiptsPath = join(this.#bundle.path, 'data-receipts.json');
      const receipts = await readJson<ReceiptFile>(receiptsPath);
      const requestHash = createHash('sha256')
        .update(
          stableJson({
            actor: request.actor,
            baseRevision: request.baseRevision,
            data: request.data,
            path: request.path,
          }),
        )
        .digest('hex');
      const replay = receipts.receipts[request.idempotencyKey];
      if (replay?.requestHash !== undefined && replay.requestHash !== requestHash) {
        throw new RuntimeError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was already used for another mutation',
        );
      }
      if (replay && 'commit' in replay) return replay.commit as DataCommit<T>;

      const currentRevision = await this.revision();
      const schemas = await readJson<SchemaFile>(
        join(this.#bundle.dataPath, '.oa', 'schemas.json'),
      );
      const binding = schemas.bindings[request.path];
      if (!binding) {
        throw new RuntimeError('DATA_NOT_FOUND', `Data path is not bound: ${request.path}`);
      }
      const currentData = await this.#readDataResolved<T>(request.path, resolved, binding.kind);
      if (replay?.status === 'pending' && stableJson(currentData) === stableJson(request.data)) {
        const recovered: DataCommit<T> = {
          data: request.data,
          receiptId: randomUUID(),
          revision: currentRevision,
        };
        receipts.receipts[request.idempotencyKey] = {
          commit: recovered,
          requestHash,
          status: 'succeeded',
        };
        await writeJsonAtomically(receiptsPath, receipts);
        return recovered;
      }
      if (request.baseRevision !== currentRevision) {
        throw new RuntimeError(
          replay?.status === 'pending' ? 'DATA_COMMIT_INCOMPLETE' : 'REVISION_CONFLICT',
          replay?.status === 'pending'
            ? 'The previous mutation did not reach a recoverable durable result'
            : 'Managed Data revision is stale',
          { currentRevision },
        );
      }

      this.#validate(binding.schema, request.data);
      receipts.receipts[request.idempotencyKey] = {
        requestHash,
        status: 'pending',
      };
      await writeJsonAtomically(receiptsPath, receipts);

      const changed = stableJson(currentData) !== stableJson(request.data);
      let revision = currentRevision;
      if (changed) {
        await this.#writeResolvedAtomically(
          resolved,
          binding.kind === 'text'
            ? String(request.data)
            : `${JSON.stringify(request.data, null, 2)}\n`,
        );
        revision = await this.#commitGit(request.reason ?? `Update managed Data ${request.path}`);
      }
      const commit: DataCommit<T> = {
        data: request.data,
        receiptId: randomUUID(),
        revision,
      };
      receipts.receipts[request.idempotencyKey] = {
        commit,
        requestHash,
        status: 'succeeded',
      };
      await writeJsonAtomically(receiptsPath, receipts);
      if (changed) this.#emit({ path: request.path, revision, type: 'data.changed' });
      return commit;
    });
  }

  async #readResolved<T>(logicalPath: string, path: string, kind: 'json' | 'text') {
    return {
      data: await this.#readDataResolved<T>(logicalPath, path, kind),
      revision: await this.revision(),
    };
  }

  async #readDataResolved<T>(logicalPath: string, path: string, kind: 'json' | 'text') {
    const content = await readFile(path, 'utf8').catch(() => {
      throw new RuntimeError('DATA_NOT_FOUND', `Managed Data is missing: ${logicalPath}`);
    });
    return (kind === 'text' ? content : JSON.parse(content)) as T;
  }

  #resolvePath(path: string) {
    const segments = path.split('/');
    const firstSegment = segments[0]?.toLowerCase();
    if (
      !path ||
      isAbsolute(path) ||
      path.includes('\\') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      firstSegment === '.git' ||
      firstSegment === '.oa'
    ) {
      throw new RuntimeError('DATA_PATH_INVALID', `Invalid managed Data path: ${path}`);
    }
    const resolved = resolve(this.#bundle.dataPath, path);
    const relativePath = relative(this.#bundle.dataPath, resolved);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new RuntimeError('DATA_PATH_INVALID', `Invalid managed Data path: ${path}`);
    }
    return resolved;
  }

  async #assertSafeResolvedPath(logicalPath: string, allowMissing: boolean) {
    const segments = logicalPath.split('/');
    let current = this.#bundle.dataPath;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const info = await lstat(current).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!info) {
        if (allowMissing) return;
        throw new RuntimeError('DATA_NOT_FOUND', `Managed Data is missing: ${logicalPath}`);
      }
      if (info.isSymbolicLink()) {
        throw new RuntimeError(
          'DATA_PATH_INVALID',
          `Managed Data paths cannot traverse symbolic links: ${logicalPath}`,
        );
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new RuntimeError(
          'DATA_PATH_INVALID',
          `Managed Data parent is not a directory: ${logicalPath}`,
        );
      }
    }
  }

  async #writeResolvedAtomically(path: string, content: string) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #validate(schema: JsonSchema, data: unknown) {
    validateSchema(schema, data, 'DATA_SCHEMA_INVALID');
  }

  async #commitGit(message: string) {
    await runGit(this.#bundle.dataPath, ['add', '--all']);
    await runGit(this.#bundle.dataPath, ['commit', '--quiet', '-m', message]);
    return this.revision();
  }

  #emit(event: DataChangedEvent) {
    for (const listener of this.#listeners) listener(event);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
