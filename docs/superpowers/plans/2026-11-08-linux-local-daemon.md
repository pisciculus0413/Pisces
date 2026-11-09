# Linux Local Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing Gateway over an authenticated same-UID Linux Unix socket with NDJSON requests/events and fail-closed daemon lifecycle.

**Architecture:** `@pisces/protocol` owns pure wire shapes/framing/version negotiation. A small local Node-API binding supplies `SO_PEERCRED` and `flock`; the daemon host owns private paths, its Gateway dependencies and a socket listener. An authenticated connection dispatcher gates hello, routes Gateway requests, serializes bounded output; Gateway's existing EventBus handler also fans out connection-scoped subscriptions. Shutdown drains admitted operations before cancelling turns and never releases the lock while a turn remains.

**Tech Stack:** TypeScript ESM, Node >=22.19.0, plain C Node-API + pinned `node-gyp`, Linux `net`/`fs`, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-08-linux-local-daemon-design.md` (approved); contracts in `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §§2.6, 3.1–3.3, 3.4.5, 3.8–3.9, 5.1–5.3, 5.9 and `docs/2 Detailed Design Specification/P0 Decision Table.md` P0-08/09. Plan B ends at `58fec57`, approved design is `9b90781` on `dev-pi`; record the **actual plan-commit HEAD immediately before Task 1** as this stage's implementation diff baseline (never assume `9b90781`). The user approved this plan before Task 1. Task 10 below is a user-approved correction to its missing real cross-UID OS test; see `docs/superpowers/specs/2026-11-08-cross-uid-regression-design.md`.

## Global Constraints

- Stay on `dev-pi`, never commit to main, push, merge or create a worktree; preserve both prior `.superpowers/sdd/` directories. Use one fresh `deepseek-flash` implementer per task, TDD RED→GREEN, independent task reviewer and whole-stage independent review; never parallelize implementers modifying the same checkout.
- Linux-only real Unix socket; macOS/Windows fail before bind with `daemon.unsupported_platform`. Authentication always uses native `SO_PEERCRED` before reading protocol bytes; no chmod-only or unauthenticated fallback. Isolate undocumented `socket._handle.fd`, probe capability at startup, fail closed on any discrepancy.
- Host constructs store, markers, EventBus and Concurrency from **one** `dataDir`. `@pisces/protocol` never imports daemon/core/Node fs/net; Core never imports daemon/protocol/Node fs/net. No CLI/config loader, extensions inventory, template/client endpoints or persistence of `seq`; temporary-session commit-to-marker crash window remains uncovered.
- Native binding is plain C Node-API, compiled with pinned `node-gyp`; source and built daemon resolve the same ignored `packages/daemon/native/peercred.node`. Before the full suite after Task 2, compile native explicitly. CI Node 22.19/24/26 Linux x64 is configured, but do not claim remote results without CI execution.
- Before **every** task commit: `node_modules/.bin/vitest run`, `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/tsc -b tsconfig.build.json`, `node_modules/.bin/biome check .`, the user's original `rg -n 'from "(node:)?(fs|http|https|net|tls|dgram|dns)|from "@pisces/(daemon|protocol)"' packages/core/src` (exit 1/no output), `git status --short` (inspect). Also scan `rg -n 'from "@pisces/(daemon|core)"' packages/protocol/src` (exit 1/no output). Stage **only** files changed for that task; record HEAD/diff for review. Keep raw native error/cause/headers out of responses and events.

## Review Focus

1. An 8 MiB frame split across chunks (including split multibyte UTF-8) must never bypass the **byte** cap or allocate unbounded memory — Task 1 tests exact budget and malformed prefixes.
2. A symlink/non-socket or live socket at startup, or a socket path replaced before shutdown, must never be unlinked by this process — Task 3 tests each path including dev/ino mismatch.
3. A client sends bytes immediately on connect while credential extraction fails or UID differs: no parser/Gateway method may run or respond — Task 4 tests injected rejection and same-UID acceptance; Task 10 proves real, host-observed cross-UID rejection.
4. A slow or broken subscriber while another session publishes near-budget events must not throw into EventBus, lose a committed write, or corrupt another client's frame stream — Tasks 5–6 test isolation, byte budget and overflow disconnect.
5. `stop()` races a `turn.start` already admitted but queued behind the session lock: it must drain the request before snapshotting `cancelAll`, and retain lock if the turn survives cancellation — Task 8 gates the lock and asserts no false success.

