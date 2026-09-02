import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { ConfigError } from "./errors.js";
import { MODES, type ExtensionConfig, type Mode } from "./types.js";

const ModeSchema = Schema.Literals(["off", "on"]);
const LimitsSchema = Schema.Struct({
  maxSteps: Schema.optionalKey(Schema.Number),
  maxItemsPerStep: Schema.optionalKey(Schema.Number),
  maxTotalCalls: Schema.optionalKey(Schema.Number),
  maxConcurrency: Schema.optionalKey(Schema.Number),
  maxCallResultBytes: Schema.optionalKey(Schema.Number),
});
const FileConfigSchema = Schema.Struct({
  mode: Schema.optionalKey(ModeSchema),
  limits: Schema.optionalKey(LimitsSchema),
  httpTimeoutMs: Schema.optionalKey(Schema.Number),
  maxHttpResultBytes: Schema.optionalKey(Schema.Number),
  maxOutputBytes: Schema.optionalKey(Schema.Number),
});

type FileConfig = typeof FileConfigSchema.Type;

const DEFAULT_CONFIG: ExtensionConfig = {
  mode: "on",
  limits: {
    maxSteps: 30,
    maxItemsPerStep: 100,
    maxTotalCalls: 200,
    maxConcurrency: 12,
    maxCallResultBytes: 10_485_760,
  },
  httpTimeoutMs: 30_000,
  maxHttpResultBytes: 5_242_880,
  maxOutputBytes: 10_240,
};

const readConfigFile = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => ConfigError.from(path, cause),
  }).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(FileConfigSchema))(text).pipe(
        Effect.mapError((cause) => ConfigError.from(path, cause)),
      ),
    ),
    Effect.catchIf(
      (error) =>
        error.cause instanceof Error && "code" in error.cause && error.cause.code === "ENOENT",
      () => Effect.succeed(undefined),
    ),
  );

const integer = (value: number | undefined, fallback: number, minimum: number, maximum: number) => {
  if (value === undefined || !Number.isInteger(value) || value < minimum || value > maximum)
    return fallback;
  return value;
};

const merge = (base: ExtensionConfig, next: FileConfig | undefined): ExtensionConfig => {
  if (next === undefined) return base;
  return {
    mode: next.mode ?? base.mode,
    limits: {
      maxSteps: integer(next.limits?.maxSteps, base.limits.maxSteps, 1, 200),
      maxItemsPerStep: integer(next.limits?.maxItemsPerStep, base.limits.maxItemsPerStep, 1, 1_000),
      maxTotalCalls: integer(next.limits?.maxTotalCalls, base.limits.maxTotalCalls, 1, 2_000),
      maxConcurrency: integer(next.limits?.maxConcurrency, base.limits.maxConcurrency, 1, 64),
      maxCallResultBytes: integer(
        next.limits?.maxCallResultBytes,
        base.limits.maxCallResultBytes,
        1_024,
        52_428_800,
      ),
    },
    httpTimeoutMs: integer(next.httpTimeoutMs, base.httpTimeoutMs, 100, 600_000),
    maxHttpResultBytes: integer(
      next.maxHttpResultBytes,
      base.maxHttpResultBytes,
      1_024,
      52_428_800,
    ),
    maxOutputBytes: integer(next.maxOutputBytes, base.maxOutputBytes ?? 10_240, 1_024, 20_480),
  };
};

export const loadConfig = (cwd: string) => {
  const globalPath = join(homedir(), ".pi", "agent", "callscript.json");
  const projectPath = join(cwd, ".pi", "callscript.json");
  return Effect.gen(function* () {
    const [global, project] = yield* Effect.all(
      [readConfigFile(globalPath), readConfigFile(projectPath)],
      { concurrency: 2 },
    );
    return merge(merge(DEFAULT_CONFIG, global), project);
  });
};

const MODE_SET: ReadonlySet<string> = new Set(MODES);
export const isMode = (value: string): value is Mode => MODE_SET.has(value);
