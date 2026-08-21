# Bug hunt — main-process session/bridge slice (read-only)

Scope: `src/main/bridge.ts`, `src/main/session/{recorder,store,continuation,summarize}.ts`, `src/main/agents.ts`.
Method: full read of all six files; line numbers verified against the on-disk code. No tests run, nothing modified.

---

## HIGH

### H1. Session rebind vs. in-flight session initialization race resurrects a stale conversation→session mapping
- **File:** `src/main/session/recorder.ts:226-266` (`initializeSessionForConversation`) vs `recorder.ts:1626-1645` (`rebindConversation`)
- **What breaks:** A conversation→session live entry that Compact & Resume deliberately deleted can be re-installed *after* the rebind, pointing the old chat A at the session that now belongs to chat B.
- **Scenario:** A stale tab (or a late extension batch) on chat A starts `sessionForConversation(A)`. That async path awaits `findSessionByConversation(A)` (`recorder.ts:246`). While that await is pending, the continuation commit lands: `rebindSession` moves the session A→B and `rebindConversation` deletes the `A` entry and installs `B` (`continuation.ts:507`, `recorder.ts:1626`). The initializer then resumes with the pre-rebind `known` summary and executes `conversations.set(conversationId=A, {sessionId})` (`recorder.ts:262`). From then on the stale A tab appends observations into the session that is durably attached to B — exactly the cross-chat contamination `rebindConversation`'s docblock says must not happen ("A stale tab still sitting on A must not go on appending into a session that has moved"). `liveConversations()` also reports two conversations for one session, which breaks `soleConversationForSession` ambiguity fail-closed and `chatIsWorking`.
- **Fix (minimal):** After the final await in `initializeSessionForConversation`, re-check before `conversations.set`: if a concurrent rebind moved this session (e.g. `getSession(session.id).conversationId !== conversationId`), refuse to install the live entry (return the session id but do not map A), or have `rebindConversation` bump a generation counter that the initializer samples before its first await and validates before `set`.

### H2. A failed Compact & Resume commit is aborted instead of retried, contradicting the retry design
- **File:** `src/main/bridge.ts:1272-1281` (`/commands/ack` resume commit path) + `bridge.ts:1896-1902` (`drop`) vs `src/main/session/continuation.ts:470-489`
- **What breaks:** `commitContinuation` returning false deliberately restores the transaction to `claimed`/`awaiting-chat` "so the caller may retry" (`continuation.ts:477-481`, and the thaw of the prime transfer). The bridge instead treats any false as terminal: it calls `ackCommand(id, 'failed', …)` → `drop(command)` → `abortContinuation(token, why)`, which sets state to `aborted` and calls `cancelPrimeTransfer`. A transient `rebindSession` disk failure (or an ack that arrives before the page reported its conversation id) permanently kills a transaction that was specifically built to be retryable — and the bridge's own comment at `bridge.ts:1266` claims "A commit that does not land leaves the session in the old chat and the command unfinished, **so it is retried**."
- **Scenario:** Disk momentarily busy → `writeSummary` in `rebindSession` throws → commit returns false, state restored to `claimed`, handover thawed → bridge immediately aborts the continuation and fails the command. User must start the whole compaction over (new press, new compaction turn).
- **Fix (minimal):** In the `!moved` branch, do not `ackCommand(...,'failed')` (which drops+aborts). Leave the command alive (or re-queue it) so a later ack with a conversation can retry `commitContinuation`, or add an explicit "retryable" return from `commitContinuation` and only abort on the non-retryable refusals (bad token, wrong state).

---

## MEDIUM

### M1. `/activity` poll for a never-recorded conversation does a full session-directory scan every few seconds
- **File:** `src/main/bridge.ts:762-770` + `src/main/session/recorder.ts:216-226` (`restoreRecordedConversation`) + `src/main/session/store.ts:1053-1080` (`readAllSummaries`)
- **What breaks:** Every `/activity` poll for a conversation with no live entry calls `restoreRecordedConversation`, which calls `findSessionByConversation` → `readAllSummaries()` → `readMeta` (a `meta.json` read + JSON.parse) for **every** session folder, up to `MAX_SCANNED_SESSIONS = 5000`. An ordinary ChatGPT tab on a chat this app never recorded polls every few seconds forever, keeping the Electron main process doing thousands of small file reads per minute. Same cost recurs for every unknown conversation tab.
- **Fix (negative cache):** Remember conversation ids that had no durable session (with a short TTL, or invalidate on `createSession`/`rebindSession`) so repeat polls skip the scan.

