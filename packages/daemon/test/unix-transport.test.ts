import { lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiscesError } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";

type TransportModule = typeof import("../src/transport/unix-transport.js");

const loadTransport = (): Promise<TransportModule> => import("../src/transport/unix-transport.js");

const effectiveUid = (): number => process.geteuid?.() ?? 0;

let dir = "";
const transports: Array<{ close(): Promise<void> }> = [];
const clients: Socket[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pisces-transport-"));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const transport of transports.splice(0).reverse()) {
    await transport.close().catch(() => {});
  }
  await rm(dir, { recursive: true, force: true });
});

const track = <T extends { close(): Promise<void> }>(transport: T): T => {
  transports.push(transport);
  return transport;
};

const connectClient = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    clients.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });

const waitClosed = (socket: Socket, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("socket did not close"));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onClose);
    };
    const onClose = (): void => {
      cleanup();
      resolve();
    };
    if (socket.destroyed) {
      cleanup();
      resolve();
      return;
    }
    socket.once("close", onClose);
    socket.once("error", onClose);
  });

const waitFor = async (condition: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const probeFiles = async (): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.startsWith("pisces-probe-"));

test("delivers a real same-UID client to the authenticated handler", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "same-uid.sock");
  const chunks: string[] = [];
  const transport = track(
    createUnixTransport({
      socketPath,
      onAuthenticatedSocket: (socket) => {
        socket.on("data", (chunk) => chunks.push(chunk.toString()));
      },
    }),
  );

  await transport.start();
  const client = await connectClient(socketPath);
  client.write("hello\n");
  await waitFor(() => chunks.join("") === "hello\n");
});

test("binds an owned 0600 Unix socket and reports its identity", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "mode.sock");
  const transport = track(createUnixTransport({ socketPath, onAuthenticatedSocket: () => {} }));

  const identity = await transport.start();
  const stat = await lstat(socketPath);
  expect(stat.isSocket()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);
  expect(stat.uid).toBe(process.geteuid?.());
  expect(stat.mode & 0o777).toBe(0o600);
  expect(stat.dev.toString()).toBe(identity.dev.toString());
  expect(stat.ino.toString()).toBe(identity.ino.toString());
});

const rejectionReaders: Array<[string, () => number]> = [
  ["a mismatched peer UID", () => effectiveUid() + 1],
  [
    "a missing descriptor",
    () => {
      throw new PiscesError("daemon.peer_credentials_invalid", "invalid file descriptor");
    },
  ],
  [
    "a getpeercred failure",
    () => {
      throw new PiscesError("daemon.peer_credentials_failed", "peer credentials failed");
    },
  ],
  ["a non-integer UID", () => Number.NaN],
];

for (const [label, failure] of rejectionReaders) {
  test(`destroys a peer with ${label} before any handler or protocol bytes`, async () => {
    const { createUnixTransport } = await loadTransport();
    const socketPath = join(dir, `reject-${label.replaceAll(" ", "-")}.sock`);
    let readerCalls = 0;
    let handlerCalls = 0;
    const chunks: string[] = [];
    const transport = track(
      createUnixTransport({
        socketPath,
        peerUidFor: () => {
          readerCalls += 1;
          if (readerCalls === 1) return failure();
          return effectiveUid();
        },
        onAuthenticatedSocket: (socket) => {
          handlerCalls += 1;
          socket.on("data", (chunk) => chunks.push(chunk.toString()));
        },
      }),
    );

    await transport.start();

    const rejected = await connectClient(socketPath);
    rejected.write("frame-that-must-not-run\n");
    await waitClosed(rejected);
    expect(handlerCalls).toBe(0);
    expect(chunks).toHaveLength(0);

    const accepted = await connectClient(socketPath);
    accepted.write("after-auth\n");
    await waitFor(() => chunks.join("") === "after-auth\n");
    expect(handlerCalls).toBe(1);
  });
}

test("verifies same-UID kernel credentials with a private ephemeral probe", async () => {
  const { probePeerCredentials } = await loadTransport();
  await probePeerCredentials(dir);
  expect(await probeFiles()).toEqual([]);
});

test("probe fails closed on a UID mismatch and removes its socket", async () => {
  const { probePeerCredentials } = await loadTransport();
  await expect(
    probePeerCredentials(dir, { peerUidFor: () => effectiveUid() + 1 }),
  ).rejects.toMatchObject({ code: "daemon.peercred_probe_failed" });
  expect(await probeFiles()).toEqual([]);
});

test("probe maps a missing native binding to daemon.native_unavailable", async () => {
  const { probePeerCredentials } = await loadTransport();
  await expect(
    probePeerCredentials(dir, {
      peerUidFor: () => {
        throw new PiscesError(
          "daemon.peer_credentials_unavailable",
          "native binding is unavailable",
        );
      },
    }),
  ).rejects.toMatchObject({ code: "daemon.native_unavailable" });
  expect(await probeFiles()).toEqual([]);
});

