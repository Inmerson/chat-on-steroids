# Luna2 session-integrity audit

Scope: the current dirty tree's `src/main/session/store.ts`,
`src/main/session/recorder.ts`, `src/main/session/correlation.ts`,
`src/shared/chronology.ts`, `src/main/bridge.ts`, the browser observation producer in
`extension/background.js`, and the direct session consumers. I also checked the Compact &
Resume transaction and the durable state helper where they participate in session retry or
crash semantics.

This is a read-only audit. I read `AGENTS.md` and
`bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md`, inspected the current
dirty diffs and relevant tests, and changed no production, test, AppData, config, or Git
state. The only file written for this task is this report.

Non-mutating verification:

- `node_modules/.bin/tsc --noEmit -p tsconfig.json` currently fails. The session-specific
  errors are the missing `StoredHistory.knownTurnStarts`/`knownTurnEnds` fields below; it
  also reports an unrelated `src/main/ipc.ts:310` nullable-summary error.
- A direct Vitest startup attempt could not load the repository config in this restricted
  environment (`Cannot read directory "..": Access is denied`). No test files were changed.

## Ranked findings

### 1. P0 — the current lifecycle-recovery change does not typecheck

Refs: `src/main/session/recorder.ts:265-281,390-399,412-464`.

`LiveConversation` has the new `knownTurnStarts` and `knownTurnEnds` sets, and
`storedHistory()` constructs and returns them. However, `StoredHistory` still declares only
`openTurns`, `activeTurnId`, `activeTurnStartedAt`, and `pageTools`. The initializer reads
`history.knownTurnStarts`/`history.knownTurnEnds`, and the return object supplies properties
that are not in the interface. The compiler reports TS2339 at the reads and TS2353 at the
return object.

Minimal change: add both set fields to `StoredHistory`, then run the session/recorder,
bridge, chronology, and full typecheck suites. This is a source blocker, not a speculative
runtime concern.

### 2. P0/P1 — an uncertain `appendFile` failure can lose an event or reuse its sequence on
retry

Refs: `src/main/session/store.ts:279-297,333-352,558-587,717-779`.

`appendEvent()` assigns `entry.nextSeq` and advances it only after `fs.appendFile()` resolves.
If the OS writes a prefix (or even a complete line) and then reports an error, the rejected
write leaves the already-open entry with the old `nextSeq`. Its queue deliberately swallows
the rejection, and the next append reuses that sequence. `ensureOpen()` is not re-entered,
so `sealTornTail()` does not put a newline between a partial line and the retry.

The outcomes are all bad for the journal contract:

- a partial JSON line concatenated with the retry is skipped by `readEvents()`, losing both
  the attempted event and the retry;
- a complete line followed by a rejected promise is appended again with the same `seq`;
- a process restart may recover the tail, but a same-process bridge retry does not.

The existing append-failure test mocks a rejection before any bytes are written, so it does
not cover this uncertain-commit case. A deterministic regression should:

1. create a session and append `seq:1`;
2. replace `fs.appendFile` once with a function that writes half of the supplied line using
   the real implementation and then rejects; call `appendEvent()` and expect rejection;
3. restore the writer and append the browser/MCP retry;
4. repeat with a writer that writes the full line and then rejects;
5. inspect raw JSONL and `readEvents()`, requiring parseable events, one logical retry, and
   strictly increasing unique sequences.

Minimal safe change: treat a failed append as an unknown commit. Before admitting another
write for that session, serialize a recovery that seals the tail, scans/revalidates the
last durable event, reconstructs `nextSeq` and the projection, and only then retries. A
stronger design adds a per-event durable id/checksum or an append outbox so a full-line
uncertain commit can be recognized. Simply deleting `open` on rejection is not sufficient
unless pending writers are also serialized and all append producers (`tool_call`, lifecycle,
notes, handoff, `session_start`, and attribution repair) use the recovered entry.

### 3. P0/P1 — metadata writes are outside the session queue and can roll Compact & Resume
back from B to A

Refs: `src/main/session/store.ts:163-207,548-579,689-697,901-958,1103-1227`.

