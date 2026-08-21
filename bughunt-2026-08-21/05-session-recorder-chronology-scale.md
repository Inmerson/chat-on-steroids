# Session recorder, chronology, and long-history scale audit

Date: 2026-08-21  
Scope: `src/main/session/*`, `src/shared/chronology.ts`, session IPC/history inputs, and
Compact & Resume. This is a source/architecture audit of the current working tree. I read
`AGENTS.md` and the complete 2026-08-20 consolidated bughunt before inspecting these paths.
No source or test files were changed; routine green-suite validation was intentionally skipped
per the parent task. The only requested write is this report.

The prior report's scale datum remains useful as a baseline: its retained probe created
250,000 valid progress events in a roughly 40.0 MB journal and a `limit:1` history request
took 68,305 ms with an 83.6 MiB heap increase (`bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md:343-356`).
The current default IPC tail path and the linear chronology pass address that exact default
request. The findings below are separate failure modes that still exist in the current code.

## Findings

### SR-1 — HIGH — Compact & Resume has no restartable transaction authority

**Trigger.** Start Compact & Resume, capture the handoff, and let the app terminate before the
replacement chat redeems/acks its queued command. The same problem occurs if the process dies
after the durable rebind but before the in-memory publish.

**Evidence.** The continuation authority is process memory only: `byToken` is a module-level
`Map` (`src/main/session/continuation.ts:126-127`), and `openContinuation()` places the token
there (`:196-219`). The bridge persists a resume command containing the token
(`src/main/bridge.ts:1405-1417`, `:1620-1632`), but on restart `restoreCommands()` explicitly
restores worker bootstraps only and discards resume commands because their continuation is
considered memory-only (`src/main/bridge.ts:1993-2011`). Startup has no continuation restore
step (`src/main/index.ts:171-181`; it restores correlations, not continuation state).

The durable phase itself is intentionally the first fallible step
(`src/main/session/continuation.ts:361-400`): after `rebindSession()` succeeds at `:388-390`,
the process can die before `rebindConversation()` and the remaining publication at `:400-413`.
On the next run the disk projection can say chat B while the token, claimant, prime-transfer
lock, and conversation map are gone. If the crash happens earlier, the handoff file and queued
command remain but no claimant can redeem them.

**Impact.** A restart can strand the captured brief, leave the user in chat A with no usable
replacement, or leave a durable session attached to B without the in-memory recorder/workspace
binding. A user retry cannot reconstruct the one-time authority from the persisted command.
This is data/continuity loss, not merely a stale progress indicator.

**Confidence: High (source-proven).** The code comments state the intended restart behavior and
the resume-exclusion branch directly; no timing or external ChatGPT assumption is needed.

### SR-2 — HIGH — Durable projections are not rebuilt after a stale or corrupt crash

**Trigger.** Crash during the 1.5-second metadata debounce, truncate/corrupt `meta.json`, or
truncate/corrupt `messages.json`, then reopen the session or restart the app.

**Evidence.** Every append/revision marks metadata dirty and defers its rewrite for 1,500 ms
(`src/main/session/store.ts:192-206`). On reconstruction, `ensureOpen()` seals only a torn JSONL
tail, reads `meta.json` (or invents an empty “Recovered session” summary), reads the canonical
message map, and computes the next sequence; it never folds `events.jsonl` back into the summary
(`src/main/session/store.ts:350-379`). `readMeta()` catches every parse/read error and returns
`null` (`:881-905`), while `readAllSummaries()` simply omits that directory (`:916-937`).

The consequences are stronger than a stale counter: `findSessionByConversation()` searches
only those summaries (`src/main/session/store.ts:961-985`), and automatic compaction compares
the stored `contextTokens` projection to the threshold (`:424-428`). A crash before the meta
flush can therefore hide a real conversation from ownership lookup and suppress compaction.
Corrupt/missing metadata makes the old folder disappear from the session list; a later page
can create a second session for the same ChatGPT conversation.

Canonical message recovery is also lossy. `readCanonicalMessages()` reads and parses one whole
`messages.json`; on any non-ENOENT read/parse problem it logs and returns an empty map while
claiming that a legacy event log remains available (`src/main/session/store.ts:316-337`). Current
streaming user/assistant snapshots are written only to that canonical file, not appended to
`events.jsonl`, so the current transcript has no journal fallback. Atomic rename protects each
individual file, but it does not make the independently updated `meta.json`, `messages.json`,
and JSONL projection recoverable as one transaction.

**Impact.** Restart can show stale event/token counts, miss a conversation entirely, fail to
trigger auto-compaction, fork a session, or silently lose current user/assistant transcript
content after canonical-file corruption. The `meta.json` parser also validates only `id` and
fills defaults (`:884-900`), so malformed numeric projection fields can survive as bad state
instead of forcing a journal rebuild.

