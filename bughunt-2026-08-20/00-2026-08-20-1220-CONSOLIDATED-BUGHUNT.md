# Connector Bug Hunt — Consolidated Forensic Report

**Timestamp:** 2026-08-20 12:20–12:27 Europe/Berlin  
**Repository:** `C:\Users\totec\chatgpt-local-files`  
**Audit window:** approximately 11:47–12:27 local  
**Sources merged:** `MASTER.md`, all three worker reports, saved repro/probe files, durable session JSONL, durable request-correlation state, and the swarm/broker state captured during the incident.  
**Production changes made for this report:** none.

This file deliberately starts with `00-` so it sorts to the top of `bughunt-2026-08-20`.

---

## Executive summary

The 2026-08-20 audit found a cluster of real bugs rather than one isolated failure. The highest-value live incident was the multi-agent run itself: **worker-5 was successfully created and bound to a ChatGPT conversation, but every real MCP tool call from that worker was recorded as Unattributed.** The worker continued doing substantial repository work for about 24 minutes, yet `agents` could no longer prove its identity, prime messages were stranded, the bound worker transcript falsely reported ten minutes of no progress, and the broker eventually treated the worker as stale.

The durable evidence strongly narrows the failure. The worker's MCP request id was stable and present on every tool call; what was missing was the page-side evidence mapping that request id to the worker conversation. The strongest current root-cause candidate is the extension's **Fiber health blind spot**: `content.js` can answer the background health ping while MAIN-world `fiber.js` is absent, stale, or no longer answering. Exact request ownership depends on Fiber reading ChatGPT's `metadata.request_id`. A saved regression test re-run during this consolidation still fails exactly because background trusts the content-script ping and performs **zero** Fiber reinjections.

The forensic comparison became stronger than the original worker report: healthy worker-2 and worker-3 sessions contain extension `page_tool` events generated from the Fiber page-model path, whereas worker-5 contains **zero page_tool events and zero tool calls** despite 67 matching MCP calls being active in Unattributed. The durable `request-correlations.json` contains the prime, worker-2, and worker-3 request ids from the same run, but **does not contain worker-5's request id at all**.

The audit also reproduced cross-chat transcript misattribution, stale/zombie tab ownership, duplicate lifecycle events, silent observation loss, stale Overwrite rendering, an app-restart activity split brain, a 68-second session-history main-process freeze, an orphan HTTP bridge listener, ambiguous commits after MCP disconnect, Windows reparse/junction sandbox TOCTOU, fail-open terminal ownership when identity is missing, wrong-workspace fallback, image validation/resource bugs, and output-budget violations.

---

# 1. LIVE INCIDENT: worker-5 became a zombie-bound worker while all real work went to Unattributed

## 1.1 Broker identity was successfully established

The broker captured worker-5 as:

- agent: `worker-5`
- conversation: `6a86ce29-3f14-83eb-9d1c-1ff4a7b84608`
- state at the time of investigation: `active`

This matters because it rules out the simplest explanation. The worker was not merely a browser tab that never bound. The broker already knew exactly which ChatGPT conversation represented the worker.

The worker's durable session is:

`2026-08-20-5a2e6c1e`

It records:

- extension `session_start` at 11:51:49;
- worker-5 `turn_start` / initial turn end;
- the real work turn beginning at 11:51:47;
- later a ten-minute no-progress `chat_error`;
- eventual `turn_end` as `stalled`;
- **0 tool calls**.

The session therefore proves that browser/session/agent lifecycle attribution was alive while MCP call attribution was not.

## 1.2 The actual worker activity is identifiable exactly

The real work appears in:

`2026-08-20-831d7354` — **Unattributed activity**

The worker's stable MCP request id is:

`ebb257d5-e0f6-4bf0-9bcd-a6280f1c9d5b`

For that request id, the forensic scan found:

- **67 tool calls** from **11:52:02** through **12:16:01**;
- every call has `attribution: "unattributed"`;
- every call has `conversationId: null`;
- 21 × `apply_patch`;
- 21 × `exec_command`;
- 19 × `read`;
- 3 × `agents`;
- 2 × `write_stdin`;
- 1 × `session`.

This is not a worker that failed to execute. It performed a full audit while the connector lost its identity.

