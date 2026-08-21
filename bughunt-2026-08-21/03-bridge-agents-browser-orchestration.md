# Browser bridge and multi-agent orchestration audit

**Date:** 2026-08-21 (Europe/Berlin)  
**Repository:** `C:\Users\totec\chatgpt-local-files`  
**Scope:** `src/main/bridge.ts`, `src/main/agents.ts`, `src/main/agent-secrets.ts`,
`extension/background.js`, `extension/content.js`, the bridge/agent tests, and the durable
state helpers they call.  
**Boundary:** source and existing artifacts were read-only. The only repository write from this
pass is this report. No product/test code, AppData, configuration, build output, or commit was
changed.

## Method and evidence

I read `AGENTS.md` completely and then read
`bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` completely before tracing the
current dirty tree. The parent audit explicitly said the existing tests are green and asked for
architecture/concurrency review rather than routine test work, so no test, build, install, or
live Chrome run was performed. The findings below are source-confirmed orderings; any dependence
on ChatGPT or Chrome deciding to continue a turn is labelled as a live-platform hypothesis.

The principal read-only probes were run from the repository root:

```text
rg -n "settled|async function ackCommand|queue\(|commands/ack|commands/redeem" extension/background.js src/main/bridge.ts test/bridge.test.ts test/extension.test.ts
```

Relevant results: `background.js:649-681`, `src/main/bridge.ts:1125-1139,1420-1448`, and
`test/bridge.test.ts:1412-1445`. The extension test at `test/extension.test.ts:808-823` only
checks that worker ACKs are not placed in `settled` and that a successful resume ACK is; it does
not cover an ACK rejected by the app or a same-id supersession.

```text
rg -n "setInterval|sweepStaleSwarm|durableQuiescence|readEvents\(" src/main/bridge.ts src/main/session/store.ts
```

Relevant results: `bridge.ts:1206-1214,1229-1285,1357-1360` and `store.ts:642-710`. The stale
sweep calls an unlimited `readEvents()` scan; the bounded `readRecentEvents()` path is not used
there.

```text
rg -n "onSpawnRequest|spawnRequest|stopBridge|queueWorkerBootstrap|restoreSwarm|restoreCommands" src/main/agents.ts src/main/bridge.ts src/main/index.ts
```

Relevant results: `agents.ts:177,241-248,528,1323-1366`, `bridge.ts:1335-1356,1374-1397,
1613-1616,2000-2030`, and `index.ts:194-196,264-276`.

I also used bounded `Get-Content` line-range reads for each cited region and read the durable
reader (`src/main/durable.ts:40-51`). Existing test files and the dirty-tree status were read
without altering them.

## Findings (current tree)

### F1 — HIGH — resume command ids are blacklisted before ACK acceptance, so a valid replacement can become unredeemable

**Status:** SOURCE-CONFIRMED. The ordering is deterministic; no live browser behavior is needed
to reach the bad state.

`extension/background.js` treats a resume command id as delivered before the app has accepted
the delivery:

- `redeemCommand()` returns `{ command: null }` whenever `settled.includes(id)` at
  `background.js:649-659`.
- `ackCommand()` pushes a resume id and awaits `persistLive()` at `background.js:662-670`, then
  calls `/commands/ack` at `background.js:671-681`. The response is not used to undo the
  blacklist. `content.js` likewise awaits but ignores the result of the sent ACK at
  `content.js:4839-4849`.
- `bridge.ts::queue()` deliberately reuses one id for a session and resets its owner/lease when
  a newer brief supersedes it (`bridge.ts:1420-1448`). The app correctly rejects the old page's
  later ACK with 409 (`bridge.ts:1125-1139`), which is the ordering covered by
  `test/bridge.test.ts:1412-1445`.

Adversarial ordering:

1. Resume command `C` is redeemed by old document `D1`.
2. The same session is compacted again; the app keeps id `C` but replaces its token/brief and
   clears the old owner.
3. `D1` sends its delayed `sent` ACK, or its ACK reaches a temporary network/app failure.
   The service worker first adds `C` to `settled`, then receives 409/404 or no response.
4. The newly opened document `D2` asks to redeem `C`; `settled.includes(C)` makes the worker
   return no command without contacting the app. The newer command then reaches the app's
   90-second deadline (`bridge.ts:1711-1738`) and `drop()` aborts the continuation
   (`bridge.ts:1814-1828`).