## File structure

| File(s) | Responsibility |
|---|---|
| `packages/protocol/src/{types,codec,version}.ts`, `src/index.ts`, `test/{codec,version}.test.ts` | Pure wire types, bounded NDJSON, hello negotiation |
| `packages/daemon/native/{binding.c,binding.gyp,build.mjs}`, `src/transport/peer-credentials.ts`, native tests, `packages/daemon/package.json`, `pnpm-lock.yaml` | Peer UID + advisory lock binding and reproducible build |
| `packages/daemon/src/host/runtime-paths.ts`, `host/lock.ts`, path/lock tests | Secure run dir, flock ownership, stale/inode-safe socket lifecycle |
| `packages/daemon/src/transport/unix-transport.ts`, auth tests | `net.Server`, accept-time credential gate, socket mode |
| `packages/daemon/src/gateway/{gateway,protocol}.ts`, `src/index.ts`, Gateway subscription tests | Connection-scoped subscriptions and safe EventBus projection |
| `packages/daemon/src/transport/{connection,dispatcher}.ts`, wire tests | Buffered writer, hello gate, request dispatch and in-flight tracking |
| `packages/daemon/src/host/daemon-host.ts`, host tests | Bootstrap, real-socket startup, quiesce/cancel/stop |
| `docs/{1 High-Level Design/1 High-Level Design.md,2 Detailed Design Specification/2 Detailed Design Specification.md}`, `.github/workflows/linux-daemon.yml`, operator note | Implemented-vs-target synchronization, native build/matrix |

---

### Task 1: Pure protocol framing and hello

**Files:** Create `packages/protocol/src/{types,codec,version}.ts`, `packages/protocol/test/{codec,version}.test.ts`; modify `packages/protocol/src/index.ts`.

**Interfaces:** Produce a local recursive `JsonValue` and `Request<P=JsonValue> {id:string;method:string;params:P}`, `Response<R=JsonValue> {id:string;result?:R;error?:ProtocolError}`, `ProtocolEvent<E=JsonValue> {event:string;data:E}` and `ProtocolError {code:string;message:string}` without Core imports; the dispatcher enforces exactly one of result/error on the wire. Export `MAX_FRAME_BYTES=8388608`, `MAX_RESPONSE_BYTES=MAX_EVENT_BYTES=4194304`; `createNdjsonDecoder(onLine:(line:Uint8Array)=>void): {push(chunk:Uint8Array):void; finish():void}` (throw typed `FrameTooLarge` only for >8 MiB, including LF), `encodeFrame(value:unknown,maxBytes:number):Uint8Array` (limit counts JSON UTF-8 bytes **excluding** the terminating LF; emitted frame includes LF and must also fit 8 MiB), and `negotiateVersion(versions:readonly string[],serverVersion?:string):string|undefined` (first client-priority same-major, minor<=server, strict `MAJOR.MINOR.PATCH`). JSON validation/safe error response is Task 6.

- [ ] Write tests: 8,388,608-byte exact frame accepted and +1 rejected across multiple chunks; fragmented UTF-8 bytes preserved (fatal decode by dispatcher); two frames in one chunk; incomplete line `finish` failure; outbound 4,194,304-byte exact/+1 JSON payload cap (LF excluded); first compatible version in client priority; malformed versions rejected. Run `node_modules/.bin/vitest run packages/protocol/test/codec.test.ts packages/protocol/test/version.test.ts`; record RED.
- [ ] Implement minimal pure codec/version/types; no Node IO or daemon imports. Run focused tests GREEN.
- [ ] Run global verification block, explicitly stage task files, commit `feat(protocol): add bounded NDJSON and version negotiation`.

