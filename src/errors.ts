import { Data } from "effect";

const messageFrom = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class SourceValidationFailure extends Data.TaggedError("SourceValidationFailure")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(cause: unknown) {
    return new SourceValidationFailure({ message: messageFrom(cause), cause });
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
}> {}

export class RuntimeDefect extends Data.TaggedError("RuntimeDefect")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  static from(cause: unknown) {
    return new RuntimeDefect({ message: messageFrom(cause), cause });
  }
}