The append/canonical queues serialize event content, but metadata does not have the same
ownership. `scheduleMeta()` starts a delayed `writeMeta(entry)` using the mutable summary;
`flushSessions()` can race a timer callback already in progress; and
`reopenSession()`, `renameSession()`, `setSessionOrigin()`, and `endSession()` mutate and
write directly. `rebindSession()` waits for `entry.queue`, then writes a staged B summary
directly with `writeSummary()`, but it does not wait for a pending timer or another direct
writer. All writers use the same `meta.json.tmp` path.

There is also a generation race inside the timer itself: the callback sets `metaTimer` to
null, snapshots old summary A, and awaits its write. A new append can set `metaDirty` again,
schedule a second timer, and then the old write sets `metaDirty = false` after the new event.
Shutdown can therefore believe the newer projection is clean. `endSession()` does not clear
an outstanding timer, so a close followed quickly by reopen can have the old timer write an
ended summary over the reopened one.

The concrete Compact & Resume repro is:

1. open session A and append enough to arm the delayed metadata timer;
2. suspend the first `meta.json.tmp` write after it has captured A;
3. concurrently call `rebindSession(A, chatA, chatB)` and a normal rename/origin or append;
4. release the writes in the reverse order, then clear in-memory state and read the durable
   summary; also exercise end → reopen before the timer fires;
5. require exactly chat B, the newest title/origin, `endedAt: null`, and counters matching
   the event files.

Minimal change: make every metadata mutation an immutable operation on one per-session
   metadata queue, including the timer, flush, rename/origin/reopen/end, repair, and rebind.
   Cancel or generation-invalidate delayed writes at terminal/rebind boundaries; use a
   unique temporary name or keep the shared name behind that queue. `rebindSession()` must
   wait for all older metadata work and publish its in-memory summary only after the B write
   wins. Regression coverage belongs in `session.test.ts`, `continuation.test.ts`, and
   bridge activity/reopen tests, including two concurrent `flushSessions()` calls.

This is not merely cosmetic metadata: `findSessionByConversation()`, exact target-session
checks in `targetSession()`, `/activity` recovery, stale-swarm checks, token meters, and
Compact & Resume all consume the summary as ownership/projection state.

### 4. P1 — accepted journal/canonical data can leave a permanently stale summary after a
crash

Refs: `src/main/session/store.ts:188-207,333-352,558-697,960-1032,1096-1100`.

`appendEvent()` returns after the JSONL append and `upsertMessageEvent()` returns after the
canonical `messages.json` rename, while summary persistence is delayed by 1.5 seconds.
After a process/power crash in that interval, `ensureOpen()` reads the old `meta.json`; it
uses the log/canonical snapshot to choose `nextSeq`, but it never reconciles the summary.
`getSession()`, `listSessions()`, `findSessionByConversation()`, and bridge `/activity`
therefore continue to expose old `events`, token counts, `updatedAt`, errors, and
auto-compaction state until a later write happens. A canonical user/assistant message is
especially clear: it exists in `messages.json` but has no post-1.8 event-log fallback, so
the summary can claim zero messages while `readEvents()` returns one.

Proof design:

- create a session, append an event and upsert a canonical message, then stop before the
  metadata timer (or block its write), clear the in-memory store, and reopen;
- compare `getSession()`/`listSessions()` and bridge `/activity` token fields with a fresh
  projection of `readEvents()` and `messages.json`;
- require the projection to be repaired before ownership lookup or UI response.

Minimal change: persist a projection high-water mark and reconcile the event/canonical delta
on open, or rebuild the summary from the authoritative log plus canonical map before exposing
the session. The repair must understand canonical revisions, `rewriteUnattributedToolCalls`,
and the `contextTokens` reset at rebind; it cannot blindly count every canonical revision as a
new logical message. Add a crash/restart test for append-only and canonical-only commits,
then check `listSessions`, `findSessionByConversation`, IPC history, bridge `/activity`, and
stale-swarm consumers.

Strict power-loss durability is a separate part of the same contract: the current JSONL,
metadata, and canonical writes do not call `fsync`/`FileHandle.sync` or directory sync. If a
200 response is meant to mean stable-on-disk rather than accepted-by-the-OS, add that barrier
or explicitly expose an accepted-vs-stable state.