### Task 2: Native credentials, flock and build seam

**Files:** Create `packages/daemon/native/{binding.c,binding.gyp,build.mjs}`, `packages/daemon/src/transport/peer-credentials.ts`, `packages/daemon/test/peer-credentials.test.ts`; modify `packages/daemon/package.json`, `pnpm-lock.yaml`, `.gitignore` (ignore native build output).

**Interfaces:** `readPeerUid(fd:number):number`, `lockFile(fd:number):void` from one Node-API binding, wrapped by `peerUidFor(socket:net.Socket):number` isolating `_handle.fd` (read integer, verify), `acquireLock(fd:number):void`; all native errors normalized at host boundary. `build.mjs` invokes pinned `node-gyp`, copies compiled `.node` to `packages/daemon/native/peercred.node`, exits nonzero on failure. Linux `getsockopt(SOL_SOCKET,SO_PEERCRED)` checks exact `struct ucred` size; `flock(fd,LOCK_EX|LOCK_NB)` keeps lock until file descriptor closes. Ensure source and dist JS resolve same `.node` path; no public test override for native authentication.

- [ ] Write failing native/wrapper tests for missing fd, invalid fd, successful same-process accepted socket UID, second lock fd busy until first closes, unavailable addon fails closed. Run focused test and observe RED; build native before tests requiring the compiled symbol.
- [ ] Implement C helper, loader and explicit build script; run `node packages/daemon/native/build.mjs` then focused tests GREEN; inspect generated artifacts are ignored, and clean-build from a fresh native output succeeds.
- [ ] Run global verification block (native build first), stage only listed sources/config/lockfile, commit `feat(daemon): add Linux peer credentials and flock binding`.

### Task 3: Private run directory and single-instance socket path

**Files:** Create `packages/daemon/src/host/{runtime-paths,lock}.ts`, `packages/daemon/test/runtime-paths.test.ts`.

**Interfaces:** `prepareRuntimePaths(dataDir:string):Promise<{socketPath:string;lockPath:string;runDir:string}>` (absolute, owned `dataDir` not group/world writable, `run` owned exact `0700`, no symlinks, Unix socket path UTF-8 <=107 bytes); `acquireDaemonLock(lockPath:string):Promise<{release():Promise<void>}>` retains open flock fd and permanent lock file; `clearStaleSocket(socketPath:string,timeoutMs=1000):Promise<void>` only same-owner socket + `ECONNREFUSED`/`ENOENT`, never a live/path-changed socket; `removeOwnedSocket(socketPath:string,identity:{dev:number|bigint;ino:number|bigint}):Promise<void>` only if matching identity. Error codes `daemon.insecure_directory`, `daemon.lock_busy`, `daemon.socket_live`, `daemon.socket_path_too_long` (no raw paths in protocol).

- [ ] Write real-FS failing tests: `/tmp` parent accepted but insecure `dataDir`/run dir/symlink denied; second lock holder fails, release allows reuse; socket path too long; stale socket removed but live/non-socket/foreign owner refused; replaced inode not removed on cleanup. Focused `vitest run packages/daemon/test/runtime-paths.test.ts` RED.
- [ ] Implement path policy and bounded stale probe; no blind unlink or unlinking the lock file; focused test GREEN.
- [ ] Global verification, explicitly stage, commit `feat(daemon): secure runtime paths and single-instance lock`.

### Task 4: Linux authenticated listener

**Files:** Create `packages/daemon/src/transport/unix-transport.ts`, `packages/daemon/test/unix-transport.test.ts`.

