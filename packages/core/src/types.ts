export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Brand<T extends string> = string & { readonly __brand: T };

export class PiscesError extends Error {
  readonly code: string;
  readonly data?: JsonValue;
  override readonly cause?: unknown;

  constructor(code: string, message: string, options?: { data?: JsonValue; cause?: unknown }) {
    super(message);
    this.name = "PiscesError";
    this.code = code;
    if (options?.data !== undefined) this.data = options.data;
    this.cause = options?.cause;
  }
}
