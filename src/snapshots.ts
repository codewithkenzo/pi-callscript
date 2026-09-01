import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect, Result } from "effect";

interface FileImage {
  requested: string;
  absolute: string;
  existed: boolean;
  content?: Uint8Array;
  mode?: number;
}

interface StoredSnapshot {
  id: string;
  files: FileImage[];
  bytes: number;
}

export interface SnapshotReceipt {
  id: string;
  files: string[];
  bytes: number;
}

export interface UndoReceipt {
  snapshot: string;
  restored: string[];
}

export class SnapshotError extends Error {
  readonly operation: "snapshot" | "undo";

  constructor(operation: "snapshot" | "undo", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SnapshotError";
    this.operation = operation;
  }
}

const missing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const captureFileAt = (requested: string, absolute: string) => {
  return Effect.tryPromise({
    try: async (): Promise<FileImage> => {
      try {
        const stats = await lstat(absolute);
        if (!stats.isFile()) throw new Error(`Snapshot supports files only: ${requested}`);
        return {
          requested,
          absolute,
          existed: true,
          content: await readFile(absolute),
          mode: stats.mode,
        };
      } catch (cause) {
        if (missing(cause)) return { requested, absolute, existed: false };
        throw cause;
      }
    },
    catch: (cause) => new SnapshotError("snapshot", cause),
  });
};

const captureFile = (cwd: string, requested: string) =>
  captureFileAt(requested, resolve(cwd, requested));

const restoreFile = (file: FileImage) =>
  Effect.tryPromise({
    try: async () => {
      if (!file.existed) {
        await rm(file.absolute, { force: true });
        return file.requested;
      }
      await mkdir(dirname(file.absolute), { recursive: true });
      await writeFile(file.absolute, file.content ?? new Uint8Array(), { mode: file.mode });
      return file.requested;
    },
    catch: (cause) => new SnapshotError("undo", cause),
  });

export class SnapshotStore {
  readonly #cwd: string;
  readonly #entries = new Map<string, StoredSnapshot>();
  #nextId = 1;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  capture(paths: readonly string[]) {
    return Effect.gen({ self: this }, function* () {
      const unique = new Map<string, string>();
      for (const path of paths) {
        const absolute = resolve(this.#cwd, path);
        if (!unique.has(absolute)) unique.set(absolute, path);
      }
      const files = yield* Effect.forEach(unique.values(), (path) => captureFile(this.#cwd, path), {
        concurrency: 8,
      });
      const id = `snap-${this.#nextId}`;
      this.#nextId += 1;
      const bytes = files.reduce((total, file) => total + (file.content?.byteLength ?? 0), 0);
      this.#entries.set(id, { id, files, bytes });
      return { id, files: files.map((file) => file.requested), bytes } satisfies SnapshotReceipt;
    });
  }

  undo(id: string) {
    return Effect.gen({ self: this }, function* () {
      const snapshot = this.#entries.get(id);
      if (snapshot === undefined)
        return yield* Effect.fail(new SnapshotError("undo", new Error(`Unknown snapshot: ${id}`)));
      const before = yield* Effect.forEach(
        snapshot.files,
        (file) => captureFileAt(file.requested, file.absolute),
        { concurrency: 8 },
      ).pipe(Effect.mapError((cause) => new SnapshotError("undo", cause)));
      const restored = yield* Effect.result(
        Effect.forEach(snapshot.files, restoreFile, { concurrency: 1 }),
      );
      if (Result.isSuccess(restored))
        return { snapshot: id, restored: restored.success } satisfies UndoReceipt;

      const rollback = yield* Effect.result(
        Effect.forEach(before, restoreFile, { concurrency: 1 }),
      );
      if (Result.isFailure(rollback)) {
        return yield* Effect.fail(
          new SnapshotError(
            "undo",
            new AggregateError(
              [restored.failure, rollback.failure],
              "Undo failed and rollback was incomplete",
            ),
          ),
        );
      }
      return yield* Effect.fail(restored.failure);
    });
  }

  clear() {
    return Effect.sync(() => {
      this.#entries.clear();
      this.#nextId = 1;
    });
  }
}
