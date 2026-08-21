# Renderer / preload / IPC performance audit

**Date:** 2026-08-21 (Europe/Berlin)  
**Repository:** `C:\Users\totec\chatgpt-local-files`  
**Scope:** read-only audit of the Electron renderer, preload, IPC, chronology and timeline
path. The only repository write from this audit is this report. I read `AGENTS.md` in full
and `bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md`. I did not run the
routine Vitest suites; the two probes below cover dimensions those tests do not exercise.

## Executive result

Electron isolation and the HTML allowlist are materially sound, and the session-detail
generation checks correctly protect the ordinary A → B → A selection race. The strongest
remaining renderer risks are resource scale and state versioning: a bounded *event count* is
not a bounded IPC/DOM payload, default history refresh still materialises all canonical
messages, and the renderer has no revision that orders action replies against unsolicited
state pushes. The existing M4 and M1 findings therefore remain relevant, with the renderer
surface adding new gaps below.

## Findings

### R1 — HIGH / P1 — Timeline payload and full redraw are not bounded by bytes or DOM cost

**Trigger:** Open Chat for a long session containing large assistant answers or captured
rendered HTML, then let normal `session:changed` refreshes arrive. A renderer caller can also
request `limit:1000` through the exposed `getSession` options.

**Evidence:**

- `src/main/ipc.ts:296-315` caps the default response by event count (`300`) and accepts up
  to `1000` for an explicit request, but has no response-byte cap.
- `src/main/session/recorder.ts:1385-1396` stores assistant prose inline up to `256,000`
  characters and rendered HTML up to `120,000` characters. The visual CSS limits (`styles.css:
  1596-1602,1814-1825`) cap only the visible box height; the strings and parsed nodes remain
  resident in the DOM/renderer heap.
- `src/renderer/chat.ts:248-269,571-586` folds and reorders the complete returned window,
  creates every row with `shown.map(eventRow)`, and tears down/replaces the whole `#timeline`
  on each repaint. `src/renderer/chat.ts:330-375` reparses each non-empty HTML answer with
  synchronous `template.innerHTML` before walking it.
- `src/renderer/chat.ts:892-897` schedules another full list/detail load 400 ms after a
  session change; there is no incremental DOM append or row diff.

The count cap does not make the payload small: `300 × 256,000 = 76,800,000` UTF-16 code
units (~146 MiB for the text alone) before DOM/parser overhead. The canonical-message file
has a 32 MiB write ceiling (`src/main/session/store.ts:340-349`), but the explicit cursor
path can still return up to 1000 event rows and each event line may approach the 512 KiB
line ceiling. The renderer-facing cap is therefore a count, not a memory budget.

**Probe (missing dimension, not a product test):** a jsdom loop equivalent to the sanitizer
parser (`125` × `119,907` HTML characters, retained as DOM nodes) produced:

```json
{"htmlChars":119907,"count":125,"elapsedMs":966,"heapDeltaMiB":434.1,"textChars":14987500}
```

This is not an Electron profile, but it demonstrates that the synchronous parse-and-retain
shape can consume hundreds of MiB before the application has built the surrounding event
rows. **Confidence: high** for the unbounded shape; medium for the exact Electron impact.

**Impact:** multi-second GC/layout pauses, renderer watchdog termination, or an OOM/blank
window when a large session is selected or repeatedly refreshed. Untrusted page HTML is
correctly sanitized for execution, but remains an effective synchronous CPU/heap input.

**Fix direction:** enforce a byte/character budget at the IPC boundary in addition to event
count; return a lightweight row projection and lazy-load one expanded message/tool body;
virtualize or incrementally patch the timeline instead of `replaceChildren(...map(...))`;
parse/sanitize HTML only when its row is visible/open. Keep complete text in durable assets,
not in every renderer response.

### R2 — HIGH / P1 — History IPC still performs whole-session work outside the default tail (M1-related residual)

**Trigger:** The Chat panel refreshes a session repeatedly, or a renderer caller requests an
explicit cursor (`window.api.getSession(id, { from, limit })`). Large session stores make this
main-process work renderer-triggerable.

**Evidence:**

- `src/main/session/store.ts:643-711` implements `readEvents()` by reading the entire
  `events.jsonl`, splitting every line, parsing every candidate and running `chronological`
  over the full result before applying `.slice(0, limit)`. Thus `limit` is a response cap, not
  a computation cap.
