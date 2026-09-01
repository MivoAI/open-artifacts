import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Actor, JsonValue, TargetPresentation, TargetResolution } from '@open-artifacts/sdk';

import type { InstanceBundle } from './bundle.js';
import { readJson, writeJsonAtomically } from './fs.js';

export interface AnnotationRecord {
  readonly id: string;
  readonly body: string;
  readonly status: 'open' | 'applied' | 'resolved' | 'rejected';
  readonly createdAt: string;
  readonly actor: Actor;
  readonly revision: number;
  readonly target: {
    readonly provider: string;
    readonly selector: JsonValue;
  };
  readonly targetSnapshot: {
    readonly dataRevision: string;
    readonly context: JsonValue;
    readonly presentation: TargetPresentation;
  };
}

interface AnnotationFile {
  revision: number;
  annotations: AnnotationRecord[];
}

export class AnnotationStore {
  readonly #path: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(bundle: InstanceBundle<unknown>) {
    this.#path = join(bundle.path, 'annotations.json');
  }

  async create(
    value: Omit<AnnotationRecord, 'id' | 'createdAt' | 'revision' | 'status'>,
  ): Promise<AnnotationRecord> {
    return this.#serialize(async () => {
      const file = await readJson<AnnotationFile>(this.#path);
      const annotation: AnnotationRecord = {
        ...value,
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        revision: file.revision + 1,
        status: 'open',
      };
      file.revision = annotation.revision;
      file.annotations.push(annotation);
      await writeJsonAtomically(this.#path, file);
      return annotation;
    });
  }

  async list() {
    return [...(await readJson<AnnotationFile>(this.#path)).annotations];
  }

  async get(id: string) {
    return (await readJson<AnnotationFile>(this.#path)).annotations.find(
      (annotation) => annotation.id === id,
    );
  }

  async resolve<TContext extends JsonValue>(
    id: string,
    resolver: (annotation: AnnotationRecord) => Promise<TargetResolution<TContext>>,
  ) {
    const annotation = await this.get(id);
    if (!annotation) return undefined;
    return resolver(annotation);
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