### 5. P1 — `ensureOpen()` has no in-flight initialization guard; restart races can mint duplicate
sequences and divergent canonical maps

Refs: `src/main/session/store.ts:212-235,333-352,597-697`.

Two callers that reach an unopened session concurrently both seal/read the files, calculate
the same `nextSeq`, create independent `OpenSession` objects, and only then race on
`open.set(id, entry)`. Their independent queues can append the same sequence, and canonical
upserts use the same `messages.json.tmp` with different snapshots. The last map installed
also loses the other caller's in-memory tail/summary.

The existing `sessionForConversation()` first-sight promise protects one recorder path, but
direct `appendEvent()`/`upsertMessageEvent()` callers (MCP recording, bridge recovery, reads
after a reset, and repair) still converge on unguarded `ensureOpen()`.

Regression design: create/flush a session, call `resetSessionStoreForTests()`, then run two
`Promise.all([appendEvent(id, e1), appendEvent(id, e2)])` calls with a read barrier inside
`fs.readFile`/`lastSeqOnDisk`; repeat with two distinct canonical message ids. Assert unique
ordered sequences, both messages, one final summary, and no temporary-file collision.

Minimal change: use an `opening` promise map keyed by session id, install the promise before
the first disk await, remove it on failure, and publish exactly one `OpenSession`. Make
`createSession()` publish only after directory/files/meta initialization succeeds (or roll
back its early `open.set` on every failure). Test direct store callers as well as
`recordToolCall`, `recordChatObservations`, and `/activity` recovery.

### 6. P1 — bridge observation retries are only partially idempotent, and concurrent batches
can duplicate lifecycle/recovery rows

Refs: `src/main/bridge.ts:611-675`; `src/main/session/recorder.ts:1250-1462`;
`extension/background.js:370-455,917-929`.

The bridge has no per-conversation write chain. Two `/events` requests can both read the same
`live.knownTurnStarts`/`knownTurnEnds` state before either durable append publishes the set
entry. Both then append the same `turn_start` or `turn_end`. The same check-then-append race
exists in `recordPageTool()`. `recoveredFinal` is computed before the loop and appends a
recovery `turn_end` without first checking `knownTurnEnds`, so two concurrent reload polls can
close one open turn twice.

The browser journal intentionally keeps a batch until HTTP 200. A lost response therefore
replays the exact batch, which is safe for canonical messages and sequential lifecycle replay,
but `chat_error` has no stable id or dedupe key and is appended every time. A partial batch
that committed earlier rows before a later row failed is replayed as a whole; there is no batch
id or per-observation commit result.

Regression schedule:

- Hold the first lifecycle append on a promise barrier and `Promise.all` two identical
  `recordChatObservations()` calls; assert one start/end. Repeat with a final assistant
  recovery and two `page_tool` observations.
- Make an `/events` request lose its response after the recorder commits, replay the body,
  and assert canonical/lifecycle/chat-error counts. Make a later item fail after an earlier
  `chat_error` committed and assert the retry does not duplicate it.
- Keep the existing “commit failure leaves lifecycle eligible for retry” test; it must still
  pass after serialization.

Minimal change: serialize the complete observation batch per conversation (initialization
outside the chain, state mutation only after the awaited append), and give non-canonical rows a
stable browser observation/batch id that is durably deduped. The id must flow through
`content.js`/`background.js`, bridge parsing, recorder, and restart reconstruction; a
content hash is not a safe substitute for two real same-text errors. `/closed` must share the
same conversation chain.

### 7. P1 — agent-message delivery can be acknowledged before it is recorded, and replay is not
deduped despite the stable `messageId` contract

Refs: `src/main/mcp/kernel.ts:415-423,491-500`; `src/main/agents.ts:810-822`;
`src/main/session/recorder.ts:1489-1510`; `src/shared/session.ts:249-266`.

`acknowledgeOffers()` marks messages acknowledged and triggers broker persistence before
`recordAgentMessage(message, 'delivered')` is called. `recordAgentMessage()` catches any
append failure and returns, so the message can disappear from the durable recipient history
while the broker believes it was delivered. Conversely, if the session append succeeds and
the process dies before the broker snapshot lands, restart reoffers the message and the next
ack appends a second delivered row. The shared type comment explicitly promises that the
stable `messageId` prevents reoffers from producing a second record, but the implementation
always calls `appendEvent()` and has no `(sessionId, messageId, delivery)` lookup.