**Interfaces:** `createUnixTransport({socketPath, onAuthenticatedSocket, peerUidFor?, expectedUid?, maxConnections?})` **internal factory** with injected reader only for tests; production `startDaemon` binds its default real `peerUidFor`. `start():Promise<{dev:number|bigint;ino:number|bigint}>`, `stopAccepting():void`, `close():Promise<void>`; use `net.createServer({pauseOnConnect:true})`, mode `0600`, `lstat` owner/type/mode, max 64 connections. Add `probePeerCredentials(runDir:string):Promise<void>` using a bounded private ephemeral real listener to verify same UID before public binding; failure `daemon.peercred_probe_failed`, missing binding `daemon.native_unavailable`. Wrong UID or any credential failure destroys socket without invoking handler or writing response; unsupported platform fails before bind.

- [ ] Write failing tests: real same-UID client reaches handler, immediate bytes with injected UID mismatch/missing fd/getpeer error never reach handler or protocol, socket has `0600`, probe failure stops start, non-Linux guard, max connection cap. Focused `vitest run packages/daemon/test/unix-transport.test.ts` RED.
- [ ] Implement transport and probe; focused test GREEN. Distinguish peer-auth failure (close only) from startup failure (abort start); no fallback.
- [ ] Global verification, explicit stage, commit `feat(daemon): authenticate Linux Unix socket clients`.

### Task 5: Gateway subscriptions and safe event fan-out

**Files:** Modify `packages/daemon/src/gateway/{gateway,protocol}.ts`, `packages/daemon/src/index.ts`; create `packages/daemon/test/gateway-subscriptions.test.ts`; update existing `packages/daemon/test/gateway-turn.test.ts` for persisted-marker write-failure regression.

**Interfaces:** Extend `Gateway` with `attach(connectionId:string,enqueue:(event:ProtocolEvent)=>void):void`, `detach(connectionId:string):void`, `dispose():void`, and optional `handle(request,connectionId?:string)`; never expose a caller-set connection id on the wire. `session.subscribe`/`unsubscribe` accept `{sessionId}`, return same shape; no attached connection → existing unknown-method result. Validate session under session lock (including temporary runtime), subscribe idempotently; detach removes all subs but leaves turns. Existing single EventBus handler retains `turn.ended` state transition and projects known types `{event:type,data:{sessionId,seq,at,...payload}}`, including safe `turn.cleanup_failed`, to matching subscribers only. All per-client enqueue failures caught and detach client; no EventBus publication failure from the bridge.

- [ ] Write failing tests: two clients/subscriptions across two sessions; duplicate subscribe/unsubscribe; unknown session and temp session; detach during active turn never cancels; exact near-4MiB projected-event byte bound; throwing subscriber does not fail event publication/other client; no connection leaves old eight-method behavior; persisted marker write failure prevents provider call. Focused `vitest run packages/daemon/test/gateway-subscriptions.test.ts packages/daemon/test/gateway-turn.test.ts` RED.
- [ ] Implement minimal subscription map and augment **existing** handler, no second bus subscription; tests GREEN.
- [ ] Global verification, explicit stage, commit `feat(daemon): route connection-scoped session events`.

### Task 6: Bounded writer and connection dispatcher

**Files:** Create `packages/daemon/src/transport/{connection,dispatcher}.ts`, `packages/daemon/test/{connection,dispatcher}.test.ts`.

**Interfaces:** `createConnection(socket, gateway, options?): {close():void; quiesce():void; pending():Promise<void>}` handles `protocol.hello` before `gateway.handle(req,connectionId)` and detaches on close. Connection IDs generated internally; no untrusted ID accepted. Use Task 1 decoder/encoder; request fields must be object with string id/method and record params; malformed JSON→`protocol.invalid_json`, invalid envelope→`protocol.invalid_request`, unknown id→`id:""`; no raw input in errors. `protocol.hello_required` for earlier methods; mismatch→`protocol.version_mismatch` response then flush-close; duplicate hello→invalid_request; pre-hello timeout 5000ms, version-mismatch flush limit 1000ms, queued bytes <=8388608 and exact UTF-8 frame/response/event budgets; async writer serializes socket writes and `drain`, overflow closes only that connection. Pending includes **admitted** async Gateway operations through response enqueue; quiesce rejects new frames before pending registration, leaves existing operations running.

