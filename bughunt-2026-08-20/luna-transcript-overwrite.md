# Luna transcript / Overwrite adversarial audit

Scope: current dirty tree on 2026-08-20, including the page queue overflow marker, serialized
service-worker journal writes, lifecycle dedupe, authored-time, app-restart `/activity`, and
Overwrite grace changes. This audit was read-only except for this report. No code or tests were
changed.

## Ranked findings

### 1. HIGH — terminal-tab tombstone is cleared before old-document IPC is impossible

Refs: `extension/background.js:672-695,936-955` (`terminalTabs`, `onRemoved`,
`tabs.onUpdated`), `:832-864` (`events`/`bind`/`activity`).

Reproducible ordering:

1. ChatGPT tab T is on conversation A; its content script has queued or started an async
   `events`/`bind` call.
2. T navigates to an external URL. `onUpdated` adds T to `terminalTabs` and starts async
   `releaseTab`, but the old document's already-dispatched message can still arrive later.
3. Before that message arrives, T navigates to ChatGPT conversation B. `onUpdated` immediately
   deletes T from `terminalTabs`.
4. The delayed A message is now accepted by `events`/`bind`; `noteTabConversation` can install A
   over B (and `bindProvisional` can attach pre-id A observations). A stale page can therefore
   resurrect ownership after the new document is live. The current tombstone only protects the
   interval while the tab is on the external URL; it has no navigation/document generation.

Impact: HIGH, user-visible and security-relevant transcript split. A's observations can be
written into B, `/activity` can point at the wrong conversation, and Overwrite may render the
wrong local stream. This is the same delayed-IPC race the change comments claim to close, but the
new `terminalTabs.delete(id)` reopens it on the next ChatGPT navigation.

Smallest robust correction: assign a monotonically increasing per-tab document/navigation epoch
from `tabs.onUpdated` (and terminal events), persist/pass that epoch in content-script messages,
and reject messages from an older epoch. At minimum keep a terminal generation tombstone and do
not clear it merely because a new ChatGPT URL appeared; static/content injection must explicitly
claim the new generation before it can write state. A tab id alone cannot establish ownership.

### 2. MEDIUM/HIGH — page-local overflow marker can itself be lost during an ambiguous flush

Refs: `extension/content.js:447-490,506-534`, especially `:515-518` deleting `queueGaps` before
the worker reply and `:529-534` retaining the batch when the reply is missing/non-durable.

Reproducible ordering:

1. Fill the page queue past 400 so an overflow `chat_error` marker is inserted and tracked in
   `queueGaps`/`queueGapKeys`.
2. `flush()` snapshots a batch containing that marker, then immediately deletes its tracking
   entry before `ask({type:'events'})` resolves.
3. Make the service-worker call ambiguous (runtime disconnect, extension restart race, or a
   reply without `durable`/`pending:0`) and emit enough new observations to overflow again.
4. The old marker is still in `queue`, but is no longer recognized as a marker. The overflow
   loop may evict it as an ordinary observation, while the new marker counts only later losses.
   If the old in-flight batch is subsequently retried, its loss evidence has already vanished;
   if the page dies first, the gap is definitely absent.

Impact: MEDIUM/HIGH, user-visible incompleteness. The transcript can silently omit the explicit
warning for the first page-local loss, defeating the purpose of the newest durability marker.

Smallest robust correction: retain an in-flight marker's ownership/key until the batch is
positively durable or accepted; have overflow skip all entries in the in-flight batch (or freeze
the marker object with an `inFlight` flag). On an ambiguous reply, keep the same marker and
coalesce later losses into it; only remove its tracking state when the exact object is removed
after a durable acknowledgement.

### 3. MEDIUM — authored chronology correction is applied to user messages only, not assistant snapshots

Refs: `extension/content.js:1934-1975` (assistant emits `time: message.createTime` but no
`authoredTime`), `extension/content.js:1915-1931` (user emits the flag),
`src/main/bridge.ts:486-509` (only copies `authoredTime`),
`src/main/session/recorder.ts:1335-1363`, and `src/main/session/store.ts:637-658`.

Reproducible ordering: open a retrospective/phone-created chat whose Fiber scan first exposes an
assistant message after the local DOM observation (or after reload), then expose the same stable
assistant message with ChatGPT's `createTime`. The assistant event reaches the bridge without
`authoredTime`, so `upsertMessageEvent(..., {preferTime:false})` preserves the first local
observation time forever. A user message in the same scan does take the authored-time path.

Impact: MEDIUM, user-visible ordering drift. Assistant prose can appear after later tool/turn
events or in the wrong place when chats are opened retrospectively/from another device; stable
message ids prevent duplication but do not repair chronology.

Smallest robust correction: mark assistant observations carrying Fiber `createTime` as
`authoredTime:true` and carry that bit through bridge validation. Ensure the assistant
`messagesReported` signature includes createTime (or otherwise permits a later stronger timestamp
to be emitted), so a first scan lacking createTime cannot permanently suppress the correction.

### 4. MEDIUM — lifecycle idempotency state advances before durable append succeeds

Refs: `src/main/session/recorder.ts:1401-1422,1431-1451`; durable write behavior is
`src/main/session/store.ts:555-583`.

Reproducible ordering: deliver a named `turn_start` (or `turn_end`) and force the following
`appendEvent` write to reject (disk full, transient permissions/IO failure). The recorder adds
the id to `knownTurnStarts`/`knownTurnEnds` before awaiting append. A service-worker retry with
the same at-least-once event is then skipped as a duplicate, although no durable lifecycle row
exists. `appendEvent` logs the failure but does not roll back those in-memory sets.

Impact: MEDIUM, user-visible and recovery-relevant. The session can show a turn end without its
start (or a start without an end), leave `activeTurnId` wrong, and make Overwrite/reload recovery
either native-fallback or retain a stale replacement indefinitely.

Smallest robust correction: stage the idempotency set update only after `appendEvent` resolves;
or remove the id on rejection and rehydrate it from the durable journal before acknowledging the
browser batch. The durable event, not the pre-commit memory mutation, must be the dedupe fact.

## False-fix / preserved-risk notes

- `restoreOpenChatgptTabs()` now reinjects MAIN-world `fiber.js` even when isolated `content.js`
  answers its ping (`extension/background.js:987-1012`); this closes the previously documented
  health blind spot, but it does not address the navigation epoch race above.
- `completeReplacementForTurn()` correctly fails closed when a descriptor has an unidentified
  call (`extension/content.js:3089-3122`), and `hasUnrepresentedFiberCall()` prevents the grace
  window from hiding a newly exposed request (`:3078-3087`). I found no separate false-positive
  overwrite suppression there in static review.
- Stable message-id upserts and final-state protection are sound for ordinary streaming
  snapshots (`src/main/session/store.ts:605-658`); the chronology issue above is specifically
  the missing authored-time propagation, not duplicate canonical rows.
