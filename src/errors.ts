import { Data } from "effect";

import { validationMessage } from "./language.js";

const messageFrom = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class SourceValidationFailure extends Data.TaggedError("SourceValidationFailure")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(cause: unknown) {
    return new SourceValidationFailure({ message: validationMessage(cause), cause });
  }
}

export class ToolInvocationFailure extends Data.TaggedError("ToolInvocationFailure")<{
  readonly tool: string;
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(tool: string, cause: unknown) {
    return new ToolInvocationFailure({
      tool,
      message: tool + ": " + messageFrom(cause),
      cause,
    });
  }
}

export class StreamUpdateFailure extends Data.TaggedError("StreamUpdateFailure")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(cause: unknown) {
    return new StreamUpdateFailure({ message: messageFrom(cause), cause });
  }
}

export class OutputBoundsFailure extends Data.TaggedError("OutputBoundsFailure")<{
  readonly measuredBytes: number;
  readonly maximumBytes: number;
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(measuredBytes: number, maximumBytes: number, cause: unknown) {
    return new OutputBoundsFailure({
      measuredBytes,
      maximumBytes,
      message: `Output projection measured ${measuredBytes} bytes; limit is ${maximumBytes} bytes`,
      cause,
    });
  }
}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly path: string;
  readonly reason: string;
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(path: string, cause: unknown) {
    const reason = messageFrom(cause);
    return new ConfigError({
      path,
      reason,
      message: `Invalid CallScript config at ${path}: ${reason}`,
      cause,
    });
  }
}

export class RuntimeDefect extends Data.TaggedError("RuntimeDefect")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(cause: unknown) {
    return new RuntimeDefect({ message: messageFrom(cause), cause });
  }
}
