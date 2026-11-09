# Real Cross-UID Daemon Regression — Design Addendum

**Status:** Approved by the user as a correction to `2026-11-08-linux-local-daemon-design.md` (security-test clause). **Scope:** Test and operator documentation only; no production auth or permission-policy change.

## Purpose and alternatives

The daemon already checks native `SO_PEERCRED` before reading protocol data. Injected UID mismatches do not establish that a real process with another *host-visible* UID is rejected. `unshare -Ur` alone is insufficient: a child reporting UID 0 in its namespace still appears to a host-namespace parent as the parent's UID (verified locally with `SO_PEERCRED`).

- **Chosen:** `unshare --map-auto --user --setuid 1 --setgid 1` uses a subordinate UID mapping. An independent, real kernel-credential preflight must prove the host observes a peer UID different from the daemon's effective UID, then a child connects to the actual daemon transport with bytes already queued. Assert the connection closes without invoking its authenticated handler or returning protocol data. Prove a regular same-UID client still works afterward. Locally the mapping yields host UID 100001 while the daemon is UID 1000; values are environment-dependent, so assert inequality, not a hard-coded number.
- **Rejected:** `unshare -Ur` alone produces no host-visible mismatch; an injected UID reader exercises only the injected seam; root-only `setpriv` would leave ordinary-user CI unverified.

## Test boundary and failure policy

The production listener remains `0600` under a `0700` directory. To reach native authentication despite DAC in this **test fixture only**, temporarily make a new disposable directory traversable and its newly bound socket connectable *after the production transport has finished its bind/mode checks*. Never change the production permission policy or expose an identity override. Use the production default native peer reader, not a fake. Restrict any permissive path to the disposable fixture; tear down child processes and directory in `finally` with bounded timeouts, including error paths. Do not use the namespace child's `id -u` as evidence of the parent's peer UID. A preflight accepted socket measured via the real native reader, or another independent host-side kernel-credential observation, must establish a different UID before the rejection assertion.

**No silent skip on Linux:** If `unshare`, subordinate-ID mapping, `newuidmap`/`newgidmap`, or the effective mapping is unavailable, the test fails with a clear configuration error. Root-only and non-Linux are not a substitute for this Linux CI requirement; the CI matrix must execute the test under each available Node version. Do not report unrun remote matrix entries as passing. No extra network services, privileges, production CLI or persistent test accounts are introduced.

## Deliverables

A focused Linux integration test alongside `packages/daemon/test/unix-transport.test.ts` and a small Node-builtin-only client fixture if needed; `docs/daemon-linux.md` records mapping prerequisites and exactly what local run verified. Record test sensitivity without inventing an original behavior RED: if the implementation already rejects properly, demonstrate the new regression test failing under a temporary **disabled** auth check in a reversible local mutation, restore the original source and confirm green. Full suite, native build, typechecks, Biome, import scans and independent review remain required.
