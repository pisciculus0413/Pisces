import { describe, expect, it } from "vitest";
import {
  createNdjsonDecoder,
  encodeFrame,
  FrameTooLarge,
  MAX_EVENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_RESPONSE_BYTES,
} from "../src/index.ts";

const LF = 0x0a;
const CR = 0x0d;
const FILLER = 0x61;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf8Fatal = new TextDecoder("utf-8", { fatal: true });
const asText = (line: Uint8Array): string => utf8Fatal.decode(line);

/** JSON string literal whose UTF-8 encoding is exactly `totalBytes` long. */
const asciiJsonOfBytes = (totalBytes: number): string => `"${"a".repeat(totalBytes - 2)}"`;

/** Raw string value that JSON-encodes to exactly `totalBytes` UTF-8 bytes. */
const asciiValueOfJsonBytes = (totalBytes: number): string => "a".repeat(totalBytes - 2);

/** Collects emitted lines so decoder behavior stays observable. */
function collectLines() {
  const lines: Uint8Array[] = [];
  const decoder = createNdjsonDecoder((line) => lines.push(line));
  return { decoder, lines };
}

const textLines = (lines: Uint8Array[]): string[] => lines.map(asText);

describe("createNdjsonDecoder", () => {
  it("accepts a frame of exactly MAX_FRAME_BYTES including LF", () => {
    const { decoder, lines } = collectLines();
    const contentLength = 8_388_607;
    const content = new Uint8Array(contentLength).fill(FILLER);
    const third = Math.trunc(contentLength / 3);

    decoder.push(content.subarray(0, third));
    decoder.push(content.subarray(third, third * 2));
    decoder.push(content.subarray(third * 2));
    decoder.push(new Uint8Array([LF]));
    decoder.finish();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.byteLength).toBe(contentLength);
    expect(lines[0]?.[0]).toBe(FILLER);
    expect(lines[0]?.[contentLength - 1]).toBe(FILLER);
  });

  it("rejects a frame one byte over MAX_FRAME_BYTES", () => {
    const { decoder, lines } = collectLines();
    const frame = new Uint8Array(8_388_609).fill(FILLER);
    frame[frame.length - 1] = LF;
    const chunkSize = 2_000_000;

    const decodeAll = () => {
      for (let offset = 0; offset < frame.length; offset += chunkSize) {
        decoder.push(frame.subarray(offset, offset + chunkSize));
      }
    };

    expect(decodeAll).toThrow(FrameTooLarge);
    expect(lines).toHaveLength(0);
  });

  it("preserves UTF-8 sequences split across chunks", () => {
    const expected = utf8("héllo 𝄞");
    const { decoder, lines } = collectLines();

    decoder.push(expected.subarray(0, 2));
    decoder.push(expected.subarray(2, 5));
    decoder.push(expected.subarray(5));
    decoder.push(new Uint8Array([LF]));
    decoder.finish();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(expected);
    expect(asText(lines[0] as Uint8Array)).toBe("héllo 𝄞");
  });

  it("splits two frames pushed in one chunk", () => {
    const { decoder, lines } = collectLines();

    decoder.push(utf8("alpha\nbeta\n"));
    decoder.finish();

    expect(textLines(lines)).toEqual(["alpha", "beta"]);
  });

  it("keeps a carriage return as part of the frame bytes", () => {
    const { decoder, lines } = collectLines();

    decoder.push(utf8("a\r\nb\n"));
    decoder.finish();

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(new Uint8Array([0x61, CR]));
    expect(textLines(lines)).toEqual(["a\r", "b"]);
  });

  it("refuses further input after a frame overflow", () => {
    const { decoder, lines } = collectLines();
    const frame = new Uint8Array(8_388_609).fill(FILLER);
    frame[frame.length - 1] = LF;

    expect(() => decoder.push(frame)).toThrow(FrameTooLarge);
    expect(() => decoder.push(utf8("later\n"))).toThrow(FrameTooLarge);
    expect(() => decoder.finish()).toThrow(FrameTooLarge);
    expect(lines).toHaveLength(0);
  });

  it("keeps retained heap proportional to frame bytes under tiny fragments", () => {
    const { decoder, lines } = collectLines();
    const fragmentCount = 500_000;
    const fragment = new Uint8Array([FILLER]);

    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < fragmentCount; index += 1) {
      decoder.push(fragment);
    }
    const retained = process.memoryUsage().heapUsed - before;

    expect(retained).toBeLessThan(8 * 1024 * 1024);
    expect(lines).toHaveLength(0);

    decoder.push(new Uint8Array([LF]));
    decoder.finish();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.byteLength).toBe(fragmentCount);
    expect(lines[0]?.[0]).toBe(FILLER);
    expect(lines[0]?.[fragmentCount - 1]).toBe(FILLER);
  });

  it("fails finish for an incomplete trailing line", () => {
    const { decoder } = collectLines();
    decoder.push(utf8("complete\npartial"));

    let error: unknown;
    try {
      decoder.finish();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FrameTooLarge);
    expect((error as Error).message).toMatch(/incomplete/i);
  });
});

describe("encodeFrame", () => {
  it.each([
    ["response", MAX_RESPONSE_BYTES],
    ["event", MAX_EVENT_BYTES],
  ])("encodes a %s payload of exactly 4 MiB and rejects one byte more", (_kind, maxBytes) => {
    expect(maxBytes).toBe(4_194_304);

    const atLimit = encodeFrame(asciiValueOfJsonBytes(4_194_304), maxBytes);
    expect(atLimit.byteLength).toBe(4_194_305);
    expect(atLimit[atLimit.length - 1]).toBe(LF);
    expect(asText(atLimit.subarray(0, atLimit.length - 1))).toBe(asciiJsonOfBytes(4_194_304));

    expect(() => encodeFrame(asciiValueOfJsonBytes(4_194_305), maxBytes)).toThrow(RangeError);
  });

  it("counts UTF-8 bytes rather than UTF-16 code units", () => {
    const atLimit = "é".repeat(2_097_151);
    expect(utf8(atLimit).byteLength + 2).toBe(4_194_304);
    expect(encodeFrame(atLimit, MAX_RESPONSE_BYTES).byteLength).toBe(4_194_305);

    const overLimit = `${atLimit}a`;
    expect(utf8(overLimit).byteLength + 2).toBe(4_194_305);
    expect(() => encodeFrame(overLimit, MAX_RESPONSE_BYTES)).toThrow(RangeError);
  });

  it("enforces MAX_FRAME_BYTES on the emitted frame including LF", () => {
    const largestPayload = asciiValueOfJsonBytes(8_388_607);
    expect(encodeFrame(largestPayload, MAX_FRAME_BYTES).byteLength).toBe(8_388_608);

    expect(() => encodeFrame(asciiValueOfJsonBytes(8_388_608), MAX_FRAME_BYTES)).toThrow(
      FrameTooLarge,
    );
  });
});
