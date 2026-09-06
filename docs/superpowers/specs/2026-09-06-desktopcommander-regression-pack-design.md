# DesktopCommander Regression Pack Design

## Purpose

Harvest failure classes that occurred in DesktopCommander and encode them as permanent Chat On Steroids regressions without widening the MCP surface or weakening the existing trust boundaries.

This tranche is deliberately reliability-first. A test that proves the current implementation already satisfies an invariant is a valid deliverable. Production code changes are permitted only when a newly added regression demonstrates a real gap.

## Global invariants

1. Core/Desktop authority separation stays unchanged.
2. Approved filesystem roots remain the authority boundary for file tools; terminal execution is not marketed or implemented as root-contained.
3. No new MCP tool names are added.
4. No URL/network fetch behavior is added to local `read`.
5. No command blocklist is introduced as a containment mechanism.
6. No telemetry or session-recorder disk write may extend a normal tool call indefinitely.
7. Process output remains bounded at the existing 1 MiB collection ceiling and model-facing token budgets.
8. UTF-8 must not be corrupted merely because a multibyte code point crosses a stream chunk or truncation boundary.
9. A symlink/junction/reparse-point escape must fail before create/read/write reaches an unapproved target.
10. Tunnel process state, socket state, and local `/readyz` are not sufficient evidence of end-to-end OpenAI liveness; completed control-plane handshake evidence remains authoritative.

## 1. Process torture regressions

Target the existing unified exec runtime rather than creating a second execution path. Extend focused tests around `UnifiedExecProcessManager`, `HeadTailBuffer`, and MCP output formatting.

Required scenarios:

- multi-megabyte single-line stdout;
- concurrent stdout and stderr flood;
- fast non-zero exit with final stderr still retained;
- nonexistent executable produces a bounded error rather than crashing the host;
- process-tree termination remains effective for child + grandchild;
- the 64-session capacity ceiling refuses new work without evicting unread completed results;
- collection-cap pressure does not synchronously monopolize the event loop;
- text and `structuredContent` expose the same bounded/truncated evidence.

Existing tests that already prove a scenario should be referenced and strengthened rather than duplicated mechanically.

## 2. Windows file-handle release regression

`readTextFile()` is built on `readFileStream()`, whose generator owns a file handle in a `try/finally`. A partial/ranged read must close that handle as soon as iteration stops.

Windows regression:

1. create a file;
2. read only a prefix/range so the generator exits early;
3. immediately rename/replace the same file;
4. the rename must succeed without retry loops or artificial delay.

This test should be Windows-only because Windows handle semantics are the historical failure class being guarded.

## 3. UTF-8 split-boundary regressions

Use a three-byte code point such as `€` and force its bytes across stream chunks.

Required coverage:

- tunnel line parsing must reconstruct split UTF-8 without `�`;
- search/child-stream text accumulation must not decode arbitrary chunks independently;
- unified-exec model output must remain valid UTF-8 when the head/tail collection cap cuts through a multibyte sequence;
- any fix should use streaming decoding or boundary-safe trimming, not string replacement of `�` after corruption occurred.

The existing whole-buffer decode paths in legacy `exec.ts` need no change unless a test demonstrates a failure.

## 4. Symlink/junction escape corpus

Turn the existing sandbox strengths into a named regression corpus.

Required cases:

- approved directory contains a link/junction to an unapproved directory;
- read through the link is rejected;
- create of a nonexistent child below the escaping link is rejected before creation;
- an internal link that resolves inside the same approved root remains allowed;
- replacing/retargeting an approved Windows root with a junction invalidates the old authority;
- workspace shorthand and native-path resolution use the same canonical decision.

No production change is expected unless one of these cases fails.

## 5. Recorder latency isolation

The MCP dispatcher currently awaits recorder completion for exact attributed requests. That makes session persistence capable of becoming request latency even though recorder failures themselves are non-fatal.

Required invariant: a stalled recorder append must not prevent ChatGPT from receiving an already-computed `read` or `exec_command` result.

Implementation direction when RED proves the gap:

- keep the recording promise visible through the existing settling/in-flight accounting;
- return the tool result without awaiting durable session append;
- retain `flushRecorder()` as the shutdown durability barrier;
- do not swallow recorder failures silently: the recorder already logs failures and resolves `null`.

The regression should stall the recorder/store layer with an explicit test hook or spy and prove the MCP response completes inside a short deterministic bound while recording remains pending.

## 6. Tunnel and connection liveness pack

Preserve the current architectural rule: `connected` means recent authenticated/end-to-end control-plane evidence, not merely a live child or green local readiness endpoint.

Required scenarios:

- local `/readyz` remains green while the last successful control-plane poll becomes stale;
- one transient network complaint does not immediately flip the UI offline;
- an unanswered complaint lasting beyond the confirmation window does flip offline;
- a newer completed poll clears the outage run;
- child exit causes reconnect/backoff rather than a permanent stale connected state;
- stale callbacks from an older connection generation cannot overwrite a newer connection;
- duplicate/replacement tunnel instances are stopped by lifecycle serialization;
- rapid failures remain backoff-bounded instead of creating an unbounded restart loop.

Prefer pure exported state helpers and deterministic fake timers over real network dependencies.

## Test and release gate

Each task gets a focused test run. After all six tasks:

1. `npm run typecheck`
2. focused P1 regression suites
3. `npm test`
4. `git diff --check`

No push, merge, publish, installer run, or live installed-app mutation is part of this tranche.
