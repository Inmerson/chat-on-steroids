# Post-1.8.8 code review + live UNIDENTIFIED_CALLER root cause

Date: 2026-08-21 (afternoon pass)
Audited state: the **uncommitted 1.8.8 working tree** on `main` (base commit `f738875`), i.e. the V-01…V-19 fix implementations recorded in `FIXES-1.8.8.md`.
Scope: read-only review of the new 1.8.8 code (session store/recorder, bridge, MCP kernel, extension worker + content script, chronology), plus root-cause analysis of a live failure the user hit during this pass.
Method: source reading, cross-referencing producer/consumer pairs, and **on-disk forensic evidence** from the running app's own state directory.

## Evidence vocabulary

Same as `00-2026-08-21-CONSOLIDATED-VERIFIED-BUGHUNT.md`:

- **Proven** — demonstrated with artifacts from the live machine (on-disk state, built bundle contents, command output).
- **Source-confirmed** — the current control/data flow necessarily permits it.
- **Risk only** — plausible, needs targeted reproduction.

---

## Part 1 — The live incident (root-caused, and partly fixed during this pass)

### Symptom

`agents action=spawn` refused four times across two turns with
`UNIDENTIFIED_CALLER: this app could not prove which ChatGPT conversation this call came from`.
The extension popup simultaneously reported the *good* state: `Chat ID ✓`, `Request ID ✓`,
`Picked up ✓ 20`, `Sent to app ✓` — but `App processed ○`, with
*"Delivered. The app has not opened a session for this chat yet."*
The chat only appeared in the app after a manual page reload. All tool calls landed in
**Unattributed activity** first and were repaired into the right session minutes later.

### L-01 — The running app was 1.8.7; only the extension was 1.8.8 — **Proven** — *fixed in this pass*

The decisive fact. `src/main/version.ts` says `1.8.8`, but the **compiled** bundle the user was
actually running did not:

```
$ grep -o 'const APP_VERSION = "[^"]*"' out/main/index.js
const APP_VERSION = "1.8.7"          # built Aug 20 16:22
```

`release/win-unpacked/ChatGPT Local Files.exe` carries the same Aug 20 16:22 build. `FIXES-1.8.8.md`
records `npm run build` as *"environment-blocked"* — so the 1.8.8 main-process source had **never been
compiled**. The user was running **app 1.8.7 + extension 1.8.8**.

This alone explains the headline symptom. `restoreRecordedConversation()` — the function whose entire
job is to reattach a chat whose live session was lost, and whose absence produces exactly the popup
string *"the app has not opened a session for this chat yet"* — is **1.8.8-only** (`recorder.ts:211`,
called from `bridge.ts:757`). The 1.8.7 bridge the user was running returns `sessionId: null` and never
reattaches.

**Action taken:** `npm run build` was run and succeeded in ~1 s (the block was a Codex sandbox
limitation, not a source problem). `out/main/index.js` now reports `APP_VERSION = "1.8.8"`.
`npm run typecheck` passes.

> The claim in `FIXES-1.8.8.md` that the build is environment-blocked should be corrected — it builds
> fine here. That checklist item can be ticked.

### L-02 — `BRIDGE_PROTOCOL` was not bumped, so the new 426 gate cannot see this exact mismatch — **Proven**

V-18 added a hard protocol gate that returns HTTP 426 on every stateful bridge route
(`bridge.ts:638-640`). It compares `x-extension-protocol` against `BRIDGE_PROTOCOL`. But
`BRIDGE_PROTOCOL` is **still 5** in 1.8.8, and 1.8.7's extension already sent `5`
(`git show HEAD:extension/background.js:447`). Verified in the freshly built bundle:

```
const APP_VERSION = "1.8.8"
const BRIDGE_PROTOCOL = 5
```

So the gate built to turn "the extension does nothing" into "a diagnosable mismatch" is **inert for the
mismatch that actually happened**, while 1.8.8 changed the wire in ways an older peer cannot handle:

| 1.8.8 wire change | Consequence against a 1.8.7 peer |
| --- | --- |
| `/activity` gains `resetActivity` / `truncatedFrom` (V-08) | A 1.8.7 page ignores them and keeps merging from a cursor that predates the app's truncated window — stale/duplicated projection, silently. |
| `/commands/ack` returns 404 `no_such_command` when `client` is present (V-10) | Settlement semantics changed for every current page. |
| Observations gain `authoredTime` (drives `preferTime`) | 1.8.7 bridge drops it; message times stay DOM-first-sight. |
| `/activity` gains `retiredWorker` (V-11) | 1.8.7 never sends it; the page's retirement path is dead. |

