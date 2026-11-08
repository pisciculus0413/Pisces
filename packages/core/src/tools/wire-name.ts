import type { EntryName } from "../messages.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const prefix = "t_";

export function encodeWireName(name: EntryName): string {
  const bytes: number[] = [];
  for (let index = 0; index < name.length; index++) {
    const codeUnit = name.charCodeAt(index);
    bytes.push(codeUnit & 0xff, codeUnit >>> 8);
  }

  let encoded = prefix;
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >>> 2] as string;
    encoded += alphabet[((first & 0b11) << 4) | ((second ?? 0) >>> 4)] as string;
    if (second !== undefined) {
      encoded += alphabet[((second & 0b1111) << 2) | ((third ?? 0) >>> 6)] as string;
    }
    if (third !== undefined) encoded += alphabet[third & 0b111111] as string;
  }
  return encoded;
}

export function decodeWireName(value: string): EntryName | undefined {
  if (!value.startsWith(prefix)) return undefined;
  const encoded = value.slice(prefix.length);
  if (encoded.length === 0 || encoded.length % 4 === 1) return undefined;

  const values: number[] = [];
  for (const character of encoded) {
    const index = alphabet.indexOf(character);
    if (index < 0) return undefined;
    values.push(index);
  }

  const bytes: number[] = [];
  for (let index = 0; index < values.length; index += 4) {
    const first = values[index] as number;
    const second = values[index + 1] as number;
    const third = values[index + 2];
    const fourth = values[index + 3];
    bytes.push((first << 2) | (second >>> 4));
    if (third !== undefined) bytes.push(((second & 0b1111) << 4) | (third >>> 2));
    if (fourth !== undefined) bytes.push(((third as number) << 6) | fourth);
  }
  if (bytes.length % 2 !== 0) return undefined;

  let decoded = "";
  for (let index = 0; index < bytes.length; index += 2) {
    decoded += String.fromCharCode((bytes[index] as number) | ((bytes[index + 1] as number) << 8));
  }
  return encodeWireName(decoded as EntryName) === value ? (decoded as EntryName) : undefined;
}
