# Luna session-store audit (read-only)

Scope: `src/main/session/store.ts`, `src/main/session/recorder.ts`,
`src/shared/chronology.ts`, `src/main/bridge.ts`, and `src/renderer/chat.ts`, plus
read-only inspection of recent `%APPDATA%\chatgpt-local-files\sessions` histories.
No production, test, or AppData files were changed. Findings are based on the current
dirty tree and the consolidated bughunt report.

## Ranked findings

### 1. MEDIUM/HIGH — restart can reuse sequence numbers after a large torn final line (OPEN)

Refs: `src/main/session/store.ts:240-274,326-342`; the per-line ceiling is
`MAX_LINE_BYTES = 512 * 1024` at `:56-59`.

`ensureOpen()` calls `lastSeqOnDisk()`, but that recovery reads only the last 128 KiB
(`lastSeqOnDisk(): :246-247`). If the final JSONL line is torn, or is a valid large
line, and its size exceeds 128 KiB, the preceding newline/valid event may be outside
the scan. The loop then returns `0`; `ensureOpen()` chooses `nextSeq = 1`, while
`sealTornTail()` merely appends a newline before the new event. The next append can
therefore duplicate an existing sequence (or append `seq:1` after a long malformed
line). Incremental `/activity` cursors and chronology assume strictly increasing,
gap-free `seq`, so a crash can cause replay, omission, or cursor non-advancement.

Smallest robust fix: recover the last valid sequence by scanning backwards in bounded
chunks until a newline and valid JSON event are found, but allow at least
`MAX_LINE_BYTES` plus a small framing margin; alternatively persist a durable next-seq
sidecar atomically with the journal. Add a fixture with a 200 KiB final torn line and
assert the next append is greater than the prior valid sequence.

### 2. MEDIUM — bounded recent-tail reads can return an incomplete/empty UI window (OPEN, deliberate tradeoff)

Refs: `src/main/session/store.ts:793-888`; `MAX_RECENT_READ_BYTES = 8 MiB` at `:119`,
and `src/main/ipc.ts:295-313` routes the default UI history request here.

`readRecentEvents()` stops after 8 MiB scanned, even if fewer than `limit` matching
events were found. A session with a large recent run of filtered/non-renderable events
(or a long series of malformed lines) can consequently return fewer rows, including an
empty default tail despite older valid transcript activity. This is safe and bounded,
but the UI has no `truncated`/`hasMore` signal and users cannot distinguish an actually
empty tail from a budget-limited history. Smallest fix: return a bounded-result marker
to the IPC/UI (or continue scanning until one complete matching window is found, with a
separate hard CPU/byte cap and visible degraded state).

### 3. MEDIUM — full-history maintenance paths remain linear in the entire JSONL (FIXED FOR DEFAULT UI; OPEN FOR MAINTENANCE)

Refs: `src/main/session/store.ts:714-790`, `src/main/session/recorder.ts:419-420,
:667-674, :734-737`, and `src/main/session/correlation.ts:180-193`.