- The current default path in `src/main/session/store.ts:722-815` bounds the raw journal scan
  to `8 MiB` and `4096` rows, but then loads all canonical messages (`:317-337`), appends
  every canonical message to `candidates` (`:806-811`), sorts them all (`:812`) and only then
  takes the newest `cap` rows (`:813`). A long canonical transcript therefore still pays a
  full parse/sort on every refresh even though the UI shows only 300 rows.
- `src/renderer/chat.ts:221-231,886-897` calls `listSessions()` and then `getSession()` on
  each coalesced refresh. `src/main/session/store.ts:917-943` enumerates the session root and
  reads/sorts up to `5,000` session directories before slicing the 200-row UI result.

For the explicit path, a legal worst-case line size of roughly `512 KiB` × `1000` rows is
about `500 MiB` of JSON before `raw.split('\n')`, parsed objects, chronology arrays and IPC
serialization. The 2026-08-20 consolidated report already measured the closely related
M1 whole-file history freeze at **68,305 ms / +83.6 MiB heap** for a 40 MiB journal and
`limit:1`. The current `readRecentEvents()` is a meaningful mitigation for raw journal tails,
so this entry is a **residual/extension of known M1**, not a claim that the old exact probe
still reproduces unchanged.

**Confidence: high** for the work order and missing computation/byte bounds; medium for a
particular machine's elapsed time.

**Fix direction:** maintain a durable sequence/tail index and read only the requested window;
make canonical-message reads tail-aware by sequence instead of loading/sorting the whole map;
stream/reject explicit cursors that exceed a response-byte budget; cache `listSessions()` or
key reloads by a recorder revision rather than rescanning up to 5,000 folders every 400 ms.

**Lower-severity IPC payload gap (same boundary):** `src/preload/index.ts:83,87` passes agent
ids as raw strings, and `src/main/ipc.ts:388-409` checks only `typeof payload === 'string'`
for `swarm:clearAgent` and `swarm:recoveryKey`; unlike session/settings arguments, there is no
length or character validation. The normal UI supplies short broker ids, but a compromised
renderer can send an arbitrarily large string and force needless IPC allocation/string
operations. Apply the same bounded identifier schema used for session ids.

### R3 — MEDIUM/HIGH / P1 — State revisions do not cover action replies, and Chat settings still clobber dirty fields (M4 family)

**Trigger:** Type in a Chat-panel setting while a status/bridge update arrives, or have an
initial `state:get`/settings action response resolve after a newer unsolicited state push.

**Evidence:**

- `src/renderer/main.ts:447-450` assigns every incoming `AppState` directly to `state` and
  paints it. `src/renderer/main.ts:1158-1165` wires both unsolicited `state:changed` and
  request-based `getState()` through that same unversioned `apply()` path.
- `src/main/ipc.ts:412-421` has a generation counter only for competing *push builds*. It
  does not attach a revision to `AppState`, and it cannot order a `state:get`,
  `settings:save`, `connect` or `disconnect` reply against a push already delivered to the
  renderer. A slow A reply can therefore paint over a newer B push; an A → B → A ordering is
  not distinguishable by value equality.
- The existing M4 guard protects Home/setup controls in `src/renderer/main.ts:93-100,536-559`
  by comparing the focused value with the previous persisted value. However,
  `src/renderer/chat.ts:851-877` (`chatApply`) assigns `sessRetain`, `autoCompact`,
  `autoCompactTokens`, and `maWorkers` unconditionally on every `apply()`. A focused unsaved
  Chat setting is therefore still overwritten by an unsolicited state snapshot. The change
  listeners at `src/renderer/chat.ts:1012-1014` save only after the value has already been
  replaced.

The 2026-08-20 report's M4 probe proved the same class for `tunnelId`/Home controls; this is a
**new unguarded Chat-panel surface plus a new push-vs-reply ordering gap**, not a duplicate
claim that the existing Home guard is absent.

**Confidence: high** from control flow; no browser timing is required to establish the race.

**Impact:** stale connection/config indicators, lost typed settings, and full-patch saves
that can persist an older snapshot after a quick sequence of edits. The user may believe a
setting was saved while a later state paint silently reverts it.

**Fix direction:** add a monotonic main-owned `stateRevision` to every state snapshot and
action reply, and reject older revisions in the renderer; treat settings saves as a serialized
latest-intent queue; apply the same per-control dirty/pending-save policy to `chatApply` (or
stop sending the whole config for status-only pushes). Keep the existing generation checks for
session detail loads.

### R4 — MEDIUM / P2 — `refreshAll()` has an unguarded stale swarm paint