**Fix:** bump `BRIDGE_PROTOCOL` to `6` and add the 1.8.8 changes to its changelog comment. Without it,
the 426 gate is decoration. (Deliberately *not* done in this pass — it is a release decision, and
bumping it will 426-reject every currently-loaded 1.8.7 extension until the user reloads it.)

### L-03 — Request-id evidence systematically arrives after the 15 s identity window — **Proven**

This is the part that survives the version mismatch and will still bite on a matched 1.8.8 pair.

Forensic evidence from the live correlation registry
(`%APPDATA%/chatgpt-local-files/state/request-correlations.json`, 95 entries, written 07:03):

```
--- entries for conversation 6a87dac1* ("Launch Subagent Request") ---
2026-08-21T05:00:43.378Z  1708697e  agents  session 2026-08-21-fa0c9fce
2026-08-21T05:03:13.138Z  4a431852  agents  session 2026-08-21-fa0c9fce
```

Against the app's own timeline (local = UTC+2):

| Event | Local time | Request-id evidence |
| --- | --- | --- |
| `agents` refused #1 | 06:58:24 | — |
| `agents` refused #2 | 06:58:44 | arrived **07:00:43** (≈2 min late, and only because the user reloaded the page) |
| `agents` refused #3 | 07:02:33 | — |
| `agents` refused #4 | 07:02:53 | arrived **07:03:13** (20 s late — exactly the "Turn completed" row) |

Two facts fall straight out:

1. **Four refused calls produced only two correlation entries.** Evidence for half of them never
   arrived at all.
2. The evidence that did arrive landed at **turn completion**, not at call time. `IDENTITY_EVIDENCE_MS`
   is 15 s (`kernel.ts:780`); every one of these missed it.

The mechanism, from source:

- `agents spawn` resolves its caller through `callerNow(startedAt, { exact: true })`
  (`tools-core.ts:1013`), which waits up to `IDENTITY_EVIDENCE_MS` for the page to report the matching
  request id, then gives up and `spawn()` throws `UNIDENTIFIED_CALLER` (`agents.ts:496`).
- The page can only report a request id when `refreshFiber()` runs and finds it in ChatGPT's message
  model. `refreshFiber()` is called on a 1 Hz tick **only while `generating` is true**
  (`content.js:1386-1388`), on connector-row DOM mutations (`content.js:1544`), and once at turn end
  (`content.js:1209`).
- **Once `generating` goes false there is no further Fiber read at all.** If ChatGPT materialises the
  connector `request_id` even slightly after that single turn-end read, the evidence is never emitted
  until an unrelated future event — the next turn's 1 Hz scan, a connector-row mutation, or a reload.

That is precisely the observed 20 s / 2 min split, and precisely the user's description: *"they somehow
found their place without reloading shortly after but too late obv."*

The deeper structural problem: **`spawn` is the one call that cannot tolerate eventual attribution.**
Ordinary reads never wait (`needsWorkspaceIdentity` gates the kernel's wait, and it only fires when
`swarmRunning()` — `kernel.ts:393`). But `spawn` is the call that *creates* the run, so
`swarmRunning()` is false and the kernel contributes no wait; the whole burden sits on `callerNow`'s
15 s. Meanwhile the deterministic repair pass fixes attribution minutes later — useful for the
transcript, useless for the call that already failed.

**Suggested fixes, in order of value:**

1. **Keep reading Fiber for a bounded window after `generating` goes false** — e.g. 1 Hz for ~30 s, or
   until the newest turn's calls are all `answered`. This is the single highest-value change: it turns
   "never, until you reload" into "within a second or two". Cheap, because it only runs on a page that
   just finished a turn.
2. **Let `spawn` wait longer than an ordinary identity-sensitive call.** It happens once per run and
   the user is already waiting on it; `IDENTITY_EVIDENCE_MS` (15 s) is tuned for repeated worker calls.
   A dedicated `SPAWN_EVIDENCE_MS` of 30–45 s costs nothing on the success path (the wait is
   event-driven and ends the instant the mate lands) and only ever delays a call that was going to be
   refused anyway.
3. **Make the refusal recoverable rather than terminal.** Today `spawn` refuses and the model must be
   told to retry by hand. Since the evidence reliably arrives *later*, the app could hold the spawn
   intent briefly and complete it when its request id resolves.

---

## Part 2 — Bugs found by reading the new 1.8.8 code

### B-01 — HTTP 426 makes the extension **permanently destroy** queued observations — **Source-confirmed** — *high*

`extension/background.js:508` (`drain`):

