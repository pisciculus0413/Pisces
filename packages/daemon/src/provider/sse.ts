interface DrainResult {
  lines: string[];
  rest: string;
}

function drainLines(buffer: string, eof: boolean): DrainResult {
  const lines: string[] = [];
  let start = 0;

  for (let index = 0; index < buffer.length; index++) {
    const code = buffer.charCodeAt(index);
    if (code === 10) {
      lines.push(buffer.slice(start, index));
      start = index + 1;
      continue;
    }
    if (code !== 13) continue;
    if (index + 1 === buffer.length && !eof) break;
    const end = index;
    if (buffer.charCodeAt(index + 1) === 10) index++;
    lines.push(buffer.slice(start, end));
    start = index + 1;
  }

  return { lines, rest: buffer.slice(start) };
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let hasData = false;
  let dataLines: string[] = [];

  function consumeLine(line: string): string | undefined {
    if (line === "") {
      if (!hasData) return undefined;
      const data = dataLines.join("\n");
      hasData = false;
      dataLines = [];
      return data;
    }
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return undefined;

    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    hasData = true;
    dataLines.push(value);
    return undefined;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const drained = drainLines(buffer, false);
      buffer = drained.rest;
      for (const line of drained.lines) {
        const data = consumeLine(line);
        if (data !== undefined) yield data;
      }
    }

    completed = true;
    buffer += decoder.decode();
    const drained = drainLines(buffer, true);
    for (const line of drained.lines) {
      const data = consumeLine(line);
      if (data !== undefined) yield data;
    }
    if (drained.rest) {
      const data = consumeLine(drained.rest);
      if (data !== undefined) yield data;
    }
    if (hasData) yield dataLines.join("\n");
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the source failure or consumer-driven early exit.
      }
    }
    reader.releaseLock();
  }
}
