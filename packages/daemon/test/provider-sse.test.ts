import { expect, test, vi } from "vitest";
import { parseSseStream } from "../src/provider/sse.js";

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

test("frames UTF-8 and mixed line endings across arbitrary byte boundaries", async () => {
  const bytes = encoder.encode(
    ": comment\r\ndata: first\r\ndata: 中文🐟\r\n\r\n" + 'event: message\rdata: {"x":1}\r\r',
  );
  const chunks = [bytes.slice(0, 1), bytes.slice(1, 7), bytes.slice(7, 31), bytes.slice(31)];

  await expect(collect(parseSseStream(streamOf(chunks)))).resolves.toEqual([
    "first\n中文🐟",
    '{"x":1}',
  ]);
});

test("preserves split multibyte code points for every two-chunk boundary", async () => {
  const bytes = encoder.encode("data: 中文🐟\n\n");
  for (let split = 0; split <= bytes.length; split++) {
    await expect(
      collect(parseSseStream(streamOf([bytes.slice(0, split), bytes.slice(split)]))),
    ).resolves.toEqual(["中文🐟"]);
  }
});

test("joins multiple data fields and removes only one optional space", async () => {
  const input = encoder.encode("data: first\ndata:  second\ndata:\tthird\n\n");

  await expect(collect(parseSseStream(streamOf([input])))).resolves.toEqual([
    "first\n second\n\tthird",
  ]);
});

test("dispatches empty data events and ignores blank lines without data", async () => {
  const input = encoder.encode("data:\n\ndata\n\n\ndata: \n\n");

  await expect(collect(parseSseStream(streamOf([input])))).resolves.toEqual(["", "", ""]);
});

test("ignores comments and non-data fields", async () => {
  const input = encoder.encode(
    ": comment\nid: 7\nretry: 100\nevent: message\ndata: payload\n\ndata: next\n\n",
  );

  await expect(collect(parseSseStream(streamOf([input])))).resolves.toEqual(["payload", "next"]);
});

test("dispatches a final data event at EOF without a blank line", async () => {
  const input = encoder.encode("data: first\n\ndata: final");

  await expect(collect(parseSseStream(streamOf([input])))).resolves.toEqual(["first", "final"]);
});

test("handles CRLF split between carriage return and line feed", async () => {
  const bytes = encoder.encode("data: value\r\n\r\n");
  const split = bytes.indexOf(0x0d) + 1;

  await expect(
    collect(parseSseStream(streamOf([bytes.slice(0, split), bytes.slice(split)]))),
  ).resolves.toEqual(["value"]);
});

test("propagates source stream failure", async () => {
  const failure = new Error("stream failed");
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });

  await expect(collect(parseSseStream(stream))).rejects.toBe(failure);
});

test("cancels the source stream when the consumer exits early", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: first\n\n"));
    },
    cancel,
  });
  const iterator = parseSseStream(stream)[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
  await iterator.return?.(undefined);

  expect(cancel).toHaveBeenCalledOnce();
});