Proof design:

- spy `appendFile` to fail during the delivered append; call the kernel acknowledgement path;
  assert the broker state does not claim durable delivery or that a retry produces the row;
- call `recordAgentMessage()` twice with the same message/delivery and inspect the session;
- simulate append success followed by a lost durable swarm snapshot, restore, acknowledge,
  and require one delivered row.

Minimal change: make the session append idempotent by `(sessionId, messageId, delivery)` (a
small durable agent-message index or canonical upsert), and only retire/ack the broker offer
after the append is durably accepted; alternatively use a durable outbox transaction that
reconciles both sides. Preserve the intentional two-record shape by including `delivery` and
session in the key. Verify `kernel`, `tools-core` sent reports, bridge worker-finish reports,
Compact & Resume, and restart restore.

### 8. P1 — `/activity` still turns an old cursor or page reload into an unbounded full-history
read and response

Refs: `src/main/bridge.ts:700-875,1160-1184`; `src/main/session/store.ts:717-785`;
`extension/content.js:3450-3520`.

The default desktop/MCP tail was improved by `readRecentEvents()`, but `/activity` calls
`readEvents(live.sessionId, { from: since })` with no limit. `readEvents()` reads and splits the
entire JSONL, merges all canonical messages, runs chronology, and only then slices. Content
starts at `since=0` on initial load/reload and can reset its cursor on navigation, so a large
session sends every assistant message, rendered HTML, and tool summary back through the bridge.
The stale-swarm sweep, correlation restore, deterministic repair, and `storedHistory()` also
use unbounded `readEvents()` maintenance scans.

The consolidated M1 probe already demonstrates the scale risk: a roughly 250k-event/40 MiB
history made a `limit:1` read freeze the main process for tens of seconds before the recent
tail fix. `/activity` remains on the old path.

Regression design: create a synthetic large session, reset the live recorder, call
`/activity?conversationId=...&since=0`, and measure parse bytes, response size, wall time, and
heap. Repeat with a cursor older than the retained tail and with canonical assistant HTML.

Minimal change: maintain a bounded presentation index/tail and define a cursor-gap response
(`truncatedFrom`, `hasMore`, or an explicit resync token) when `since` predates it. The
content script must rebuild its local stream on that marker; silently slicing would lose
rows. Use the same index for lifecycle recovery, correlation restore, and repair, or stream
JSONL once with a hard byte/CPU budget. Preserve canonical revision/origin and user-anchor
semantics while bounding serialized text/HTML.

### 9. P1 — character caps do not enforce the JSONL byte ceiling; emoji/CJK messages can be
accepted by the bridge and then fail forever in the recorder

Refs: `src/main/bridge.ts:488-523`; `src/main/session/recorder.ts:788-806,1335-1363`;
`src/main/session/store.ts:52-60,566-571`.

`parseObservations()` and `storeText()` cap JavaScript characters (256,000 text and 120,000
HTML), while `appendEvent()` rejects a serialized line over 512 KiB. A value such as
`'😀'.repeat(130_000)` is below the character cap but is about 1 MiB in UTF-8 before the
message envelope. A user/assistant observation can therefore fail after `storeText()` and
canonical preparation, making the bridge return an error/network retry with the same
unstoreable body. The problem is worse when text and rendered HTML coexist.

Regression design: send an assistant observation with 130k emoji (and a user observation with
large CJK text) through `recordChatObservations()` and through the bridge parser; assert the
operation either stores an inline line below the byte ceiling or spills predictably, never
rejects after accepting the browser batch. Include a text+HTML combined case.

Minimal change: budget serialized UTF-8 bytes, not only code units, including the enclosing
event. Spill or truncate fields before `upsertMessageEvent()` when their combined encoded
representation would exceed `MAX_LINE_BYTES`; keep `StoredText.chars` as the documented
logical count. Verify all producers (user/assistant/chat errors, tool args/results, agent
messages, notes) against the same line bound.