**Trigger:** Start two Chat refreshes close together (Refresh clicks, tab hide/show, or a
session-change refresh) while the two `getSwarm()` calls resolve in the opposite order.

**Evidence:**

- `src/renderer/chat.ts:886-890` awaits `loadSessions()` and then always paints the result of
  `api.getSwarm()`; `loadSessions()` has its own generation guard, but does not communicate
  whether this caller is still current. Thus an old `refreshAll()` continues into
  `getSwarm()` even after a newer refresh has won.
- `src/renderer/chat.ts:727-730` assigns `swarm = state` and repaints without an epoch/revision
  check. The direct unsolicited subscription `src/renderer/chat.ts:1025-1026` likewise passes
  `paintSwarm` a state with no client-side ordering metadata.

Ordering repro (source-level):

```text
refresh A -> list A -> getSwarm A (paused)
refresh B -> list B -> getSwarm B -> paint B
resume getSwarm A -> paint A (stale worker states/buttons)
```

**Confidence: high**; the existing session A/B detail guards do not cover this independent
promise chain. **Impact:** stale worker status, recovery-key affordances and clear buttons can
be shown after the run has advanced. Main-side action validation prevents an arbitrary agent
mutation, but the UI can display the wrong state and produce confusing/no-op actions.

**Fix direction:** give `refreshAll()` one generation covering both list and swarm requests,
or add a broker revision to `SwarmState` and ignore older snapshots. The subscription and
manual refresh path should share the same acceptance rule.

### R5 — MEDIUM / P2 — `openTools` is a renderer-side long-session retention leak

**Trigger:** Open many tool details over time, allow the timeline to refresh, and/or switch
sessions through non-click paths such as deletion/automatic selection.

**Evidence:**

- `src/renderer/chat.ts:390,397-400` keeps every opened call id in a module-global
  `Set<string>`. Repainting removes the old DOM and creates new listeners, but the Set retains
  ids even after a call is no longer in the loaded window.
- The only cleanup is `openTools.clear()` in the manual session-row click handler
  (`src/renderer/chat.ts:931-940`). Deletion/automatic selection and old-session eviction do
  not prune it. There is no size bound or session namespace.

A standalone V8 probe retaining one million call-like ids in a `Set` measured **+73.1 MiB
heap** after GC. It is not an Electron profile, but it bounds the shape and confirms that this
is retained application state, not merely detached DOM awaiting collection.

**Confidence: high** for retention; medium for a production-sized trigger. **Impact:** a
long-lived app with many opened calls accumulates heap and makes subsequent full timeline
rebuilds more expensive. This finding was not present in the 2026-08-20 consolidated report.

**Fix direction:** namespace open state by session, prune against the currently loaded call ids
after every detail load, clear on delete/automatic selection, and impose a small LRU cap. The
row listeners themselves are detached with their discarded DOM; the retained Set is the
confirmed leak.

## Negative findings / boundaries checked

- `src/main/index.ts:48-72,89-92` keeps context isolation, renderer sandbox, no Node
  integration, web security, denied navigation and denied new windows. No renderer authority
  regression was found there.
- `src/preload/index.ts:1-7,47-108` exposes named methods only; there is no generic invoke,
  `ipcRenderer`, filesystem, shell or network object in the renderer. Listener disposers are
  correctly wrapped, although the current renderer does not retain/use the disposers (a
  production page is created once, so this is not promoted as a leak).
- `src/renderer/chat.ts:312-375` strips attributes, drops executable/foreign/form content and
  allows only `http:`, `https:`, `mailto:` or fragment links. No new executable HTML path was
  found. The remaining risk is synchronous parse cost, covered by R1.
- Session detail, handoff and list loads already carry generation checks in
  `src/renderer/chat.ts:221-231,248-289`; the R4 swarm chain and main-state/action chain are
  the uncovered async consumers.
- No `URL.createObjectURL`, blob URL, image element or renderer asset fetch exists in the
  inspected files, so there is no confirmed object-URL lifetime bug in this boundary.

## Classification against the 2026-08-20 report

| Item | Classification |
| --- | --- |
| Dirty settings overwritten by state pushes | Existing M4 class; Home guard remains, but Chat settings are a new unguarded surface. |
| Whole-session history work | Existing M1 class; default raw-tail path is improved, while canonical-message merge and explicit cursor work remain residuals. |
| Timeline HTML/DOM scale | New renderer resource finding. |
| Push/reply state ordering | New renderer/main IPC versioning gap (adjacent to M4). |
| Stale swarm refresh paint | New renderer async-state finding. |
| `openTools` retention | New renderer heap finding. |