**Confidence: High (source-proven).** The missing replay path and the empty-on-error behavior
are explicit. This is distinct from A6: current `/activity` now reopens a live conversation and
uses a bounded tail, but that does not repair the summary or canonical transcript projection.

### SR-3 — HIGH — Canonical message updates rewrite the entire map and then hard-fail at 32 MiB

**Trigger.** A long chat accumulates many stable user/assistant messages, or one assistant
message streams through many revisions after the map is already large.

**Evidence.** Each changed message clones the complete `entry.messages` map, inserts one
revision, serializes every message, and rewrites `messages.json` before publishing the new map
(`src/main/session/store.ts:524-622`, especially `:597-600`). `writeCanonicalMessages()` performs
whole-object `JSON.stringify()` and a whole-file write/rename on every update, then throws once
the serialized snapshot exceeds 32 MiB (`:339-347`). There is no journaled message revision,
rollover, or compact index.

The recorder permits up to 256,000 characters for both user handoff messages and assistant
messages (`src/main/session/recorder.ts:1371-1399`; assistant cap at `:1392`). As a source-derived
scale bound, roughly 128 maximum-sized message snapshots already approach 32 MiB before JSON
escaping, keys, and metadata overhead; real conversations can hit the cap with fewer messages.
Every streaming revision still pays O(number of messages) serialization and temporarily holds
the cloned map plus the serialized string in the Electron main process.

When the cap is reached, the write rejects before `entry.messages` advances
(`store.ts:597-603`); the observation chain logs/propagates the failed update and later retries
cannot make a >32 MiB snapshot succeed. The page may continue, but durable canonical history
stops accepting new/revised transcript rows. A malformed/oversized on-disk file is also read in
one `readFile()`/`JSON.parse()` operation (`:317-322`) with no read-side size ceiling.

**Impact.** Main-process CPU/heap and disk write amplification grow with transcript size and
streaming frequency; at the hard limit, ongoing message persistence fails and the durable source
of truth is incomplete. This is separate from M1's old JSONL chronology freeze: it affects the
canonical message writer even when the UI requests only a tail.

**Confidence: High (source-proven).** The O(M) clone/serialize/write and the exact 32 MiB throw
are unconditional on every changed canonical message.

### SR-4 — HIGH/MEDIUM — Session asset limits reset on restart and do not cover overflow text

**Trigger.** Record unique screenshots/images or large tool/user/assistant text over multiple
app lifetimes, especially in one long-lived session.

**Evidence.** The intended per-session image ceiling is 192 MiB and each image is capped at
8 MiB (`src/main/session/recorder.ts:67-70`). The accounting is only an in-memory
`Map<string, number>` (`:107-123`); `storeImage()` consults and increments it
(`:1184-1197`), but there is no scan of the existing `assets/` directory when a session is
restored. `resetRecorderForTests()` demonstrates the lifetime boundary by clearing the map
(`:1663-1671`); a production restart has the same process-memory reset.

The other asset path is not included in that budget at all. `storeText()` spills every value
over its inline cap to `writeOverflowText()`, which accepts up to 8 MiB per text asset
(`src/main/session/recorder.ts:795-822`; `src/main/session/store.ts:1200-1215`). `writeAsset()`
only deduplicates byte-identical content and has no session aggregate quota
(`store.ts:1154-1187`). Handoffs likewise create a new JSON file per id with no per-session
retention (`:1224-1234`); old handoffs remain until the whole session is pruned.

**Measured/derived scale evidence.** Twenty-five unique 8 MiB overflow values are already
200 MiB, yet none increments `assetBytes`; after one restart another 192 MiB of unique images
is admitted because the image counter starts at zero. These are direct bounds from the current
constants, not a claim that a large artifact was created in the repository.

**Impact.** AppData can grow without a durable per-session limit, and active/recent sessions are
not eligible for pruning merely because their assets exceed the intended image budget. Large
asset reads/copies during history queries or attribution repair then add I/O and heap pressure.

**Confidence: High (source-proven).** The quota's process-local storage and the uncounted text
path are visible in separate call chains; no test behavior is required.

### SR-5 — HIGH/MEDIUM — Recovery/index windows and lifecycle scans silently omit history and amplify main-process work

**Trigger.** More than 5,000 session folders, a cold restart with a missing/corrupt correlation
snapshot, many legacy Unattributed buckets, or retention/late-attribution work concurrent with
normal recording.

**Evidence and scale boundary:**