The same bookkeeping also has a smaller resource defect: `settled` is appended in memory at
`background.js:668`, while persistence writes only `settled.slice(-40)` at `background.js:175-183`;
the live array is never truncated, so `includes()` and memory use grow with every successful
resume in a long-lived worker.

**Impact:** an old page can have already typed the old brief while the intended newer resume is
silently refused. A failed ACK has no retry/outbox, and the user eventually sees an aborted
handoff rather than a recoverable browser delivery error. This is separate from the known
2026-08-20 late-ACK-after-deadline finding: here the command is still valid in the app, but the
extension has prematurely blacklisted its reused id.

**Fix direction:** carry a command generation/client through the extension bookkeeping; only add
the id to `settled` after an accepted app ACK, and retain a bounded retryable ACK record when the
response is 409/5xx/transport-failed. Propagate the structured ACK result to `content.js`. Bound
the in-memory set as well as its persisted projection.

**Confidence:** HIGH for the state ordering and source gap. The exact frequency of the old-page
race is platform/timing dependent and was not claimed as a live reproduction.

### F2 — HIGH — ending or clearing a swarm drops the broker identity but does not stop already-open worker chats

**Status:** SOURCE-CONFIRMED missing cancellation signal; whether a particular ChatGPT turn
continues far enough to issue another tool call is a LIVE-PLATFORM HYPOTHESIS.

The broker computes exactly the information needed to retire open worker chats, then drops it:

- `endRun()` collects bound, nonterminal workers as `retired` at `agents.ts:394-399`, sets the
  global run to `null` and clears secrets at `agents.ts:400-404`.
- The listener contract carries `retired` (`agents.ts:210-212`), but the bridge registers a
  callback that accepts only `reason` and calls `cancelWorkerCommands(reason)` at
  `bridge.ts:1349-1356`.
- `cancelWorkerCommands()` only removes queued worker commands (`bridge.ts:1967-1981`). It does
  not act on any worker whose bootstrap was already redeemed, typed, or bound.
- The bridge comment explicitly says the opened workers are not typed into because that would be
  a second control channel (`bridge.ts:1350-1354`), but there is no stop/retirement message to
  the already-running document. `resetSwarm()` calls this path for a user clear
  (`agents.ts:1230-1233`); the prime-close path also ends the run via `/closed`
  (`bridge.ts:697-716`).

Thus a worker can be in the middle of a ChatGPT generation when the user clears the swarm, the
prime tab closes, or the app ends the run. The app no longer has a worker identity for that tab,
and no browser-side stop/retirement event is sent. The tab may continue its current generation
until it next calls the connector and learns that the run is gone. Core activity already in
flight is not rolled back, and the absence of a run is not itself a browser cancellation.

**Impact:** “Clear swarm” and prime closure do not provide a hard boundary for unwanted worker
activity. A worker that continues can finish in an orphaned/unattributed context, attempt local
work after the prime has stopped consuming results, or keep a ChatGPT tab active while the UI
reports no run. This is not a re-report of the 2026-08-20 attribution-outage/stale-worker
cascade; it is the missing end-of-run control plane after the run is deliberately ended.

**Fix direction:** use the `retired` list to publish a document/conversation-scoped retirement
signal, or gate worker-originated MCP mutations on a run generation that is invalidated by
`endRun()`. The browser path must fail closed for retired worker calls while preserving explicit
user-visible recovery. Do not silently type a stop prompt into an arbitrary tab.

**Confidence:** HIGH for the missing signal and ignored `retired` list; MEDIUM for the amount of
post-clear model work, which needs a live ChatGPT run to measure.

### F3 — MEDIUM/HIGH — stale-swarm cleanup has an unbounded full-log scan and no sweep singleflight

**Status:** SOURCE-CONFIRMED performance/resource risk. No file-size threshold was measured on a
live install.

The orphan sweep runs every 30 seconds (`bridge.ts:1357-1360`) but has no “sweep already in
flight” flag. Its proof path performs an unlimited event-log read:

- `durableQuiescence()` calls `readEvents(summary.id, { kinds: ['turn_start', 'turn_end'] })`
  without `limit` at `bridge.ts:1206-1215`.
- `readEvents()` defaults `limit` to `Number.MAX_SAFE_INTEGER`, reads the entire
  `events.jsonl`, splits it into lines, parses every line, and sorts the result
  (`store.ts:642-710`). The recent bounded reader at `store.ts:721-815` is not used by the sweep.
