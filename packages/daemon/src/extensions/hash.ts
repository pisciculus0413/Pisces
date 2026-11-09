import { createHash } from "node:crypto";
import { type JsonValue, PiscesError } from "@pisces/core";

const INVALID_JSON = "Value is not valid JSON";

function invalidJson(): never {
  throw new PiscesError("config.invalid", INVALID_JSON);
}

function encode(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) invalidJson();
      return JSON.stringify(value);
    case "object":
      break;
    default:
      return invalidJson();
  }
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(",")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidJson();
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`);
  return `{${fields.join(",")}}`;
}

export function canonicalJson(value: JsonValue): string {
  return encode(value);
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