## 1.3 Exact control-plane failures

The three worker `agents` calls were rejected at:

- 11:53:28 — `WORKER_IDENTITY_LOST`
- 11:57:38 — `WORKER_IDENTITY_LOST`
- 12:16:01 — `WORKER_IDENTITY_LOST`

The returned error says Local Files could not determine which conversation the call came from and therefore could not act on the run.

The broker simultaneously held two prime→worker messages pending. Because later worker calls had no proven agent identity, the normal inbox acknowledgement/delivery path could not attach those messages to worker-5.

## 1.4 Request id was not wrong; its ownership evidence was absent

An important correction to the vague hypothesis "the extension sent the wrong request id": the logs show a stable request id on every worker call. The broken link is **request id → conversation**, not necessarily request-id generation itself.

The current durable correlation file `state/request-correlations.json` contains exact mappings for the same run, including:

- prime request `e1f6c339-eb35-44cc-8cff-20eececb3175` → prime conversation;
- worker-2 request `73a82629-c141-4a4d-bbad-4b60b4f0e0f3` → worker-2 conversation;
- worker-3 request `51010da9-1518-4f44-b36c-16a325399709` → worker-3 conversation.

It contains **no entry at all** for:

`ebb257d5-e0f6-4bf0-9bcd-a6280f1c9d5b`

The exact id appears only in the Unattributed JSONL plus prime's later forensic commands quoting it. This makes a bad persisted mapping less likely for this specific incident; the stronger signature is that no exact mapping was ever learned.

## 1.5 Healthy workers vs worker-5: page-model evidence disappeared too

Worker-2 (`2026-08-20-ed1ff986`) and worker-3 (`2026-08-20-43c3c778`) both show:

- exact `request_id` MCP attribution;
- normal tool calls in their bound sessions;
- extension `page_tool` events during their work turns.

`page_tool` activity is emitted from the Fiber-derived page-model path (`content.js` explicitly says native activity is emitted by `refreshFiber()`).

Worker-5 shows:

- lifecycle events only;
- **zero `page_tool` events**;
- **zero bound MCP tool calls**;
- 67 corresponding calls in Unattributed.

That makes the "MAIN-world Fiber stopped participating while isolated content.js remained alive" explanation materially stronger than it was at the start of the audit.

## 1.6 Strongest root-cause candidate: health check proves content.js, not Fiber

Relevant production code:

- `extension/background.js:948-978`
  - enumerates open ChatGPT tabs;
  - sends `{type:'clf-recorder-ping'}` to isolated content.js;
  - if content.js replies `{ok:true, recorderVersion:8}`, line 960 immediately `continue`s;
  - therefore it skips `chatgpt-dom.js`, MAIN-world `fiber.js`, `content.js`, and CSS reinjection.
- `extension/content.js:4734+`
  - answers that ping from the isolated content script using its own version constant.
- `extension/content.js:1156-1163, 1677-1819`
  - exact request ownership is obtained through `refreshFiber()` / `askFiber()`;
  - Fiber returns ChatGPT page-model calls including `requestId`;
  - content emits `tool_evidence` from those calls.

So the current health protocol can report "healthy" in this state:

```text
content.js alive and version 8
    -> health ping succeeds
    -> background injects nothing

fiber.js absent / stale / no longer answering
    -> askFiber() times out
    -> no metadata.request_id evidence
    -> no request -> conversation correlation
    -> MCP calls become Unattributed
    -> agents identity cannot be proven
```

### Re-verification at ~12:23

`repro-fiber-health-gap.test.ts` was re-run against the current tree. The desired invariant still fails:

```text
expected scripting.executeScript(... fiber.js ...) to be called
Number of calls: 0
```

So this is not stale documentation. The blind spot is present now.

## 1.7 NEW finding: Fiber presence is sticky after one successful answer

**Severity:** HIGH/MEDIUM lifecycle reliability.  
**Status:** source-confirmed on current tree; no existing regression found.

`content.js` sets `fiberPresent = true` after any successful Fiber answer (`content.js:1752-1760`). If later `askFiber()` times out, `refreshFiber()` simply returns at `answer === null`; it does **not** clear `fiberPresent`.