### 10. P1 — Compact & Resume does not reject a target conversation already owned by another
session

Refs: `src/main/session/continuation.ts:361-413`; `src/main/session/store.ts:1186-1228`;
`src/main/session/recorder.ts:1575-1590`.

`commitContinuation()` checks only that B is nonempty and differs from A. `rebindSession()`
checks A's source summary but does not check a durable current B. `rebindConversation()` then
unconditionally overwrites `conversations[B]`, even if B was already mapped to a different
session. The result can be two summaries current on B, an ambiguous safety lookup, and old B
observations writing into the moved A session after the map overwrite; the displaced session
becomes an orphan.

Regression design: create live sessions for A and B, open a continuation for A, commit it to
B, then call `findSessionByConversation(B, { requireUnique: true })` and submit observations
from B. Assert the commit refuses before any durable or in-memory change. Also race a B
observation with the commit.

Minimal change: preflight the target in both durable summaries and the live map. Allow only an
unowned target (or a target already owned by this exact session/transaction); otherwise refuse
and leave A intact. Make the map move conditional rather than overwrite. Add tests for bridge
resume, duplicate claimant retries, stale B tabs, and the exact-session request attribution
path.

### 11. P1/P2 — lifecycle/page-tool de-duplication state is unbounded and cold restore materializes
the whole history

Refs: `src/main/session/recorder.ts:72-105,261-282,412-464,1250-1281,1403-1455`.

Every live conversation retains `knownTurnStarts`, `knownTurnEnds`, and a `pageTools` map for
the entire session lifetime. `storedHistory()` rebuilds all three from an unbounded
`readEvents()` call. `MAX_EVENT_TAIL` bounds only the store's recent read cache; it does not
bound these maps or the cold-start scan. A long-lived chat with many turns/activity rows can
therefore hold large sets indefinitely and make app restart/reopen proportional to the entire
JSONL.

Regression design: generate 100k lifecycle/page-tool rows, reopen the conversation after
clearing recorder memory, and record cold-start wall time/heap and map cardinalities. Exercise
old at-least-once replay after the proposed bound so it cannot silently duplicate a historical
row.

Minimal change: maintain a durable per-kind identity index, or retain only open turns plus a
bounded recent dedupe window while acknowledging that replays older than the window require a
disk lookup. Do not simply drop old IDs without changing retry semantics. Tests must cover
restart, old lifecycle retries, page-tool revisions, and Compact & Resume's intentionally
fresh B-side live maps.

### 12. P2 — several retry paths discard the retry fact before the durable operation succeeds

#### Origin stamping

Refs: `src/main/session/recorder.ts:348-387`.

`applyOrigin()` deletes `pendingOrigins` before `setSessionOrigin()` succeeds and catches the
write error. A transient metadata failure therefore loses the only copy of the worker/resume
origin; a later identical acknowledgement has nothing to apply.

Regression: make the first `meta.json` write reject, call `noteChatOrigin()`, restore the
writer, call it again, and require the origin/title. Minimal change: remove the pending entry
only after a successful durable stamp (while retaining the intentional removal when the
summary already has an authoritative origin).

#### Close lifecycle

Refs: `src/main/session/recorder.ts:1540-1556`; `src/main/bridge.ts:677-697`.

`closeConversation()` catches a failed `turn_end`, deletes the live mapping, ends the session,
and `/closed` still returns 200. The browser therefore removes its close request and has no
retry path for the missing terminal marker. Serialize `/closed` with `/events`; return a
durability failure or append an explicit gap that recovery can reconcile. Add an append-failure
bridge test.

#### Deterministic attribution repair

Refs: `src/main/session/recorder.ts:647-775,886-958`.

`repairDeterministicAttribution()` skips an Unattributed bucket if it contains any non-tool
event (for example `chat_error` or a gap), so exact request evidence never repairs the tool
calls in that mixed bucket. The rewrite helper itself writes only `session_start + tool_call`
and would drop other rows if called with such a bucket. The repair test matrix should include
mixed buckets and require unknown/non-tool events to remain intact while owned calls move
idempotently.

### 13. P2 — durable correlation/swarm/command snapshots can be silently lost on write failure

