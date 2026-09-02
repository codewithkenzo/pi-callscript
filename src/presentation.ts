import { stableStringify } from "callscript";
import { Schema } from "effect";

export interface ContinuationReceipt {
  readonly kind: "text" | "items";
  readonly offset: number;
  readonly remainingItems: number;
}

export interface ProjectionReceipt {
  readonly originalBytes: number;
  readonly shownBytes: number;
  readonly hiddenBytes: number;
  readonly originalLines: number;
  readonly shownLines: number;
  readonly hiddenLines: number;
  readonly originalItems: number;
  readonly shownItems: number;
  readonly hiddenItems: number;
  readonly continuation?: ContinuationReceipt;
}

export interface PresentationItem {
  readonly key?: string;
  readonly index?: number;
  readonly preview: string;
}

export interface OperationPresentation {
  readonly kind: "text" | "structured" | "scalar";
  readonly content: string;
  readonly items: readonly PresentationItem[];
  readonly receipt: ProjectionReceipt;
}

export type OperationPresentationDetails = Omit<OperationPresentation, "content">;

export interface EditActivityPresentation {
  readonly kind: "edit";
  readonly diff: string;
  readonly patch: string;
  readonly firstChangedLine?: number;
  readonly hunkCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
}

export type ActivityPresentation = EditActivityPresentation;

const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isBoolean = Schema.is(Schema.Boolean);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

const lineCount = (text: string) => {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
};

const compact = (text: string, maximum = 120) => {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length <= maximum) return value;
  const head = Math.ceil((maximum - 1) / 2);
  const tail = Math.floor((maximum - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
};

const serialized = <T>(value: T) => {
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
};

const preview = <T>(value: T) => compact(isString(value) ? value : serialized(value));

interface TextSlice {
  readonly head: string;
  readonly tail: string;
  readonly shownBytes: number;
  readonly headBytes: number;
}

const textSlice = (text: string, maximumBytes: number): TextSlice => {
  const points = Array.from(text);
  const headLimit = Math.ceil(maximumBytes / 2);
  const tailLimit = Math.floor(maximumBytes / 2);
  let head = "";
  let headBytes = 0;
  let headIndex = 0;
  while (headIndex < points.length) {
    const point = points[headIndex] ?? "";
    const size = byteLength(point);
    if (headBytes + size > headLimit) break;
    head += point;
    headBytes += size;
    headIndex += 1;
  }
  let tail = "";
  let tailBytes = 0;
  let tailIndex = points.length - 1;
  while (tailIndex >= headIndex) {
    const point = points[tailIndex] ?? "";
    const size = byteLength(point);
    if (tailBytes + size > tailLimit) break;
    tail = point + tail;
    tailBytes += size;
    tailIndex -= 1;
  }
  return { head, tail, shownBytes: headBytes + tailBytes, headBytes };
};

const textMarker = (hiddenLines: number, hiddenBytes: number, offset: number) =>
  `[truncated: ${hiddenLines} lines, ${hiddenBytes} bytes hidden; continue at byte ${offset}]`;

const boundedText = (text: string, maximumBytes: number) => {
  const originalBytes = byteLength(text);
  const originalLines = lineCount(text);
  if (originalBytes <= maximumBytes) {
    return {
      content: text,
      receipt: {
        originalBytes,
        shownBytes: originalBytes,
        hiddenBytes: 0,
        originalLines,
        shownLines: originalLines,
        hiddenLines: 0,
        originalItems: 0,
        shownItems: 0,
        hiddenItems: 0,
      } satisfies ProjectionReceipt,
    };
  }

  let low = 0;
  let high = maximumBytes;
  let selected = textSlice(text, 0);
  let content = "";
  let receipt: ProjectionReceipt | undefined;
  while (low <= high) {
    const candidateBudget = Math.floor((low + high) / 2);
    const candidate = textSlice(text, candidateBudget);
    const shownLines = Math.min(
      originalLines,
      lineCount(candidate.head) + lineCount(candidate.tail),
    );
    const hiddenLines = originalLines - shownLines;
    const hiddenBytes = originalBytes - candidate.shownBytes;
    const marker = textMarker(hiddenLines, hiddenBytes, candidate.headBytes);
    const candidateContent = `${candidate.head}\n${marker}\n${candidate.tail}`;
    if (byteLength(candidateContent) <= maximumBytes) {
      selected = candidate;
      content = candidateContent;
      receipt = {
        originalBytes,
        shownBytes: candidate.shownBytes,
        hiddenBytes,
        originalLines,
        shownLines,
        hiddenLines,
        originalItems: 0,
        shownItems: 0,
        hiddenItems: 0,
        continuation: { kind: "text", offset: candidate.headBytes, remainingItems: 0 },
      };
      low = candidateBudget + 1;
    } else {
      high = candidateBudget - 1;
    }
  }
  if (receipt === undefined) throw new RangeError(`Output limit ${maximumBytes} is too small`);
  return { content, receipt, selected };
};

const structuredItems = <T>(value: T): readonly PresentationItem[] => {
  if (Array.isArray(value))
    return value.map((entry, index) => ({ index, preview: preview(entry) }));
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({ key, preview: preview(value[key]) }));
};