- [ ] Write failing fake-socket/real-loopback tests: split UTF-8 + invalid JSON, >8MiB partial frame, invalid id sentinel, hello-required then successful hello, first-compatible version, mismatch flush before close, duplicate hello, concurrent responses and events never mix bytes, slow writer/overflow detaches without cancelling turn, no unbounded pending/frame buffers, inherited method names remain unknown. Focused `vitest run packages/daemon/test/connection.test.ts packages/daemon/test/dispatcher.test.ts` RED.
- [ ] Implement bounded writer and dispatcher; handle all rejected writes without leaking raw error; focused tests GREEN.
- [ ] Global verification, explicit stage, commit `feat(daemon): dispatch authenticated NDJSON connections`.

### Task 7: Host startup and real-socket integration

**Files:** Create `packages/daemon/src/host/daemon-host.ts`, `packages/daemon/test/daemon-start.test.ts`; modify `packages/daemon/src/index.ts`.

**Interfaces:** Export `startDaemon(options: {dataDir:string} & Pick<GatewayDeps, "providers"|"providerHost"|"defaults"|"createTools"|"entries"|"skills"|"sources"|"validateWorkspace"|"newSessionId"|"newTurnId"|"newQueueEntryId"|"newNodeId"|"now">):Promise<DaemonHost>`; `DaemonHost` exposes `socketPath`, `initializationIssues`, `recoveryIssues`, `status():{state:"running"|"quiescing"|"stopped";activeTurns:number}`, `stop():Promise<void>` (Task 8 fills shutdown). Startup order: platform/path → private run dir → lock → native self-probe → stale socket → `bootstrapGateway` → bind/verify `0600` → serve. Host constructs store, marker store, EventBus, Concurrency from **same dataDir**; on failure reverse-clean own resources while preserving others' socket and lock inode.

- [ ] Write failing tests using real socket plus fake provider: no request accepted before recovery, hello/provider.list and session.create/read over wire, startup refused if lock held/insecure dir/native probe fails, stale socket reclaimed safely, two-process race exactly one winner, crash restart recovers committed marker. Built child-process fixtures must run compiled `dist/*.js` and native output, not Vitest TS aliases. Focused `vitest run packages/daemon/test/daemon-start.test.ts` RED.
- [ ] Implement host startup, failure cleanup and a real stop for a host with **zero** active turns (close sockets, inode-check unlink, release lock); any active turn must return `daemon.stop_incomplete` until Task 8 supplies cancellation/drain. Assert no no-op cleanup in tests; focused tests GREEN.
- [ ] Global verification, explicit stage, commit `feat(daemon): bootstrap authenticated local service`.

### Task 8: Stop, cancellation and fail-closed cleanup

**Files:** Modify `packages/daemon/src/host/daemon-host.ts`, `packages/daemon/src/transport/{unix-transport,connection}.ts`; create `packages/daemon/test/daemon-stop.test.ts`.

**Interfaces:** `DaemonHost.stop():Promise<void>`: quiesce and reject new frames → stop accepting → wait admitted pending requests (5s) **before** `cancelAll(5000)` → check activeTurns empty, including marker cleanup → close/detach connections → dispose Gateway EventBus handler → close listener → inode-checked socket unlink → release lock → stopped. Pending timeout/registered turn/cleanup failure throws `PiscesError("daemon.stop_incomplete",...)`, leaves lock, marker, Gateway and quiescing state for retry; repeated successful stop is no-op; never silently force-terminate or claim abort equals completion. Public default deadlines remain 5000ms; use an internal host factory with injectable short deadlines only in tests.

- [ ] Write failing real-socket tests: queued `turn.start` behind session lock is registered before `cancelAll` snapshot; driver ignoring abort and `cleanup_failed` each retain lock and report incomplete; completion removes marker before lock release; in-flight hung request times out without unlocking; disconnect/unsubscribe alone does not cancel; repeated stop idempotent. Use gates/`finally` to release test turns and avoid hang. Focused `vitest run packages/daemon/test/daemon-stop.test.ts` RED.
- [ ] Implement stop with shared deadline handling and retry-safe state; focused tests GREEN.
- [ ] Global verification, explicit stage, commit `feat(daemon): stop without releasing live-turn lock`.

