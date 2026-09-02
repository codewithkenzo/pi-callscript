import { isCallStep, type JsonValue, type Script } from "callscript";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ObjectSchema = Type.Record(Type.String(), Type.Unknown);
const StringSchema = Type.String();
const NumberSchema = Type.Number();
type BoundaryArgs = Record<string, JsonValue>;

const isObject = (value: JsonValue): value is BoundaryArgs => Value.Check(ObjectSchema, value);

export class CapabilityBoundaryError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("\n"));
    this.name = "CapabilityBoundaryError";
    this.issues = issues;
  }
}

const literalString = (value: JsonValue | undefined) =>
  Value.Check(StringSchema, value) && !value.startsWith("=") ? value : undefined;

const literalNumber = (value: JsonValue | undefined) =>
  Value.Check(NumberSchema, value) ? value : undefined;

const pathIssue = (step: string, value: JsonValue | undefined) => {
  const path = literalString(value);
  if (path === undefined) return undefined;
  if (path.length === 0) return `${step}: path must not be empty`;
  if (path.includes("\0")) return `${step}: path must not contain a NUL byte`;
  return undefined;
};

const validateHttp = (step: string, args: BoundaryArgs, issues: string[]) => {
  const url = literalString(args.url);
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        issues.push(`${step}: URL protocol must be http or https`);
    } catch {
      issues.push(`${step}: URL must be absolute http or https`);
    }
  }
  const method = literalString(args.method) ?? "GET";
  if ((method === "GET" || method === "HEAD") && args.body !== undefined)
    issues.push(`${step}: ${method} must not include body`);
};

export const validateCapabilityBoundaries = (script: Script) => {
  const issues: string[] = [];
  for (const step of script.steps) {
    if (!isCallStep(step) || step.args === undefined || !isObject(step.args)) continue;
    const args = step.args;
    if (["read", "write", "edit", "search", "find", "list"].includes(step.call)) {
      const issue = pathIssue(step.id, args.path);
      if (issue !== undefined) issues.push(issue);
    }
    if (step.call === "read") {
      if (args.tail !== undefined && args.offset !== undefined)
        issues.push(`${step.id}: tail and offset are mutually exclusive`);
      for (const key of ["tail", "offset", "limit"] as const) {
        const value = literalNumber(args[key]);
        const minimum = key === "offset" ? 0 : 1;
        if (value !== undefined && (!Number.isInteger(value) || value < minimum))
          issues.push(
            `${step.id}: ${key} must be ${minimum === 0 ? "a non-negative" : "a positive"} integer`,
          );
      }
    }
    if (step.call === "http") validateHttp(step.id, args, issues);
    if (step.call === "wait") {
      const value = literalNumber(args.milliseconds);
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 600_000))
        issues.push(`${step.id}: milliseconds must be an integer from 0 through 600000`);
    }
    if (step.call === "run") {
      const timeout = literalNumber(args.timeout);
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 600))
        issues.push(`${step.id}: timeout uses seconds and must be an integer from 1 through 600`);
    }
  }
  if (issues.length > 0) throw new CapabilityBoundaryError(issues);
  return script;
};