* `readAllSummaries()` enumerates the whole root, reads `meta.json` sequentially, then sorts,
  but stops at `MAX_SCANNED_SESSIONS = 5,000` before sorting (`src/main/session/store.ts:60-63,
  :916-937`). The stop is based on arbitrary `readdir()` order, not oldest `updatedAt`. Every
  ownership lookup, `latestHandoff()`, pruning pass, and maintenance `listAllSessions()` uses
  this set (`:961-985`, `:1255-1263`, `:1275-1292`). At session 5,001 the omitted directory can
  contain the actual current/historical conversation or newest handoff, so a lookup can fork a
  duplicate session and pruning can preserve/remove the wrong history. `pruneSessions()` also
  performs a full summary scan and then calls `latestHandoff()`, which scans the root again
  (`:1278-1280`).
* Correlation recovery deliberately narrows the fallback further: after loading the snapshot it
  considers only the first 100 summaries, and only the newest 1,024 matching tool rows or
  512 KiB per session (`src/main/session/correlation.ts:189-227`). This is a useful startup cap,
  but if the snapshot is absent/corrupt and the still-needed request is in an older session or
  outside that byte/event window, the exact request-to-conversation proof is not rebuilt. The
  current always-reconcile behavior fixes A5's stale-nonempty-snapshot early return; this bounded
  cold-history omission is a different failure.
* Startup launches `repairDeterministicAttribution()` asynchronously, and each late evidence
  burst can schedule another serialized pass (`src/main/index.ts:231-236`; `src/main/session/recorder.ts:541-568`). A pass reads every eligible Unattributed JSONL in full
  (`:676-688`), copies every referenced asset (`:709-743`), and for every destination reads
  the complete target journal just to build duplicate call ids (`:745-753`). The raw reader
  materializes, parses, filters, and chronologizes the whole file (`src/main/session/store.ts:642-710`).
  This is a repeated main-process scan/heap/I/O cost distinct from the old user-facing M1 tail
  request, and it can coincide with foreground history/recording work.
* The session lifecycle has no deletion tombstone/barrier for an in-flight opener. `ensureOpen()`
  tracks reconstruction in `opening` and publishes it after asynchronous disk work
  (`src/main/session/store.ts:350-379`), while `deleteSession()` waits only the currently
  published entry queue and then removes the directory (`:1295-1304`). A late append can be
  waiting in `opening`, or can obtain the entry after the delete's queue wait; its subsequent
  `events.jsonl` write then races a removed parent and fails (or leaves a stale in-memory entry
  pointing at a deleted folder), losing that producer's event after the UI/pruner reported the
  delete. `pruneSessions()` uses the same raw `fs.rm()` path and only checks `open`, not
  `opening` (`:1281-1287`).

**Impact.** At scale, startup/maintenance repeatedly reads and sorts large histories, while
bounded recovery can leave exact ownership unresolved (Unattributed) or fork session lineage.
Concurrent deletion can lose an event or resurrect a half-session after the UI reports deletion.
The first two bullets are primarily correctness; the third and fourth are CPU/I/O and
concurrency amplification.

**Confidence: High for the 5,000 cap, repeated scans, and delete/open race; Medium/High for the
correlation omission (it depends on the snapshot being unavailable and the needed row falling
outside the deliberate recovery window).**

## Deduplication against the 2026-08-20 findings

* **M1:** The prior 250k-event full-file history freeze is retained as the baseline above. The
  current default `sessions:events` path calls bounded `readRecentEvents()`
  (`src/main/ipc.ts:296-314`), and `chronological()` is now a sort plus linear grouping pass
  (`src/shared/chronology.ts:46-118`), so this report does not refile the old O(n²) default-tail
  result. Explicit `from`/query/call-id history and the maintenance paths in SR-5 still use
  `readEvents()` and remain whole-journal operations.
* **A5:** Current correlation restore no longer returns early on a valid but stale snapshot;
  SR-5 is the newer bounded fallback window after that fix, not the stale-snapshot bug.
* **A6:** `restoreRecordedConversation()` and the bounded `/activity` tail are current fixes;
  SR-2 concerns durable summary/transcript recovery, not the live activity map.
* **A9/A11:** Current turn start/end sets and the observation/exact-call chains address the
  previously reported retry duplication and exact-call ordering/flush bypass. None of SR-1–SR-5
  relies on those old races.

## Commands/evidence used

Read-only source checks used PowerShell `Get-Content` with numbered ranges and `rg -n` over the
current files, including:

```text
Get-Content src/main/session/store.ts | Measure-Object
Get-Content src/main/session/recorder.ts | Measure-Object
rg -n "restoreCommands|restoreRequestCorrelations|readAllSummaries|repairDeterministicAttribution|pruneSessions" src/main
```

The source ranges cited above are from that current working tree. No repository-sized scale
artifact was generated, no product/AppData/config state was changed, and no commit was made.
