import { connect } from "node:net";

/**
 * Cross-UID Unix client fixture.
 *
 * Started by `packages/daemon/test/unix-transport.test.ts` through
 * `unshare --map-auto --user --setuid 1 --setgid 1`, so the child holds a
 * host-visible UID from the caller's subordinate ID range. It writes
 * immediately on connect and reports JSON lines on stdout so the parent can
 * observe the real server-side fate of the connection.
 *
 * Usage: node cross-uid-client.mjs <socketPath> <payload>
 */

const [socketPath, payload = "frame-that-must-not-run\n"] = process.argv.slice(2);

const emit = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let connected = false;
let received = 0;
let finished = false;

const finish = (event, detail, code) => {
  if (finished) return;
  finished = true;
  emit({ event, ...detail, received });
  process.exit(code);
};

if (typeof socketPath !== "string" || socketPath.length === 0) {
  emit({ event: "usage_error" });
  process.exit(64);
}

const socket = connect(socketPath);

socket.on("connect", () => {
  connected = true;
  emit({ event: "connected" });
  socket.write(payload);
});
socket.on("data", (chunk) => {
  received += chunk.length;
});
socket.on("close", () => {
  finish("ended", { reason: "close" }, 0);
});
socket.on("error", (error) => {
  if (!connected) {
    finish("connect_error", { code: error.code ?? "unknown" }, 2);
    return;
  }
  finish("ended", { reason: "error", code: error.code ?? "unknown" }, 0);
});

setTimeout(() => {
  finish("timeout", {}, 3);
}, 3000);