### Task 9: CI, operator note and DDS/HLD synchronization

**Files:** Create `.github/workflows/linux-daemon.yml`, `docs/daemon-linux.md`; modify `docs/1 High-Level Design/1 High-Level Design.md`, `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`.

**Interfaces:** Linux CI Node 22.19/24/26 x64 compiles pinned native binding, runs full Vitest, both tsc, Biome and two boundary scans (rg exit 1/no output). Operator note describes native build, programmatic host/no CLI, Linux only, private `_handle.fd` startup probe, same-UID authentication, incomplete-stop operator handling. DDS distinguishes implemented methods (including subscribe/unsubscribe after Task 5) from unrouted target methods, adds safe `turn.cleanup_failed`, error sentinel/daemon codes, session-event forwarding, Linux-only operational limits and stop ordering; HLD Windows support remains target design, explicitly not this stage.

- [ ] Write failing doc/CI presence checks (targeted `rg` for new host API, `SO_PEERCRED`, stop-incomplete and Node matrix against relevant files; no prose-only runtime unit tests); confirm missing contracts before edits.
- [ ] Add CI/docs using actual Task 1–8 interfaces; validate YAML parse if tool available, build native and run complete verification block. Document any unavailable CI matrix result without claiming it passed.
- [ ] Explicitly stage only four task files, commit `docs: describe Linux daemon transport and build matrix`; prepare whole-stage diff from the actual pre-Task-1 plan-commit HEAD for independent final review.

### Task 10: Real cross-UID credential regression (post-review correction)

**Spec:** `docs/superpowers/specs/2026-11-08-cross-uid-regression-design.md` and amended original spec above.

**Files:** Modify `packages/daemon/test/unix-transport.test.ts`, `docs/daemon-linux.md`; create `packages/daemon/test/fixtures/cross-uid-client.mjs` if a small Node-builtin-only child fixture simplifies bounded subprocess control. No production/auth/permission changes.

**Interfaces:** The production `createUnixTransport({socketPath,onAuthenticatedSocket})` uses default native `peerUidFor` (`packages/daemon/src/transport/peer-credentials.ts`), not an injected reader. Run a child via `unshare --map-auto --user --setuid 1 --setgid 1` and `process.execPath`, using a disposable test-only traversable directory and connectable socket *after* the real listener's `0600` bind check. An independent host-side real `SO_PEERCRED` observation must see a UID unequal to `process.geteuid()`; if mapping/utility is absent or same-UID, fail the Linux test with an explicit setup error (never skip). The child writes immediate bytes; assert its connection is closed without authenticated handler invocation or returned protocol bytes. Afterwards prove same-UID client still reaches the handler. Bound spawned child and socket waits and reap on every path.

- [ ] Write the real-socket test and optional builtin-only child fixture; build native and compiled TS before spawned test. Verify test sensitivity: because production auth already rejects, temporarily disable only the relevant UID gate **without committing**, run focused test and observe failure on handler-invocation/data assertion, restore source, verify focused test passes. Record this honestly as mutation RED, not an original unmet-feature RED; do not leave any production source diff.
- [ ] Execute `node packages/daemon/native/build.mjs`, focused `node_modules/.bin/vitest run packages/daemon/test/unix-transport.test.ts`, then the complete global verification block (Vitest, both tsc, Biome, Core and protocol boundary scans). Update `docs/daemon-linux.md` to describe real cross-UID coverage and required `unshare --map-auto`/subordinate mapping; remote Node matrix still unverified.
- [ ] Inspect `git status --short`/`git diff --check`, explicitly stage only Task 10's test/fixture/operator-note files, commit `fix(daemon): test real cross-UID Unix rejection`; hand the BASE..HEAD diff to an independent Task 10 reviewer before the final whole-stage review.