Search of current code shows `fiberPresent = false` only when the conversation state is reset (`content.js:669-673`). It is not reset when a previously working Fiber helper stops answering within the same conversation.

This matters because `endOutcome()` explicitly disables its DOM completion fallback once Fiber has **ever** answered:

`content.js:845-850`:

```text
if (!fiberPresent && answerText(turn).length > 0) completed
```

Therefore a page can transition:

```text
Fiber worked once -> fiberPresent = true
Fiber later dies -> askFiber returns null forever
visible final answer exists -> DOM fallback remains disabled
turn can remain unknown / later become stalled
```

The current comments assume `fiberPresent` represents a capability that remains available, but the variable really means "Fiber answered at least once since the conversation reset." Those are not equivalent.

**Missing regression:** Fiber answers once, helper disappears, later turn visibly completes, and lifecycle must degrade back to DOM fallback rather than hang/stall.

## 1.8 NEW live cascade: attribution loss turns active work into a false stall and stale worker eviction

**Severity:** HIGH multi-agent reliability.  
**Status:** live confirmed from JSONL.

At **12:01:48**, worker-5's bound session emitted:

`No visible progress for ten minutes. The turn is still marked as generating.`

But the Unattributed session proves active worker calls immediately around that time, including calls at 12:01:35, 12:01:48, 12:02:11, and continuously afterward through 12:16:01.

The existing content-script regression says fresh app activity for the exact local turn is liveness evidence and prevents this stall. Worker-5 could not receive that protection because its calls had no conversation/turn identity and therefore never appeared in its `/activity` stream.

The cascade was:

```text
request correlation lost
 -> tool calls filed Unattributed
 -> bound worker activity stream sees no tool liveness
 -> extension emits false ten-minute no-progress error
 -> turn eventually ends as stalled at 12:16:39
 -> app emits at 12:18:52:
    "[worker-5 stale] Its ChatGPT work is durably quiescent after the orphan grace period. The worker slot is free."
```

The stall detector is locally consistent with the broken attributed stream, but globally wrong: the connector itself is executing the worker's tools. A robust agent run should have a transport/run-level liveness fallback so a correlation outage cannot automatically masquerade as a dead worker.

---

# 2. Consolidated bug inventory

Verification labels used below:

- **LIVE** — directly observed in durable production/session state during this run.
- **RERUN** — reproduction re-executed during this consolidation against the current tree.
- **WORKER-REPRO** — deterministic repro executed by a worker during this audit and saved/described with exact output.
- **SOURCE** — present deterministically in current production code; no contradictory test/guard found.
- **RISK** — plausible concern not promoted to a confirmed bug.

## 2A. Agent / attribution / transcript / extension integrity

### A1 — HIGH — bound worker becomes Unattributed split brain

**Verification:** LIVE.  
Full forensics in section 1. Worker-5 broker/lifecycle identity survived while 67 real calls had null conversation and `WORKER_IDENTITY_LOST`.

### A2 — HIGH — content-script health ping does not validate MAIN-world Fiber

**Verification:** RERUN + SOURCE.  
Current regression still fails because a healthy content ping produces zero Fiber reinjections. Exact mechanism matches A1.

### A3 — HIGH/MEDIUM — sticky `fiberPresent` can disable completion fallback after Fiber dies

**Verification:** SOURCE, newly identified in consolidation.  
`fiberPresent` is set true on a reply, never cleared on later Fiber timeout, and gates successful DOM completion fallback.

### A4 — HIGH — attribution outage falsely stalls an actively working agent and drives stale cleanup

**Verification:** LIVE, newly separated as a failure-amplification bug.  
Worker tool traffic was active while its bound transcript reported ten minutes of no progress and later `stalled`.

### A5 — HIGH/MEDIUM — stale nonempty request-correlation snapshot suppresses durable-history reconciliation

**Verification:** RERUN.  
`repro-correlation-stale.test.ts` failed again at ~12:23:

```text
expected requestCorrelation('wfr_new').conversationId
received undefined
```

The scenario writes newer exact tool history durably but leaves an older valid correlation snapshot. Restore sees the nonempty old snapshot and returns without rebuilding the newer mapping from durable history.

Refs: `src/main/session/correlation.ts:83-85,143-183`, `src/main/durable.ts:20,73-84`.