```js
if (result.status >= 400 && result.status < 500 && ![401, 408, 409, 429].includes(result.status)) {
  const rejected = mine[0];
  journal = journal.filter((entry) => entry !== rejected);   // dropped forever
  // ...replaced with a gap entry
}
```

426 falls straight through that filter. So the moment the app and extension disagree on protocol —
the exact situation V-18 introduced 426 to *signal* — the extension does not pause and wait for the
user to reload it. It **deletes the journal one entry per drain iteration** (up to 20 per pass, then
every retry-alarm minute), replacing real transcript with gap markers.

It is worse than it looks, because the extension can 426 itself without ever contacting the app:

```js
// background.js:656
if (found.compatible === false) return { ok: false, status: 426, error: 'incompatible_extension' };
```

`found.compatible` is the **cached** `portCompatible`, trusted for `PORT_TRUST_MS` (30 s) without
re-checking. One `/hello` observed during an app restart or mid-upgrade can therefore poison a 30 s
window during which every queued observation is destroyed rather than retried.

**Fix:** add `426` (and realistically `403`) to the retryable list. A protocol mismatch is a
*transient configuration* error — the user reloads the extension or restarts the app and it resolves.
It must never be treated as "this individual observation is permanently malformed", which is the only
thing that branch was designed for.

### B-02 — Late-arriving rows can never reach their correct time slot across turns — **Source-confirmed** — *medium*

Confirmed visually by the user: a `CHATGPT` message stamped **06:57:44** rendered *below* a `YOU`
message stamped **06:58:18**.

`chronological()` (`src/shared/chronology.ts`) is deliberately **turn-local**: events are grouped by the
turn that opened them and sorted by `time` only *inside* that group; across groups, order is `seq`
(or `origin`). That was a sound rule when `time` was always "when this page observed it".

1.8.8 broke the premise. The new `authoredTime` / `preferTime` path (`store.ts:714`,
`recorder.ts:1380`) rewrites a message's `time` **backwards** to ChatGPT's own `create_time`. So a
message backfilled after a reload now carries a genuinely early timestamp but a late `origin`, and the
turn-local rule pins it to the bottom anyway. The 1.8.8 improvement made the visible ordering *worse*
in exactly the case it was meant to improve.

**Fix:** the ordering rule needs to distinguish *authored* times from *observed* times, which the
records now do carry. An event whose time is authored by ChatGPT is safe to place globally; one stamped
at observation time is not. Propagate `authoredTime` onto the stored event and let `chronological()`
sort authored items across group boundaries.

### B-03 — `activeTurnId` can stick permanently and freeze orphan cleanup — **Source-confirmed** — *medium*

`store.ts:526-527`:

```js
if (event.kind === 'turn_start') summary.activeTurnId = event.turnId ?? `seq-${event.seq}`;
if (event.kind === 'turn_end' && (!event.turnId || summary.activeTurnId === event.turnId)) summary.activeTurnId = null;
```

If a `turn_start` ever lands without a `turnId`, `activeTurnId` becomes `seq-N`, and a later
`turn_end` **with** a `turnId` matches neither clause — so it is never cleared. `durableQuiescence()`
then short-circuits on `if (summary.activeTurnId) return { quiescent: false, ... }`
(`bridge.ts:1238`), and `sweepStaleSwarm()` can never retire that worker. Permanently.

The extension path currently fails closed (`recorder.ts:1446`, `:1475` both `continue` on a missing
`turnId`), so the `seq-` fallback is unreachable *today* — which means it is dead code that exists only
to create a permanent wedge if any future producer is less careful. Either drop the fallback and let
`activeTurnId` stay null, or make `turn_end` clear a `seq-`-prefixed id unconditionally.

Related and independently true: `activeTurnId` is durable and only a matching `turn_end` clears it. A
tab closed mid-turn, an extension reload, or a browser crash leaves it set forever. There is no
timeout, so that session is permanently non-quiescent.

### B-04 — Asset quota is enforced twice, inconsistently, with a counter that double-counts — **Source-confirmed** — *low*

1.8.8's V-17 put durable asset accounting in `store.ts` and **exported** the limits
(`MAX_ASSET_BYTES`, `MAX_SESSION_ASSET_BYTES`). `recorder.ts` still declares its own private copies of
the same two constants (`recorder.ts:68`, `:70`) and enforces them first (`recorder.ts:1187-1189`)
against a separate in-memory `assetBytes` map. Two enforcement points, two copies of the numbers, free
to drift.

The recorder's copy is also wrong in a specific way: `writeAsset()` is content-addressed and returns
the existing ref without writing when the file is already there, but the recorder increments
unconditionally:

```js
const asset = await writeAsset(sessionId, data, mimeType);
assetBytes.set(sessionId, used + data.length);   // counted even when nothing was written
```

Repeated identical screenshots inflate the counter and can cut off asset storage well before the real
192 MiB is used. **Fix:** delete the recorder's constants and pre-check, import the store's, and let
the one durable accounting path be authoritative — it already throws a clear error the recorder
catches.

### B-05 — `rewriteUnattributedToolCalls` does not reset `activeTurnId` — **Source-confirmed** — *low*

`store.ts:1279-1292` rebuilds the Unattributed bucket's summary and explicitly zeroes `events`,
`toolCalls`, `errors`, `lastTurnOutcome`, `agents`… but not the new `activeTurnId`, which survives via
the object spread. The replayed events contain no `turn_start`, so a stale value can never be cleared
afterwards. Same class as B-03: it makes the bucket permanently non-quiescent. One line.

### B-06 — Unbounded full-journal read on the metadata recovery path — **Source-confirmed** — *low*

`rebuildSummaryFromHistory()` (`store.ts:~400`) streams **all** of `events.jsonl` with no byte budget,
despite `FIXES-1.8.8.md` describing V-13 as an *"explicit bounded history rebuild"* and despite
`MAX_RECENT_READ_BYTES` existing for exactly this. It only runs when both `meta.json` and
`meta.backup.json` are unreadable, so it is rare — but that is also precisely when the session is
large and damaged. Worth a bound, or worth correcting the claim in the release record.

---

## Part 3 — Efficiency

### E-01 — The failure state is also the expensive state — **Source-confirmed** — *medium*

`bridge.ts:757`, on every `/activity` poll where no live session exists:

```js
await restoreRecordedConversation(id);   // → findSessionByConversation → readAllSummaries()
```

`readAllSummaries()` (`store.ts:1065`) `readdir`s the sessions root and reads **every** session's
`meta.json` from disk. This machine has **60 recorded sessions**. Every open ChatGPT tab polls
`/activity` every 2 s (`ACTIVITY_MS`). So a chat in the broken state the user just hit costs ~60 file
reads every 2 seconds, per tab, indefinitely — and it is the state most likely to persist.

**Fix:** memoise a negative result per conversation id for a few seconds, or keep a
conversation-id → session-id index instead of rescanning. A single `Map` invalidated on session
create/rebind removes the whole scan.

### E-02 — `readRecentEvents()` flushes every open session on every call — **Source-confirmed** — *low*

`store.ts:853`: `await flushSessions()` at the top of `readRecentEvents`, which iterates **all** open
sessions and enqueues a meta write for each. `readRecentEvents` is now on the `/activity` hot path
(`bridge.ts:776`, once per tab per poll) and on `sweepStaleSwarm`'s 30 s sweep. The V-08 fix correctly
removed the unbounded *parse*, but left a global flush in front of it. Flushing only the session being
read is sufficient.

### E-03 — `writeSummary()` now does a read + two writes + two renames per save — **Source-confirmed** — *low*

The V-13 checkpoint (`store.ts:178`) reads the current `meta.json`, re-serialises it to
`meta.backup.json`, then writes and renames the new one. Debounced at 1500 ms so it is affordable, but
it is ~3× the I/O of the old path and the backup is a full re-serialisation of data that was just read
as text — `fs.copyFile` after validation would do the same job for less.

---

## Verification performed in this pass

- `npm run build` — **passed** (852 ms). `out/main/index.js` now reports `APP_VERSION = "1.8.8"`.
- `npm run typecheck` — **passed**.
- `npm test` — full suite launched; see the session log for the result.
- Forensics: `state/request-correlations.json` (95 entries, 0 conflicted) read directly from the live
  app's user-data directory; timings cross-checked against the app's own rendered timeline.
- No product source was modified. The only change to the repository state is the compiled `out/`
  directory, which was stale at 1.8.7.

## Suggested fix order

1. **B-01** (426 destroys data) — a config mismatch must never delete transcript.
2. **L-03 fix #1** (keep reading Fiber briefly after a turn ends) — the highest-leverage change for the
   attribution failure the user actually hits, and independent of the version mismatch.
3. **L-02** (bump `BRIDGE_PROTOCOL` to 6) — release-gated; makes the 426 gate mean something.
4. **L-03 fixes #2/#3** (longer `spawn` window, recoverable refusal).
5. **E-01** (negative-result cache) — cheap, and it targets the state users are stuck in.
6. **B-02** (authored-time ordering), then **B-03/B-04/B-05/B-06**, then **E-02/E-03**.
