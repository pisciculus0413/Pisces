/** Thin fetch/SSE wrapper: the console holds no state here beyond the stream handle. */

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

const toError = (status: number, body: unknown): ApiError => {
  const error = (body as ErrorBody | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : `http.${status}`;
  const message = typeof error?.message === "string" ? error.message : `Request failed (${status})`;
  return new ApiError(code, message);
};

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) throw toError(response.status, body);
  return body;
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await parse(await fetch(path, { headers: { accept: "application/json" } }))) as T;
}

export async function apiSend<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  return (await parse(
    await fetch(path, {
      method,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )) as T;
}

export interface EventStreamHandlers {
  onEvent(event: { event: string; data: unknown }): void;
  /** Called after a reconnect so the caller can re-read the session and resync `seq`. */
  onReconnect(): void;
}

/**
 * `EventSource` reconnects on its own, but only after a fixed delay and without
 * telling us when the gap started. Owning the retry keeps the backoff bounded
 * and gives the caller a resync hook.
 */
export function openEventStream(sessionId: string, handlers: EventStreamHandlers): () => void {
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
    source.onopen = () => {
      if (attempt > 0) handlers.onReconnect();
      attempt = 0;
    };
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        handlers.onEvent(JSON.parse(message.data) as { event: string; data: unknown });
      } catch {
        // Ignore a frame the console cannot parse; the next `session.read` resyncs.
      }
    };
    source.onerror = () => {
      source?.close();
      source = undefined;
      if (closed) return;
      attempt += 1;
      timer = setTimeout(connect, Math.min(8000, 1000 * 2 ** (attempt - 1)));
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    source?.close();
  };
}