### A6 — HIGH — `/activity` forgets a still-open chat after app/recorder restart

**Verification:** WORKER-REPRO + SOURCE.  
Worker-2 reset recorder memory while preserving durable session state, then recorded a new exact request-id call for chat A. Durable JSONL advanced, but `GET /activity?conversationId=A` returned `sessionId:null` and `stream:[]`.

Root cause: `/activity` trusts the in-memory `liveConversations()` map and does not reopen the durable chat even though the browser poll itself is evidence that the chat is open.

Refs: `src/main/bridge.ts:699-865`, `src/main/session/recorder.ts:927-940,1103-1123`.

### A7 — HIGH — provisional pre-conversation observations can be bound to a later unrelated chat on the same tab

**Verification:** WORKER-REPRO + SOURCE.  
Fresh chat A emitted provisional observations under `tab-12`, left before receiving a conversation id, then unrelated fresh chat B reused the tab inside the ten-minute TTL. A's text was posted under B's conversation id.

Root cause: provisional identity is only tab id; terminal navigation does not generation-stamp/purge those provisional entries.

Refs: `extension/background.js:347-388,648-680,811-840`.

### A8 — HIGH — external navigation / tab removal can lose to delayed old-document IPC and resurrect zombie ownership

**Verification:** WORKER-REPRO + SOURCE.  
Both `tabs.onUpdated` and `tabs.onRemoved` were reproduced racing a delayed cold-worker content request. Final state re-added the dead tab's conversation and skipped `/closed`.

Root cause: no per-tab document/navigation epoch or terminal tombstone; stale content messages can call `noteTabConversation()` after browser-level terminal cleanup.

Refs: `extension/background.js:671-712,811-855,914-926`.

### A9 — HIGH/MEDIUM — at-least-once `/events` retry duplicates append-only lifecycle events

**Verification:** WORKER-REPRO + SOURCE.  
Replaying an identical committed `turn_start` + `turn_end` batch produced start,start,end,end. Message dedupe does not make lifecycle idempotent, and renderer grouping can expose duplicate turn groups.

Refs: `extension/background.js:391-435,510-550`, `src/main/bridge.ts:610-670`, `src/main/session/recorder.ts:1360-1403`.

### A10 — HIGH/MEDIUM — content pre-journal queue silently drops observation 401

**Verification:** WORKER-REPRO + SOURCE.  
401 unique observations were emitted while the receiver path was unavailable; only 400 reached the worker journal. `queued-0` disappeared with no gap marker.

Refs: `extension/content.js:420-451`.

### A11 — MEDIUM/HIGH — exact-conversation tool recording can reorder calls and bypass quit flush chain

**Verification:** WORKER-REPRO + SOURCE.  
An intentionally slow first exact call and fast second exact call were invoked in that order, but durable request-id order became second then first. Exact conversation recording bypasses `recordChain`; `flushRecorder()` only waits for that chain.

Refs: `src/main/session/recorder.ts:901-1049`.

### A12 — HIGH — generation binding gap can hide all current Local Files activity while tools are durably running

**Verification:** LIVE + WORKER-REPRO.  
User screenshot showed active Local Files calls while Overwrite displayed no current local activity. Prime unskipped two existing generation-binding regressions; both failed and emitted no expected progress. `generationTurn()` can remain null before the new section is safely bound.

Refs: `extension/content.js:719-758,3216-3296`; skipped regressions around `test/content-script.test.ts:3533,3605`.

### A13 — HIGH — Overwrite sticky grace can keep stale replacement mounted while a new exact call is live

**Verification:** WORKER-REPRO + SOURCE.  
Fiber exposed call 2 while local stream still contained call 1. `completeReplacementForTurn()` knew reconstruction was incomplete, but the eight-second grace retained the old `.clf-stream` and kept native current activity hidden.

Refs: `extension/content.js:50-52,3019-3052,3284-3295`.

### A14 — HIGH usability/reliability — worker bootstrap can steal focus, receive the user's keystrokes, then fail insertion

**Verification:** LIVE + SOURCE.  
One replacement worker failed with `the browser could not start the chat — ChatGPT refused the inserted text` after a newly opened worker tab stole focus while the user was typing. The bridge immediately advances to the next queued worker after bootstrap failure, while `insertPrompt()` refuses a non-empty composer.