- The sweep can do this once for each bound worker (`bridge.ts:1239-1260`) and then again for the
  prime and every worker in its orphan fallback (`bridge.ts:1273-1281`). Its top guard only checks
  MCP/observation counters (`bridge.ts:1229-1231`), not another sweep that is already reading.

On a long-lived worker session, an idle sweep can therefore materialise the whole durable log on
the main-process heap every 30 seconds. If one scan takes longer than that interval, the next
timer starts another scan while the first is still pending. The synchronous split/JSON parse and
chronology work can delay bridge requests, ACKs, renderer IPC, and command deadlines; overlapping
scans multiply the cost. `finishWorkerConversation()` and `failAgent()` are idempotent
(`agents.ts:933-950`), which limits duplicate terminal reports, but does not prevent the I/O/CPU
amplification.

**Impact:** the liveness safety net can become a main-process resource sink precisely when it is
trying to recover an abandoned swarm. A large event journal can starve the browser bridge and
make otherwise healthy command/observation traffic look hung. This is distinct from the known
`/activity` full-history freeze: `/activity` now uses a bounded recent window, while stale cleanup
still calls the unbounded reader.

**Fix direction:** keep bounded durable turn-boundary projections/cursors for orphan proof, or
scan a capped tail with an explicit “insufficient proof” result. Add a stale-sweep singleflight
guard and a per-run/per-worker work budget; never start a second full scan while the first is
pending.

**Confidence:** HIGH for unbounded reads and missing singleflight; the wall-clock impact is
machine- and journal-size-dependent.

### F4 — MEDIUM/HIGH — the bridge leaves the global spawn listener installed after stop

**Status:** SOURCE-CONFIRMED lifecycle ownership gap; the shutdown race requires an in-flight
spawn or a direct bridge restart.

`agents.ts` owns one process-global callback (`spawnRequest` at `agents.ts:177`).
`onSpawnRequest()` replaces it but offers no disposer or clear operation (`agents.ts:241-248`),
and `spawn()` calls it whenever workers are owed (`agents.ts:491-492,528`). The bridge installs a
callback during `startBridgeOnce()` (`bridge.ts:1335-1338`) but `stopBridge()` only nulls the
server/port, clears command timers, and removes the swarm-end listener
(`bridge.ts:1374-1397`). There is no corresponding `onSpawnRequest(null)` or generation check;
the only `spawnRequest = null` assignment is the test reset at `agents.ts:1369-1374`.

The stale callback still calls `queueWorkerBootstrap()`, which immediately calls `deliver()`
(`bridge.ts:1613-1616`). `deliver()` checks only whether `openInBrowser` exists
(`bridge.ts:1679-1701`), not whether this bridge generation is live. The opener is process-global
and wired to `shell.openExternal()` (`index.ts:194-196`). Therefore an in-flight `agents spawn`
can arrive after `stopBridge()` has begun/finished and still open a fresh ChatGPT URL while the
the HTTP listener is down; `stopBridge()` clears command timers but does not discard the command
queue.

The ordinary settings path mitigates the common “multi-agent off” case by calling `resetSwarm()`
before `stopBridge()` (`ipc.ts:162-173`). It does not close the concurrent shutdown/restart hole,
and it does not protect a direct lifecycle caller from a callback that outlives its owner.

**Impact:** a browser tab can be opened during app shutdown or a bridge restart even though no
active listener can redeem it. On restart, persisted worker commands may be replayed again, so
the user can see an unexplained fresh tab or a bootstrap that cannot join.

**Fix direction:** make `onSpawnRequest()` return a disposer or add an explicit generation/clear
operation; unregister it before closing the listener and gate queue/delivery on the active bridge
generation. During shutdown, stop accepting new agent spawns, end/cancel the run deliberately,
and resolve or fail outstanding commands before the opener is allowed to run.

**Confidence:** HIGH for the ownership gap; the exact tab-open timing is a concurrent shutdown
ordering, not a claimed always-on behavior.

### F5 — MEDIUM — durable swarm and command restores trust shape/size that runtime creation rejects

**Status:** SOURCE-CONFIRMED validation gap. This concerns locally corrupted or manually altered
durable state, not an ordinary model input.