test("aborts start before binding when the startup probe fails", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "probe-failure.sock");
  let handlerCalls = 0;
  const transport = track(
    createUnixTransport({
      socketPath,
      expectedUid: effectiveUid() + 1,
      onAuthenticatedSocket: () => {
        handlerCalls += 1;
      },
    }),
  );

  await expect(transport.start()).rejects.toMatchObject({
    code: "daemon.peercred_probe_failed",
  });
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(transport.close()).resolves.toBeUndefined();
  expect(handlerCalls).toBe(0);
  expect(await probeFiles()).toEqual([]);
});

test("rejects unsupported platforms before binding", async () => {
  const { assertLinuxPlatform, createUnixTransport } = await loadTransport();
  expect(() => assertLinuxPlatform("darwin")).toThrowError(
    expect.objectContaining({ code: "daemon.unsupported_platform" }),
  );
  expect(() => assertLinuxPlatform("linux")).not.toThrow();

  const socketPath = join(dir, "unsupported.sock");
  expect(() =>
    createUnixTransport({
      socketPath,
      platform: "win32",
      onAuthenticatedSocket: () => {},
    }),
  ).toThrowError(expect.objectContaining({ code: "daemon.unsupported_platform" }));
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("rejects setuid identity ambiguity at startup", async () => {
  const { assertUnambiguousProcessIdentity } = await loadTransport();
  expect(() => assertUnambiguousProcessIdentity(1000, 1001)).toThrowError(
    expect.objectContaining({ code: "daemon.start_failed" }),
  );
  expect(() => assertUnambiguousProcessIdentity(undefined, undefined)).toThrowError(
    expect.objectContaining({ code: "daemon.start_failed" }),
  );
  expect(() => assertUnambiguousProcessIdentity(1000, 1000)).not.toThrow();
});

test("caps concurrent connections at 64 and refuses extras without a handler", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "capacity.sock");
  const accepted: Socket[] = [];
  const transport = track(
    createUnixTransport({
      socketPath,
      onAuthenticatedSocket: (socket) => {
        accepted.push(socket);
        socket.on("data", () => {});
      },
    }),
  );

  await transport.start();
  for (let index = 0; index < 64; index += 1) {
    await connectClient(socketPath);
  }
  await waitFor(() => accepted.length === 64);

  const extra = connect(socketPath);
  clients.push(extra);
  const outcome = await new Promise<string>((resolve) => {
    extra.once("connect", () => resolve("connected"));
    extra.once("error", () => resolve("refused"));
  });
  if (outcome === "connected") await waitClosed(extra);
  expect(accepted).toHaveLength(64);
});

test("stops accepting new clients without touching authenticated ones", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "stop-accepting.sock");
  let handlerCalls = 0;
  const transport = track(
    createUnixTransport({
      socketPath,
      onAuthenticatedSocket: () => {
        handlerCalls += 1;
      },
    }),
  );

  await transport.start();
  const first = await connectClient(socketPath);
  await waitFor(() => handlerCalls === 1);

  transport.stopAccepting();
  transport.stopAccepting();
  await expect(connectClient(socketPath)).rejects.toMatchObject({
    code: expect.stringMatching(/^(ECONNREFUSED|ENOENT)$/),
  });
  expect(handlerCalls).toBe(1);
  expect(first.destroyed).toBe(false);
});

test("does not unlink a replacement path when the listener closes", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "replaced.sock");
  const movedPath = join(dir, "replaced.sock.moved");
  const transport = track(createUnixTransport({ socketPath, onAuthenticatedSocket: () => {} }));

  const identity = await transport.start();
  const bound = await lstat(socketPath);
  expect(bound.ino.toString()).toBe(identity.ino.toString());

  await rename(socketPath, movedPath);
  await writeFile(socketPath, "replacement must survive");

  await transport.close();

  const replacement = await lstat(socketPath);
  expect(replacement.isFile()).toBe(true);
  expect(await readFile(socketPath, "utf8")).toBe("replacement must survive");
  expect((await lstat(movedPath)).isSocket()).toBe(true);
});

test("fails closed without deleting a non-socket at the bind path", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "occupied.sock");
  await writeFile(socketPath, "occupied by a regular file");
  const transport = track(createUnixTransport({ socketPath, onAuthenticatedSocket: () => {} }));

  await expect(transport.start()).rejects.toMatchObject({ code: "daemon.start_failed" });
  expect(await readFile(socketPath, "utf8")).toBe("occupied by a regular file");
  await expect(transport.close()).resolves.toBeUndefined();
});

test("closes idempotently, drops connections and removes the bound socket", async () => {
  const { createUnixTransport } = await loadTransport();
  const socketPath = join(dir, "close.sock");
  const transport = track(createUnixTransport({ socketPath, onAuthenticatedSocket: () => {} }));

  await transport.start();
  const client = await connectClient(socketPath);
  await transport.close();
  await transport.close();
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  await waitClosed(client);
});