Refs: `src/main/bridge.ts:1620+,1882-1894`, `extension/content.js:4594-4608`, `extension/chatgpt-dom.js:1233-1246` as recorded by prime during the incident.

---

## 2B. MCP / Electron / process lifecycle

### M1 — HIGH — bounded session-history request can freeze Electron main for over a minute

**Verification:** WORKER-REPRO.  
250,000 valid progress events, ~40.0 MB journal, request `limit:1`:

```text
elapsedMs: 68305
heapDeltaMiB: 83.6
returned: 1
```

The limit is applied after full-file read, split, JSON parse, merge, and chronology. Untagged chronology contains repeated prefix scanning and becomes quadratic.

Refs: `src/main/ipc.ts:295-309`, `src/main/session/store.ts:705-780`, `src/shared/chronology.ts:84-93,110-123`.

### M2 — HIGH — concurrent bridge startup leaks an untracked live HTTP listener

**Verification:** RERUN.  
Re-run during consolidation:

```text
startBridge() concurrently -> 8766 and 8767
after one stop -> 8766 reachable, 8767 closed
```

Root cause: no startup lock/promise; global `server` is assigned only after asynchronous bind, so the second successful start overwrites the first reference.

Refs: `src/main/ipc.ts:151-179`, `src/main/bridge.ts:1251-1338`.

### M3 — HIGH — MCP endpoint disconnect drops the response while accepted mutation continues

**Verification:** RERUN.  
Re-run during consolidation:

```json
{"stopMs":1,"client":{"ok":false,"error":"TypeError: fetch failed"},"afterStopFile":"after"}
```

The caller gets transport failure and may retry, while the original tool continues committing side effects after disconnect. This is an ambiguous commit.

Refs: `src/main/mcp/server.ts:432-439`, `src/main/connection.ts:352-367`, `src/main/mcp/call-context.ts:121-153`, `src/main/mcp/kernel.ts:332-435`.

### M4 — MEDIUM — unsolicited state pushes erase focused unsaved settings edits

**Verification:** RERUN.  
Real renderer module in jsdom still produced:

```json
{"focused":true,"before":"tunnel_USER_IS_STILL_TYPING","after":"tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Main-side `buildState()` snapshots can also resolve out of order because pushes are not revisioned/serialized.

Refs: `src/main/ipc.ts:119-128,407-415`, `src/renderer/main.ts:390-393,466-473,1013-1029`.

### M5 — MEDIUM — `write_stdin` Ctrl+C / natural-exit race fabricates `kill ESRCH` failure

**Verification:** WORKER-REPRO.  
A command completed successfully, then Ctrl+C raced its unreaped session and returned `write_stdin failed: ... kill ESRCH`; immediate empty poll returned the real `DONE`, exit 0.

Refs: `src/main/codex/unified-exec.ts:446-463,714-752,781-795`.

### M6 — HIGH — PNG validation allows compressed-memory amplification in synchronous main-process path

**Verification:** RERUN.  
65,303-byte valid PNG expands to 67,117,056 decoded scanline bytes. Consolidation rerun measured:

```json
{"inputBytes":65303,"elapsedMs":42,"rssDeltaMiB":134.6,"externalDeltaMiB":128.1}
```

`inflateSync` has no output ceiling and width/height have no realistic pixel limit.

Refs: `src/main/codex/view-image.ts:253-324`, `src/main/fsops.ts:273-303,363-379`.

---

## 2C. Filesystem / sandbox / Codex-style tool behavior

### F1 — HIGH security — reparse/junction TOCTOU can redirect validated I/O outside an approved root

**Verification:** RERUN.  
The deterministic safe repro was executed again:

```json
{"resolved":"/workspace/gate/secret.txt","staleReal":"...\\approved\\gate\\secret.txt","read":"outside"}
```

The initial canonical containment check is valid, but later pathname-based I/O re-resolves a directory that can be replaced with a junction between check and use.

Affected pattern exists in `read`, `view_image`, `find`, exec cwd spawn, and patch validation/execution.

Refs: `src/main/sandbox.ts:277-300`, `src/main/mcp/tools-core.ts:1394-1460` plus other resolve-then-use callers.

### F2 — HIGH cross-chat integrity/privacy — terminal ownership fails open when caller identity is unresolved

**Verification:** SOURCE + existing test explicitly codifies it.  
`execOwnershipDenied()` denies only when both owner and caller are known and different. Unknown caller identity is allowed to enumerate process-manager sessions and call `write_stdin`; a session created while identity is unknown may remain ownerless.

This becomes materially dangerous because A1 proves unresolved identity can persist for an entire worker run.

Refs: `src/main/codex/ownership.ts:10-58`, `src/main/mcp/tools-core.ts:561-564,600-608,705-724`, `test/mcp.test.ts:2130-2138`.

### F3 — HIGH wrong-target mutation/execution — unresolved workspace identity falls back to first approved root

**Verification:** SOURCE + live identity-outage precondition.  
When omitted exec workdir or relative patch requires a chat workspace but identity never resolves, current code can substitute `currentWorkspace() ?? first root` rather than fail closed.

During worker-5's actual identity outage this precondition was real, not hypothetical.

Refs: `src/main/mcp/kernel.ts:366-380,438-457,539-551`, `src/main/mcp/tools-core.ts:474-479`.

### F4 — HIGH correctness — intercepted `cd missing && apply_patch` can mutate even though shell `cd` should fail

**Verification:** WORKER-REPRO + SOURCE.  
The worker issued an intercepted command whose cwd did not exist. Connector returned success, created the missing directory, and applied the patch. Ordinary `cd missing && ...` shell semantics would stop before mutation.

Upstream Codex verifier appears to share part of this behavior, so classify it as connector/user-command semantic risk rather than necessarily a port-parity divergence.

Refs: `src/main/mcp/tools-core.ts:1139-1151`, `src/main/codex/apply-patch/index.ts:216-224,356-371`.

### F5 — HIGH reliability/parity — `view_image` accepts plausible but undecodable WebP/JPEG/GIF payloads

**Verification:** RERUN/direct loader output.  
The saved invalid-WebP probe still reports:

```json
{"accepted":true,"mimeType":"image/webp","bytes":30}
```

The file has plausible RIFF/VP8 framing but no valid compressed image. Prime previously checked the same bytes with Pillow/libwebp and decoding failed.

Root cause: JPEG/GIF/WebP use structural heuristics rather than a real decode equivalent to upstream Codex `image::load_from_memory`.

Refs: `src/main/codex/view-image.ts:102-213,327-384`.

### F6 — HIGH output-contract — `read` image path bypasses the 512 KiB whole-call / per-file cap

**Verification:** SOURCE.  
`read` tracks a `MAX_READ_BYTES` 512 KiB budget, but its image branch calls standalone `viewImage()` without passing `options.maxBytes`; standalone image allowance is 8 MiB. The oversized image content block is created before `remaining` is adjusted.

Refs: `src/main/mcp/tools-core.ts:192-215,257-276,1434-1446`, `src/main/fsops.ts:15-19`.

### F7 — HIGH output/schema — exec/write_stdin structured output bypasses the model-output truncation policy

**Verification:** RERUN.  
Consolidation rerun:

```json
{"rawChars":240000,"modelTextChars":40208,"structuredDefaultChars":240000,"structuredExplicitHugeChars":240000,"modelTextWarnsTruncated":true,"structuredDefaultWarnsTruncated":false}
```

The same result is truncated in normal text but returned untruncated in `structuredContent.output`.

Refs: `src/main/codex/unified-exec.ts:505-553`, `src/main/codex/unified-exec-constants.ts:14-15,59-62`.

### F8 — HIGH transport reliability — standalone `view_image` duplicates full base64 payload

**Verification:** SOURCE.  
The handler returns the same bytes as both native MCP image content and `structuredContent.image_url`. At the nominal 8 MiB source ceiling this is at least ~22.37 million base64 characters (~21.33 MiB) before JSON/object overhead.

Refs: `src/main/mcp/tools-core.ts:168-177,322-329`.

### F9 — MEDIUM sandbox invariant mismatch — native Windows `..` is normalized away before traversal rejection

**Verification:** LIVE/prime-confirmed + SOURCE.  
Native:

`C:\Users\totec\chatgpt-local-files\src\..\package.json`

succeeds, while equivalent virtual:

`/totec/chatgpt-local-files/src/../package.json`

is refused with `Path traversal ("..") is not allowed`.

This does not itself prove root escape, but violates the requirement that native paths pass the same security invariants as virtual paths.

Refs: `src/main/sandbox.ts:218-268`.

### F10 — MEDIUM information disclosure — uncommon realpath errors leak native Windows sandbox path

**Verification:** RERUN.  
Self-referential junction still produces:

```text
ELOOP: too many symbolic links encountered, realpath 'C:\Users\totec\chatgpt-local-files\...'
```

and `friendlyError()` returns the same native path despite the model-facing no-real-path contract.

Refs: `src/main/sandbox.ts:147-164`, `src/main/mcp/kernel.ts:119-129`.

---

# 3. Severity-ranked remediation order

This is the recommended order based on damage radius and how bugs combine, not merely the original worker severities.

## P0 / first fixes

1. **A1/A2/A3/A4 — make agent/request identity resilient to Fiber loss.** A missing page-model helper currently destroys attribution, control-plane identity, inbox delivery, liveness, and eventually worker lifecycle. Health must prove Fiber itself is alive, and a failed Fiber round-trip after prior success must downgrade capability rather than leave sticky `fiberPresent=true`.
2. **F1 — close the reparse/junction TOCTOU.** Static `realpath` containment is insufficient when validated strings are later reopened after namespace mutation.
3. **F2/F3 — fail closed on unresolved caller/workspace identity.** The exact state demonstrated by worker-5 currently weakens terminal isolation and can choose a wrong project root.
4. **A7/A8 — add per-document/tab epochs/tombstones.** Permanent cross-chat transcript misattribution is worse than visible failure.
5. **M3 — define coherent shutdown semantics for accepted MCP mutations.** Either drain and deliver or cancel and guarantee no post-failure side effects.

## P1

6. **A5/A6 — rebuild/recover correlation and live activity from durable history.** Restarts should not erase exact ownership or leave an open page with empty `/activity`.
7. **A9/A10/A11 — make observation/recording transport loss-aware and idempotent.** No silent queue eviction, no duplicate lifecycle on retry, no exact-call ordering bypass.
8. **M1 — bound session-history work before whole-file chronology.** Current `limit` is a response cap, not a computation cap.
9. **M2 — serialize bridge lifecycle.** One startup promise/server; stop must close every listener created by that lifecycle.
10. **M6/F5/F6/F8 — replace ad-hoc image validation/budgeting with one real decoder + decoded-size and wire-size budgets.**

## P2

11. **A12/A13 — make Overwrite fail transparently when reconstruction is incomplete.** Never hide the only current native evidence behind a stale local replacement.
12. **F7 — apply one output cap to every MCP representation.** Structured output must not bypass the text policy.
13. **F9/F10 — restore native/virtual sandbox parity and sanitize all filesystem errors.**
14. **M4/M5 — preserve dirty renderer form state and reconcile just-exited processes instead of reporting false failures.**
15. **A14 — worker bootstrap must not steal human input/focus.** Treat opening/focusing browser tabs as a user-interaction hazard, especially when retrying failed workers.

---

# 4. Verification pass performed during consolidation

At approximately 12:23–12:26, the current dirty tree was rechecked without production fixes.

## Re-runs that still reproduce

- **Fiber health gap:** desired Fiber reinjection assertion fails; `executeScript` call count is 0.
- **Stale partial correlation restore:** `wfr_new` restores as `undefined` despite newer durable attributed history.
- **Concurrent bridge start:** two ports bind; one remains reachable after stop.
- **Renderer dirty-field clobber:** focused value is reset by state push.
- **MCP stop/in-flight ambiguous commit:** client gets `fetch failed`; delayed mutation still lands.
- **Windows junction TOCTOU:** stale validated path reads sibling `outside` content after directory→junction swap.
- **Native-path disclosure:** `ELOOP` still returns full `C:\...` path.
- **Structured output cap bypass:** ~40k model text vs 240k structured output.
- **PNG expansion:** 65 KB compressed image still causes ~134.6 MiB RSS growth / ~128.1 MiB external memory in one validation.
- **Invalid WebP gate:** direct loader still accepts the 30-byte plausible-but-undecodable WebP probe.

The combined Vitest probe invocation exited nonzero because two tests intentionally assert the desired fixed behavior (Fiber health and correlation restore) and therefore fail on the current implementation. `repro-view-image-gap.test.ts` is a direct executable probe rather than a normal Vitest `it()` suite; invoking it through Vitest printed its acceptance result and then reported "No test suite found". That is a probe-harness detail, not another connector bug.

---

# 5. Tests that currently give false confidence

Several bug classes coexist with green focused suites because the missing dimensions are concurrency, restart, identity outage, resource scale, or deliberately skipped content-script cases.

- Filesystem/Codex targeted suite was previously **230 passed, 1 skipped** while F1–F10 remained present.
- MCP/Electron focused suite was **193/193 green** while the bridge race, disconnect ambiguous commit, dirty-field clobber, and PNG amplification all reproduced.
- Extension/transcript relevant suites were **355 passed, 82 skipped** while cross-chat lifecycle races, stale correlation, queue loss, and `/activity` restart split brain reproduced.
- Non-legacy content-script cases around generation binding are still skipped, including the two cases prime temporarily enabled and saw fail during the live Overwrite incident.
- Existing exec ownership coverage explicitly treats unknown caller → another conversation's terminal write as allowed, so a green test currently codifies the fail-open behavior rather than protecting isolation.

---

# 6. What held up / negative findings

The audit also checked several areas that did not produce a new confirmed bug:

- current oversized chunked/no-Content-Length MCP request protection is present and tested;
- Core/Desktop endpoints are path/token separated and loopback Host/Origin checks are in front of handlers;
- Electron window isolation settings are materially hardened (`contextIsolation`, renderer sandbox, no Node integration, denied arbitrary navigation/window opening);
- the old renderer session-A/session-B async detail paint race is guarded by generation checks in the current tree;
- static pre-existing symlink/junction escapes are generally rejected correctly; F1 is specifically the namespace swap after validation;
- `find` does not appear to follow static directory symlinks in either backend;
- Windows process-tree termination has a bounded `taskkill` helper plus fallback;
- ordinary virtual `..` traversal is rejected before normalization.

These should remain regression-protected while the findings above are fixed.

---

# 7. Evidence files retained in this directory

Primary reports:

- `MASTER.md`
- `worker-extension-transcript.md`
- `worker-mcp-electron.md`
- `worker-filesystem-codex.md`

Saved repro/probe artifacts include:

- `repro-fiber-health-gap.test.ts`
- `repro-correlation-stale.test.ts`
- `probe-bridge-race.test.ts`
- `probe-renderer-state-clobber.test.ts`
- `probe-mcp-stop-inflight.test.ts`
- `probe-session-tail.test.ts`
- `repro-reparse-toctou.ts`
- `repro-error-path-leak.ts`
- `repro-exec-structured-cap.ts`
- `repro-view-image-gap.test.ts`
- `probe-view-image-inflate.test.ts`
- `png-inflate-probe.png`

The original worker reports contain exact chronological tool-error logs and narrower source references. This consolidated file is the preferred starting point because it deduplicates them, adds the worker-5 forensic correlation comparison, records the 12:23–12:26 re-verification, and adds the two new failure-amplification findings (`fiberPresent` stickiness and active-work→false-stall cascade).

---

# 8. Bottom line

The failed subagent incident is now explained at a much higher confidence level than "one worker randomly went Unattributed." The broker had a correct worker/conversation binding. The worker generated a stable MCP request id and performed 67 calls. The correlation registry learned exact mappings for the other simultaneous workers but never learned this request id. The worker's page/session lifecycle survived while Fiber-derived page-model activity disappeared. Current background recovery can incorrectly call that state healthy because it only proves `content.js`, and the current regression still demonstrates that blind spot.

The most important architectural fix is therefore to stop treating conversation attribution as a best-effort cosmetic layer. In multi-agent mode it is part of the control and security boundary: it decides worker identity, inbox delivery, terminal ownership, workspace selection, liveness, transcript placement, and cleanup. If exact correlation is unavailable, those operations should either recover from stronger durable/run evidence or fail closed; they should not silently continue under Unattributed and then infer that the correctly bound worker is dead.
