import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createReadToolDefinition,
  type ReadToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const MAX_LINES = 2_000;
const MAX_BYTES = 50 * 1_024;

export const ReadSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 32_768 }),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    tail: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINES })),
  },
  { additionalProperties: false },
);

export interface ReadNavigation {
  shown: { first: number; last: number };
  totalLines: number;
  previousOffset?: number;
  nextOffset?: number;
  truncation: "none" | "limit" | "lines" | "bytes" | "tail";
}

const IMAGE_SUFFIX = /\.(?:bmp|gif|jpe?g|png|webp)$/i;

const receipt = (navigation: ReadNavigation) => {
  const previous = navigation.previousOffset ?? "none";
  const next = navigation.nextOffset ?? "none";
  return `[Read lines ${navigation.shown.first}-${navigation.shown.last} of ${navigation.totalLines}; previousOffset=${previous}; nextOffset=${next}; truncation=${navigation.truncation}]`;
};

export const createInvocationReadDefinition = (
  cwd: string,
): ToolDefinition<typeof ReadSchema, ReadToolDetails | undefined, unknown> => {
  const native = createReadToolDefinition(cwd);
  return {
    ...native,
    description:
      "Read text or images. Text supports offset/limit or tail. Returns an exact navigation receipt with shown range, total lines, previous and next offsets, and truncation reason.",
    parameters: ReadSchema,
    async execute(toolCallId, args: Static<typeof ReadSchema>, signal, onUpdate, ctx) {
      if (args.tail !== undefined && args.offset !== undefined)
        throw new Error("tail and offset are mutually exclusive");
      if (args.path.includes("\0")) throw new Error("path contains a NUL byte");
      if (IMAGE_SUFFIX.test(args.path))
        return native.execute(toolCallId, args, signal, onUpdate, ctx);
      if (signal?.aborted) throw new Error("Operation aborted");

      const text = await readFile(resolve(ctx.cwd, args.path), "utf8");
      if (signal?.aborted) throw new Error("Operation aborted");
      const lines =
        text.length === 0
          ? [""]
          : text.endsWith("\n")
            ? text.slice(0, -1).split("\n")
            : text.split("\n");
      const totalLines = lines.length;
      const requestedStart =
        args.tail === undefined
          ? args.offset === undefined
            ? 0
            : Math.max(0, args.offset - 1)
          : Math.max(0, totalLines - args.tail);
      if (requestedStart >= totalLines)
        throw new Error(`Offset ${args.offset} is beyond end of file (${totalLines} lines total)`);
      const requestedCount = args.tail ?? args.limit ?? MAX_LINES;
      const outputCount = Math.min(requestedCount, MAX_LINES);
      let end = Math.min(totalLines, requestedStart + outputCount);
      let selected = lines.slice(requestedStart, end).join("\n");
      let truncation: ReadNavigation["truncation"] =
        args.tail !== undefined && requestedStart > 0
          ? "tail"
          : args.limit !== undefined && args.limit <= MAX_LINES && end < totalLines
            ? "limit"
            : end < totalLines
              ? "lines"
              : "none";
      while (Buffer.byteLength(selected, "utf8") > MAX_BYTES && end > requestedStart + 1) {
        end -= 1;
        selected = lines.slice(requestedStart, end).join("\n");
        truncation = "bytes";
      }
      if (Buffer.byteLength(selected, "utf8") > MAX_BYTES) {
        selected = Buffer.from(selected).subarray(0, MAX_BYTES).toString("utf8");
        truncation = "bytes";
      }
      const shownCount = Math.max(1, end - requestedStart);
      const navigation: ReadNavigation = {
        shown: { first: requestedStart + 1, last: requestedStart + shownCount },
        totalLines,
        truncation,
      };
      if (requestedStart > 0)
        navigation.previousOffset = Math.max(1, requestedStart + 1 - outputCount);
      if (end < totalLines && args.tail === undefined) navigation.nextOffset = end + 1;
      return {
        content: [{ type: "text", text: `${selected}\n\n${receipt(navigation)}` }],
        details: undefined,
      };
    },
  };
};
