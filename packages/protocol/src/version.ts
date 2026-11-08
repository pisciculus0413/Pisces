/**
 * 协议版本与握手版本协商。
 */

/** 协议版本，用于客户端与 daemon 的版本协商。 */
export const PROTOCOL_VERSION = "0.0.1";

/** 严格的 `MAJOR.MINOR.PATCH`：纯数字、无前导零、无预发布标记。 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface ParsedVersion {
  major: number;
  minor: number;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) {
    return undefined;
  }
  const [, majorText = "", minorText = ""] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    return undefined;
  }
  return { major, minor };
}

/**
 * 按客户端优先级选择第一个兼容版本：主版本相同、次版本不高于服务端。
 *
 * 客户端版本或服务端版本不合法时跳过/返回 `undefined`；`serverVersion` 默认
 * 为 {@link PROTOCOL_VERSION}。
 */
export function negotiateVersion(
  versions: readonly string[],
  serverVersion: string = PROTOCOL_VERSION,
): string | undefined {
  const server = parseVersion(serverVersion);
  if (server === undefined) {
    return undefined;
  }
  for (const candidate of versions) {
    const parsed = parseVersion(candidate);
    if (parsed === undefined) {
      continue;
    }
    if (parsed.major === server.major && parsed.minor <= server.minor) {
      return candidate;
    }
  }
  return undefined;
}