Refs: `src/main/durable.ts:54-94`; `src/main/session/correlation.ts:63-70,143-197,205-223`.

`flushOne()` removes a pending value before `writeFile`/`rename`; on error it only logs, so no
retry is scheduled. This affects broker queues, bridge commands, and the request-correlation
baseline. History reconciliation can recover some correlation entries, but pending agent
messages or browser commands have no equivalent source.

Regression: queue a durable snapshot, make the first write fail, flush, then restore the
writer and flush again; require the value to land without a second producer call. Minimal
change: retain/requeue the value on failure and serialize a retry/backoff; clear it only after
rename succeeds. Verify shutdown ordering in `src/main/index.ts:258-270`.

`restoreRequestCorrelations()` also sets `restored = true` before its asynchronous durable
read/history reconciliation. Concurrent callers can observe a not-yet-restored registry, and
a startup failure prevents a later retry. Use one shared restore promise and mark ready only
after success; clear it on failure. Finally, `trim()` evicts FIFO request ids without
refreshing entries on same-conversation evidence, so a very long-running request can be
evicted after 50,000 newer ids despite the no-TTL contract. Add a pinned-active-request or
defined LRU policy test before changing the cap.

### 14. P2 — asset limits are not durable and overflow text bypasses the per-session image cap

Refs: `src/main/session/recorder.ts:1168-1181`; `src/main/session/store.ts:1241-1293`.

`storeImage()` decodes the entire base64 string before checking its 8 MiB decoded limit, so an
oversized input can allocate large memory before rejection. Its 192 MiB per-session counter
is an in-memory `assetBytes` map and is not rebuilt after restart. `writeOverflowText()` calls
`writeAsset()` directly and does not update that counter at all. Repeated restarts or large
overflow outputs can therefore exceed the advertised session budget and fill disk; an event
append failure after asset creation also leaves an orphan asset.

Regression: feed an oversized base64 payload and measure allocation before rejection; write
assets up to the cap, clear recorder memory/restart, write more, and repeat with overflow text.
Assert one durable session-wide budget and no orphan growth after a failed event append.

Minimal change: enforce a durable per-session asset index/manifest in the central asset writer,
count both images and text, check encoded input size before decoding, and reserve/rollback
bytes around event commit. Verify image results, overflow args/results, canonical message
overflow, restart, and repair paths.

## Current fixes that were verified rather than reopened

- The current dirty `lastSeqOnDisk()` reads `MAX_LINE_BYTES * 2 + 2`, which is large enough for
  one legal predecessor plus one legal torn final line. The old 128 KiB finding must not be
  reapplied to this tree; retain the near-limit torn-tail regression and add the uncertain
  `appendFile` failure case from finding 2.
- `shared/chronology.ts` now carries the active turn anchor in one ordered pass, removing the
  prior O(n²) untagged-event scan. Keep the existing chronology parity tests and add a large
  mixed-turn fixture; the remaining large-history risk is full-file readers and bridge
  serialization, not that specific nested scan.
- `readRecentEvents()` bounds the default IPC/MCP tail scan, but it is not a drop-in fix for
  `/activity`: the browser needs canonical revision/origin, user-anchor, and explicit cursor-gap
  semantics.
- Authored message time is only preferred when the bridge carries `authoredTime: true`, and
  canonical revisions preserve `origin`; this is the correct producer/consumer direction.
  The missing `StoredHistory` type fields and the cross-lineage target/ID tests above should be
  fixed before treating the feature as shipped.

## Suggested verification order

1. Fix the `StoredHistory` type blocker and run `tsc --noEmit` (also resolve the separately
   reported `ipc.ts:310` error before calling the tree green).
2. Add deterministic uncertain-append, concurrent `ensureOpen`, metadata-generation, and
   concurrent observation tests; run `session.test.ts`, `bridge.test.ts`,
   `continuation.test.ts`, and `correlation.test.ts`.
3. Add agent delivery/outbox tests and mixed attribution-repair tests.
4. Run large-history `/activity` and cold-restore probes with bounded response/gap assertions.
5. Run the full verification/build/package checks once the dirty-tree type and test baseline
   is restored.