The durable reader only reads and JSON-parses an unrestricted file (`src/main/durable.ts:40-51`).
The two restore paths then shallow-cast most of the result instead of validating it:

- `restoreSwarm()` checks only version, a nonempty prime id, each entry's truthy `info.id`, and
  presence of a `prime` map key (`agents.ts:1323-1347`). It spreads arbitrary `info` fields and
  every queue item, resets only `offeredAt`, then installs the run (`agents.ts:1330-1355`). It
  does not validate role/state unions, conversation-id format, timestamps, message shape/text,
  duplicate ids, queue bounds, or that the prime entry is actually a prime. Runtime `spawn()`
  enforces task/label limits (`agents.ts:434-448`), but restore bypasses those checks.
- `restoreCommands()` accepts any version-1 array and restores every nonexpired worker entry
  with a string id (`bridge.ts:2000-2024`). It does not enforce `MAX_COMMANDS`, finite/ranged
  timestamps, unique ids/specs, the worker-id format, or the task length/shape limits applied by
  normal spawn. It then makes restored commands eligible for automatic delivery on bridge start
  (`bridge.ts:1330-1364`).

A valid-but-malformed JSON state file can consequently create duplicate/invalid agent map state,
large unacknowledged queues, or a restored worker bootstrap with an oversized/invalid task. A
large state file also makes startup parse and allocation unbounded. A torn/non-JSON file is safely
discarded by `readDurable()`, but syntactically valid corruption is not quarantined or repaired.

**Impact:** restart can poison attribution/liveness lookups, strand workers, exceed the intended
queue/command caps, or automatically type stale/corrupt worker text into ChatGPT. This is a
durable-state integrity issue, not permission bypass: the file is local app state, but it is an
authority for which browser work may be opened.

**Fix direction:** validate a bounded schema before installing any state (finite timestamps,
strict ids/roles/states, bounded strings/queues/commands, unique keys, and a valid prime), reject
the entire snapshot on any invariant failure, quarantine it with a redacted diagnostic, and
start with no browser delivery. Apply the same runtime bounds to restored commands before
`deliver()` can open a tab.

**Confidence:** HIGH for the missing validation and bound bypass; the concrete malformed-file
impact should be confirmed with a temp-only durable-state probe if implementation work is later
authorized.

## Checks that did not become new findings

- **Bridge request/body bounds:** `readBody()` consumes and rejects over-2 MiB bodies at
  `bridge.ts:360-389`, and the server sets 15-second header/30-second request deadlines at
  `bridge.ts:1307-1315`. No content-length-only regression was found.
- **Concurrent starts and worker bursts:** `startBridge()` single-flights through
  `bridgeStarting` (`bridge.ts:1296-1304`), and `nextDeliverable()` permits only one leased
  command (`bridge.ts:1860-1874`). Spawn input still validates task/label lengths and configured
  worker count (`agents.ts:434-448,498-512`). These controls are why F4 is about the stale
  listener after stop, not parallel worker delivery.
- **Insert/focus:** the current content path does an exact whitespace-normalized composer check
  immediately before `send()` (`content.js:4814-4832`). The remaining foreground-focus cascade
  is the retained 2026-08-20 A14 finding and is not repeated here.
- **Recovery keys:** `agent-secrets.ts` keeps only in-memory registered values, clears them when
  a run ends, and scrubs nested recorded values with a depth bound (`agent-secrets.ts:24-76`).
  I found no new plaintext-key persistence issue; F5 concerns the unvalidated non-secret state
  surrounding those keys.

## Coverage and deduplication notes

I did not re-promote the consolidated 2026-08-20 A1-A4 attribution/Fiber and stale-worker
cascade, A9 lifecycle replay, A11 recording order, A12-A13 Overwrite, or A14 focus theft. The
current source also retains the previously noted fixes/narrowings for concurrent bridge start,
document tombstones, provisional cleanup, and explicit page gap markers. The sibling extension
performance issues of missing authenticated-request deadlines, missing journal retry, SPA
navigation epochs, pair/unpair generation, and Fiber repair backoff are intentionally not
duplicated here; this report covers the bridge/agent ownership and cross-lifecycle edges that
remain after those observations.

No claim here proves an outbound ChatGPT prompt, a Chrome timer throttle, or a particular live
model continuation. Such effects require a platform probe; the report identifies the local
state/control paths that make them possible and the safe boundaries that are currently absent.