The new tail path prevents the default UI `limit` request from reading a 40 MiB journal,
and `shared/chronology.ts:84-117` removes the prior O(n²) untagged-event scan. However,
correlation restore, deterministic Unattributed repair, stored-history reopen, and
target-call de-duplication still call unbounded `readEvents()` and repeatedly parse full
histories (repair also rereads each destination's full tool-call history). This is
correctness-preserving but remains an app-start/repair latency risk for multi-million
event sessions. Smallest robust fix: maintain/rebuild a durable per-session tool-call
index and lifecycle/page-tool projection, or stream JSONL once per operation instead of
materialising and sorting the whole file; retain full reads only for explicit export.

### 4. MEDIUM — canonical message key is only `(kind, messageId)` within one durable lineage (OPEN RISK)

Ref: `src/main/session/store.ts:183-185,593-682`; lineage is accumulated by
`rebindSession()` at `:1183-1212`.

The store correctly refuses text/timing guesses and upserts stable page identities. The
remaining invariant is producer-dependent: if ChatGPT ever reuses a message id across
two conversation frontends in one Compact & Resume lineage, the second message replaces
the first in `messages.json`. Current sampled histories did not show a collision, and
Fiber's assistant ids include working-turn/exchange/create-time where available, so this
is not a confirmed live bug. Preserve as an explicit regression risk: identity should be
namespaced by the ChatGPT conversation/lineage epoch if the upstream model can reuse ids,
or the producer must prove global uniqueness.

## Evidence from real sessions (private text omitted)

Read-only sample of recent sessions under `%APPDATA%\chatgpt-local-files\sessions`:

- `2026-08-20-bb122e68` (one lineage with two `chatIds`): 455 JSONL lines, all
  parseable, max sequence 901, 65 `page_tool`, 15 `turn_start`, 13 `turn_end`,
  319 tool calls, and 36 canonical messages (9 user / 27 assistant). Its lifecycle
  pairs were coherent; no duplicate sequence numbers were observed.
- `2026-08-19-9ddc2f5f` (one lineage with two `chatIds`): 587 lines, max sequence
  1257, all parseable, 11 starts/11 ends, 472 tool calls, and 35 canonical messages.
- `2026-08-20-831d7354` (Unattributed activity): 253 lines, all parseable, one
  session-start and 252 tool calls, with no canonical messages or lifecycle boundaries.
  This is consistent with the consolidated report's worker-5 attribution outage;
  deterministic late repair is present in `recorder.ts:648-774` and is idempotent by
  call id, but only runs when exact correlation evidence is available.
- The current tree's authored-time path is internally consistent: Fiber normalizes
  ChatGPT `create_time` seconds to epoch milliseconds in `extension/fiber.js:365-372`,
  content marks user observations `authoredTime:true` at `extension/content.js:1917-1931`,
  and the bridge preserves that flag in `src/main/bridge.ts:489-520`. The store only
  replaces chronology time when explicitly requested (`store.ts:644-651`). No sampled
  canonical message had a malformed timestamp or duplicate key.

## Areas checked and classification

- Authored vs observed time: FIXED in current dirty changes; authored message timestamps
  are normalized and explicitly preferred, while ordinary first observation remains the
  chronology anchor.
- Canonical message revisions: FIXED for stable producer ids; final assistant state is
  terminal and sparse revisions preserve richer HTML. Cross-epoch id reuse remains the
  risk above.
- Duplicate lifecycle replay: FIXED in current dirty changes via durable `knownTurnStarts`
  / `knownTurnEnds` (`recorder.ts:85-91,1401-1450`). Restart reconstruction reads the
  durable lifecycle ledger before accepting recovered final messages.
- Late attribution repair: FIXED for deterministic exact request-id evidence;
  `repairDeterministicAttribution()` splits by destination session and preserves unknown
  calls. It must remain fail-closed when a source asset is missing.
- Crash-truncated JSONL: PARTIALLY FIXED; malformed final lines are skipped/sealed by
  `store.ts:240-294`, but the large-line sequence-recovery defect above remains open.
- Reopen/end semantics: FIXED for normal close/reopen. `sessionForConversation()` reuses
  durable sessions and `reopenSession()` clears stale compaction edges
  (`recorder.ts:221-297`, `store.ts:1100-1129`). Compact & Resume persists A→B lineage
  before publishing the in-memory map (`store.ts:1183-1221`, `continuation.ts:389-401`).
- Huge history tail/search cost: default UI tail and chronology are FIXED; unbounded
  repair/correlation/reopen scans remain open as noted above.
- Async renderer generation guards: FIXED in current dirty changes. Session, detail, and
  handoff loads use independent generations and selected-id checks (`renderer/chat.ts:
  215-285`), preventing stale A results from painting after B is selected.

## Bottom line

The sampled real histories are structurally healthy and show the intended split between
append-only activity and canonical messages. The highest-value remaining session-store
defect is crash recovery of sequence numbers: the recovery probe's read window is smaller
than the store's legal event-line bound. Fix that before relying on cursor-based replay
after crashes. Then add a bounded/indexed maintenance reader so retrospective phone-authored
chats and late attribution repair cannot turn app restart or repair into a full-history
main-process pause.