const itemValue = (item: PresentationItem) => item.preview;

const structuredCandidate = (
  array: boolean,
  items: readonly PresentationItem[],
  shownItems: number,
) => {
  const visible = items.slice(0, shownItems);
  if (array) return serialized(visible.map(itemValue));
  return serialized(Object.fromEntries(visible.map((item) => [item.key ?? "", itemValue(item)])));
};

const itemMarker = (hiddenItems: number, hiddenBytes: number, offset: number) =>
  `[truncated: ${hiddenItems} items, ${hiddenBytes} bytes hidden; continue at item ${offset}]`;

const structuredPresentation = <T>(value: T, maximumBytes: number): OperationPresentation => {
  const full = serialized(value);
  const originalBytes = byteLength(full);
  const originalLines = lineCount(full);
  const items = structuredItems(value);
  if (originalBytes <= maximumBytes) {
    return {
      kind: "structured",
      content: full,
      items,
      receipt: {
        originalBytes,
        shownBytes: originalBytes,
        hiddenBytes: 0,
        originalLines,
        shownLines: originalLines,
        hiddenLines: 0,
        originalItems: items.length,
        shownItems: items.length,
        hiddenItems: 0,
      },
    };
  }

  const array = Array.isArray(value);
  let shownItems = 0;
  let shown = structuredCandidate(array, items, 0);
  let content = "";
  for (let count = 0; count <= items.length; count += 1) {
    const candidate = structuredCandidate(array, items, count);
    const candidateBytes = byteLength(candidate);
    const hiddenItems = items.length - count;
    const hiddenBytes = Math.max(0, originalBytes - candidateBytes);
    const next = `${candidate}\n${itemMarker(hiddenItems, hiddenBytes, count)}`;
    if (byteLength(next) > maximumBytes) break;
    shownItems = count;
    shown = candidate;
    content = next;
  }
  if (content.length === 0) throw new RangeError(`Output limit ${maximumBytes} is too small`);
  const shownBytes = byteLength(shown);
  const hiddenItems = items.length - shownItems;
  const hiddenBytes = Math.max(0, originalBytes - shownBytes);
  return {
    kind: "structured",
    content,
    items: items.slice(0, shownItems),
    receipt: {
      originalBytes,
      shownBytes,
      hiddenBytes,
      originalLines,
      shownLines: lineCount(shown),
      hiddenLines: Math.max(0, originalLines - lineCount(shown)),
      originalItems: items.length,
      shownItems,
      hiddenItems,
      continuation: { kind: "items", offset: shownItems, remainingItems: hiddenItems },
    },
  };
};

export const projectPresentation = <T>(value: T, maximumBytes: number): OperationPresentation => {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1)
    throw new RangeError(`Output limit ${maximumBytes} must be a positive integer`);
  if (isString(value)) {
    const bounded = boundedText(value, maximumBytes);
    return { kind: "text", content: bounded.content, items: [], receipt: bounded.receipt };
  }
  if (Array.isArray(value) || isRecord(value)) return structuredPresentation(value, maximumBytes);
  const content =
    value === null || isNumber(value) || isBoolean(value) ? String(value) : serialized(value);
  const bounded = boundedText(content, maximumBytes);
  return { kind: "scalar", content: bounded.content, items: [], receipt: bounded.receipt };
};

export const presentationText = (presentation: OperationPresentation) => presentation.content;

export const presentationDetails = (presentation: OperationPresentation) => {
  const details: OperationPresentationDetails = {
    kind: presentation.kind,
    items: presentation.items,
    receipt: presentation.receipt,
  };
  return details;
};
