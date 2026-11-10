import { PiscesError } from "@pisces/core";

/**
 * Dot path grammar for the `config` commands.
 *
 * Segments are separated by dots. A bare all-digit segment addresses an array
 * index; any other bare segment is an object key. A JSON-quoted segment
 * (`entryConfig."@scope/pkg#tool".timeout`) addresses a key that contains dots
 * and always stays a string key. `-` marks the append slot of an array.
 *
 * Empty segments and the prototype keys are rejected so a path can never touch
 * `Object.prototype`.
 */

const INVALID_MESSAGE = "Invalid configuration";
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const INDEX_SEGMENT = /^(?:0|[1-9][0-9]*)$/u;

const isIndex = (segment: ConfigPathSegment): segment is number =>
  typeof segment === "number" && Number.isInteger(segment) && segment >= 0;

export type ConfigPathSegment = string | number;

function invalid(): never {
  throw new PiscesError("config.invalid", INVALID_MESSAGE);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) define(result, key, clone(value[key]));
  return result;
}

function readQuotedSegment(input: string, start: number): { value: string; next: number } {
  let end = start + 1;
  while (end < input.length) {
    const character = input[end];
    if (character === "\\") {
      end += 2;
      continue;
    }
    if (character === '"') break;
    end += 1;
  }
  if (end >= input.length) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.slice(start, end + 1));
  } catch {
    invalid();
  }
  if (typeof parsed !== "string" || parsed === "") invalid();
  return { value: parsed, next: end + 1 };
}

function readBareSegment(input: string, start: number): { value: string; next: number } {
  let end = start;
  while (end < input.length && input[end] !== ".") end += 1;
  const value = input.slice(start, end);
  // A bare segment is unquoted: an embedded quote is a malformed quoted segment.
  if (value === "" || value.includes('"')) invalid();
  return { value, next: end };
}

function toSegment(raw: string, quoted: boolean): ConfigPathSegment {
  if (!quoted && INDEX_SEGMENT.test(raw)) {
    const index = Number(raw);
    if (Number.isSafeInteger(index)) return index;
  }
  return raw;
}

export function parseConfigPath(input: string): ConfigPathSegment[] {
  if (input === "") invalid();
  const segments: ConfigPathSegment[] = [];
  let position = 0;

  while (position < input.length) {
    const quoted = input[position] === '"';
    const parsed = quoted ? readQuotedSegment(input, position) : readBareSegment(input, position);
    if (FORBIDDEN_SEGMENTS.has(parsed.value)) invalid();
    segments.push(toSegment(parsed.value, quoted));
    position = parsed.next;

    if (position === input.length) break;
    if (input[position] !== ".") invalid();
    position += 1;
    // A trailing dot leaves an empty segment.
    if (position === input.length) invalid();
  }

  return segments;
}

/** Reads a value without following inherited properties; `undefined` means missing. */
export function getValue(root: unknown, path: readonly ConfigPathSegment[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!isIndex(segment) || segment >= current.length) return undefined;
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) return undefined;
    const key = String(segment);
    if (!Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Descends into a child container, creating missing object parents. */
function containerForSet(parent: unknown, segment: ConfigPathSegment): unknown {
  if (Array.isArray(parent)) {
    if (segment === "-") {
      const created: Record<string, unknown> = {};
      parent.push(created);
      return created;
    }
    if (!isIndex(segment) || segment >= parent.length) invalid();
    const existing = parent[segment];
    if (isRecord(existing) || Array.isArray(existing)) return existing;
    invalid();
  }
  if (!isRecord(parent)) invalid();
  const key = String(segment);
  if (Object.hasOwn(parent, key)) {
    const existing = parent[key];
    if (isRecord(existing) || Array.isArray(existing)) return existing;
    invalid();
  }
  const created: Record<string, unknown> = {};
  define(parent, key, created);
  return created;
}

function childForUnset(parent: unknown, segment: ConfigPathSegment): unknown {
  if (Array.isArray(parent)) {
    if (!isIndex(segment) || segment >= parent.length) return undefined;
    return parent[segment];
  }
  if (!isRecord(parent)) return undefined;
  const key = String(segment);
  if (!Object.hasOwn(parent, key)) return undefined;
  return parent[key];
}

function assign(parent: unknown, segment: ConfigPathSegment, value: unknown): void {
  if (Array.isArray(parent)) {
    if (segment === "-") {
      parent.push(value);
      return;
    }
    if (!isIndex(segment) || segment >= parent.length) invalid();
    parent[segment] = value;
    return;
  }
  if (!isRecord(parent)) invalid();
  define(parent, String(segment), value);
}

/** Returns a copy of `root` with `value` written at `path`; `root` is never mutated. */
export function setValue(
  root: unknown,
  path: readonly ConfigPathSegment[],
  value: unknown,
): unknown {
  const last = path[path.length - 1];
  if (last === undefined) invalid();
  const result = clone(root);
  let parent: unknown = result;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (segment === undefined) invalid();
    parent = containerForSet(parent, segment);
  }
  assign(parent, last, clone(value));
  return result;
}

/**
 * Returns a copy of `root` without the value at `path`, or `undefined` when the
 * path does not exist. Array elements are removed, not replaced by `null`.
 */
export function unsetValue(root: unknown, path: readonly ConfigPathSegment[]): unknown | undefined {
  const last = path[path.length - 1];
  if (last === undefined) return undefined;
  const result = clone(root);
  let parent: unknown = result;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (segment === undefined) return undefined;
    parent = childForUnset(parent, segment);
    if (parent === undefined) return undefined;
  }
  if (Array.isArray(parent)) {
    if (!isIndex(last) || last >= parent.length) return undefined;
    parent.splice(last, 1);
    return result;
  }
  if (!isRecord(parent)) return undefined;
  const key = String(last);
  if (!Object.hasOwn(parent, key)) return undefined;
  delete parent[key];
  return result;
}