### M2. `repairDeterministicAttribution` re-reads full unattributed buckets and full target tool_call history on every late-evidence pass
- **File:** `src/main/session/recorder.ts:699-706` (`readEvents(summary.id)` full read), `recorder.ts:790-796` (`readEvents(targetSessionId, { kinds: ['tool_call'] })` full read per target)
- **What breaks:** Each coalesced repair pass (scheduled up to every 250 ms while late request-id evidence keeps arriving, `recorder.ts:610-640`) iterates **all** sessions, fully parses each Unattributed session's entire `events.jsonl` (unbounded growth over the app's life), and fully re-reads each target session's tool_call history to build the callId dedupe set. With a large historical Unattributed bucket this is repeated O(file) parsing many times per burst.
- **Fix (minimal):** Keep an in-memory callId set per target session (the store already keeps a 4096-event tail; or maintain the set incrementally as calls are appended), and skip Unattributed sessions whose event count is unchanged since the last pass.

### M3. Worker auto-finish requires the final assistant message and its `turn_end` in the same `/events` batch
- **File:** `src/main/bridge.ts:660-676`
- **What breaks:** `finishWorkerConversation` fires only when one batch contains both a `final === true` assistant message *and* a matching `turn_end` (`observations.some(... entry.turnId === final.turnId)`). The extension batches on a poll tick; if the turn_end observation and the settled final message straddle two batches (streaming final flag set in one tick, lifecycle end in the next), the worker is never terminalised here and survives as a zombie until the 2-minute `sweepStaleSwarm` orphan path — which additionally requires durable quiescence and, in the worst case, discards the pending final report via `allowPendingReports`.
- **Fix (minimal):** Track per-conversation "final assistant text seen for turn X" in memory (or read it back via `readRecentEvents`) so a `turn_end` arriving in a later batch can still terminalise the worker.

### M4. `closeConversation` can be undone by a queued observation batch, silently reopening an "ended" session
- **File:** `src/main/session/recorder.ts:1595-1612` (`closeConversation`) vs `recorder.ts:1315-1330` (`observationChains`) and `recorder.ts:226+`
- **What breaks:** `/closed` runs `closeConversation` (deletes the live entry, `endSession`), but a `recordChatObservations` batch for the same conversation may already be queued on `observationChains` (or arrive a moment later from the at-least-once service-worker retry). Its `sessionForConversation` path finds no live entry, `findSessionByConversation` still finds the (now ended) session, and `reopenSession` clears `endedAt` — resurrecting a session the user just closed, plus a fresh live map entry for a tab that no longer exists. Mostly harmless, but it un-ends sessions in the UI and can keep `liveConversations()` reporting a ghost generating chat (feeding `chatIsWorking`/auto-compact liveness).
- **Fix (minimal):** Record close time per conversation and have `initializeSessionForConversation` refuse to reopen if the last `/closed` for that conversation is more recent than the newest observation time in the triggering batch.

### M5. Legacy `/commands/ack` (no `client`) can bind a worker / commit a continuation with no ownership check
- **File:** `src/main/bridge.ts:1216-1235`
- **What breaks:** The `owner !== client` fail-closed check at `bridge.ts:1233` only applies when `client` is present. A pre-upgrade extension page (or any caller that omits `client` — it is optional on the wire) can ack a command whose lease was taken by another document, or after the spec was superseded by `queue()` (`bridge.ts:1516-1536` clears `owner` precisely so old pages get refused — but only if they send `client`). The ack then `bindConversation(agent, conversation)` and can `commitContinuation` to an arbitrary conversation id the caller names. All behind the bearer token, so this is a same-trust-model race rather than an escalation, but it defeats the "one command is one chat" invariant during the upgrade window the code elsewhere is careful to protect.
- **Fix (minimal):** Refuse acks with no `client` once `command.claimedAt !== null` (i.e. any command this build delivered), keeping the legacy no-op only for commands restored from a previous run.

---

## LOW

### L1. `summarize.ts`: `start_line = 0` silently drops the line-range detail
- **File:** `src/main/session/summarize.ts:262-266` — `start && end ? ...` treats a valid `start_line: 0` as falsy, so a read beginning at line 0 shows no range/metric. Use `num()` results with `!== null` checks. Cosmetic/presentation only.

### L2. `conversations` map in the recorder grows without bound if `/closed` is never delivered
- **File:** `src/main/session/recorder.ts:70` — entries are removed only by `closeConversation`, `rebindConversation`, `forgetSession`. A browser killed outright (no `pagehide`/`/closed`) leaks one `LiveConversation` (with `pageTools`, turn sets) per chat ever observed, for the life of the app process. Bounded in practice by user behaviour, but a long-running app accumulates them. A periodic reconcile against `browserPresent()`/durable sessions would bound it.

### L3. `readEvents` calls the global `flushSessions()` on every read
- **File:** `src/main/session/store.ts:766` — every `readEvents` (including per-poll paths that fall through the tail cache) iterates **all** open sessions and enqueues a flush op on each one's write queue. Cheap when nothing is dirty, but it couples every read to every session's queue; a flush of just the target session would do.

### L4. `pruneSessions` never prunes a session that is open in memory, even if ancient
- **File:** `src/main/session/store.ts:1478` — `if (open.has(summary.id)) continue;`. A session kept open by a stuck queue (or simply still mapped to a live conversation) is exempt from retention forever; combined with L2 the disk can exceed the retention window. Low impact; worth a comment or an age-based exception.

### L5. `/compact` capture for an already-committed continuation returns `session_not_recorded` instead of the idempotent success
- **File:** `src/main/bridge.ts:963-985` — after commit, chat A resolves to no session (`listSessions` no longer matches A), so a retried capture with a valid token gets 409 `session_not_recorded` rather than `continuationByToken(token)`'s stored handoff. The token check (`entry.sessionId !== sessionId`) never runs. A lost-response retry therefore surfaces an error for a move that actually succeeded. Resolve the session from the token first when it validates, then fall back to the conversation lookup.

### L6. `queue()` overflow can drop a command that is mid-delivery (leased)
- **File:** `src/main/bridge.ts:1540-1548` — the overflow `drop(oldest)` does not check `isLeased(oldest)`. If 20 commands pile up while the first is being opened in the browser, the oldest is dropped (aborting its continuation / failing its worker) while a page may be actively redeeming it; that page's subsequent redeem gets 404 and its ack gets 404 (`bridge.ts:1195-1200`), which is the intended stale-marker behavior, but the abort happens under a live claim. Consider skipping leased commands when choosing the overflow victim.

### L7. `resumeJobFor` reports `waiting-for-browser` when no browser opener exists
- **File:** `src/main/bridge.ts:1668-1672` — stage is `waiting-for-browser` when `command && !isLeased(command) && !openInBrowser`. With `openInBrowser === null` (headless/test/no shell wiring) `deliver()` drops the command, but in the window before that drop the page is told the app is "waiting for the browser" — inverted label. Cosmetic.

---

## Verified non-issues (checked, sound)

- `readBody` overflow path drains the socket and answers 413 (`bridge.ts:352-383`); JSON parse errors answered 400.
- Rate limit charges only authenticated requests (`bridge.ts:432-436`); token compared via length-checked `timingSafeEqual`.
- `sweepStaleSwarm` re-checks `runId`/transfer/in-flight counters between every await (`bridge.ts:1390-1455`); `observationWritesInFlight` guards partial-batch sweeps.
- `appendEvent` reconciles uncertain commits against `lastSeqOnDisk` before admitting the next writer (`store.ts:640-676`); torn tails sealed before append.
- `rebindSession` stages on a clone, writes durably, publishes into the live object only after success (`store.ts:1245-1310`); `committing` state flipped synchronously before first await in `commitContinuation` (`continuation.ts:443-447`).
- `claimContinuation` never moves state backwards out of `committing` (`continuation.ts:398-414`).
- `restoreContinuations` resolves a persisted `committing` from authoritative meta.json and quarantines a third identity (`continuation.ts:520-560`).
- `bindWorkerConversation` enforces one-binding-per-slot and one-slot-per-conversation, tombstones included (`agents.ts:1252-1280`).
- `finishAgent` is idempotent on retry (`agents.ts:905-912`); final report bypasses `MAX_QUEUE` deliberately.
- `upsertMessageEvent` treats `final` as terminal against stale streaming snapshots (`store.ts:705-716`).
- `findSessionByConversation` uses the uncapped `readAllSummaries`, never the UI-capped `listSessions`, for ownership (`store.ts:1095-1125`); `requireUnique` fails closed for safety-sensitive callers.
- `storedHistory` bounds its replay read (`recorder.ts:447-455`) and the open-turn ledger prevents reload resurrection of finished turns (`recorder.ts:1345-1365`).
