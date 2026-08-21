# ChatGPT Local Files — active work list

Living list. Items are stable-numbered (`T-nn`) so they can be referenced in chat; never
renumber an existing item, append new ones at the end of their section.

Status: `[ ]` open · `[~]` in progress · `[x]` done · `[?]` needs a decision from the user

**This is the only active work queue.** Old review/backlog/smoke files have been folded
into this list; do not create a second TODO. Screenshots and other raw proof may live under
`docs/evidence/`, but every actionable item belongs here.

**Installed build: v1.9.1** — see the record directly below. The v1.8.8 note that used to
stand here is kept for history:

**Installed build: v1.8.8.** Verified directly on 2026-08-21 from
`%LOCALAPPDATA%\Programs\ChatGPT Local Files\ChatGPT Local Files.exe`: file version `1.8.8`,
product version `1.8.8.0`, written 07:14. Packaged-runtime smoke passed (version agreement,
extension scripts, tunnel-client, cloudflared, ripgrep, app.asar, node-pty, Sharp 0.35.3 /
libvips 8.18.3 with a real PNG encode). It replaces v1.8.4, which had been the installed
build since 2026-08-20; the 1.8.7 that was running on 2026-08-21 came from a stale `out/`
and is what T-174 below is about.

## v1.9.1 — package and install record — **INSTALLED 2026-08-21**

Commit `dd8f49b`. The fix for the outage where every connector call in a chat was filed under
`Unattributed activity` while the popup showed the request id as read and sent: ownership was
gated end to end on ChatGPT's `data-turn-id`, which its virtualized renderer omits. Ships with
it the Fiber conversation-conflict bit, the fresh-reload provisional journal carry in
background.js, and the recorder's discard/unattributed diagnostics.

- Installer: `release/ChatGPT-Local-Files-Setup-1.9.1.exe`, 144,151,986 bytes,
  SHA-256 `2F45F3CC7ACA8921019A09C119ACA365531BFC8FF5042E22E817A98EEACE526F`.
- `node scripts/smoke-packaged-runtime.mjs` passed: `{"version":"1.9.1","sharp":"0.35.3",
  "libvips":"8.18.3","pngBytes":95,"ptySpawn":"function"}`.
- `npm run verify` before packaging: typecheck clean, 1078 passed / 83 skipped.
- Installed `ChatGPT Local Files.exe` reports FileVersion `1.9.1`, ProductVersion `1.9.1.0`.
  All five extension files under `resources/extension` hash-match the repo copies — the
  1.8.7-style app/extension split check.
- Live probe of the running build: `GET /hello` → `{"version":"1.9.1","bridge":6,
  "compatible":true,"paired":true}` with `x-extension-protocol: 6`.

**Open — the extension must be reloaded by hand.** `BRIDGE_PROTOCOL` is unchanged at 6, so
unlike the 1.8.9 release there is no 426 gate to make the staleness loud: Chrome's loaded
1.9.0 copy connects and pairs happily while still running the broken `content.js`. Until
`chrome://extensions` → reload on ChatGPT Local Files, nothing in this release is in effect.

After the reload, the things to watch:

- New chats: connector calls appear under the chat itself, not `Unattributed activity`, and
  the app log carries a `request attribution: <id> -> conversation <id>` line per call.
- Subagents can address each other again (no `CALLER_IDENTITY_REQUIRED` /
  `WORKER_IDENTITY_LOST` on calls that plainly came from a live chat), and calls stop
  spending the full 15 s `REQUEST_ID_GRACE_MS` before being filed.
- If something still lands unattributed, the log now names it:
  `request attribution: no page evidence for <id> within 15000ms`, or
  `... Discarded request ids: <ids>` when the URL and Fiber conversations disagree. Those two
  lines are the ones to quote — their absence is what made this outage invisible.


## v1.8.9 — package and install record — **INSTALLED 2026-08-21**

Commit `8a1a00d`. Ships the 1.8.8 hardening pass, the test-suite fixes above, and the
`BRIDGE_PROTOCOL` 5 → 6 bump the post-implementation review (L-02) left as a release
decision.

- Installer: `release/ChatGPT-Local-Files-Setup-1.8.9.exe`, 144,145,242 bytes,
  SHA-256 `FA18BFD31BE31D5C8CB4BA9DB1F68BA1FB151F320F3E37F58375CA5127ABC847`.
- `node scripts/smoke-packaged-runtime.mjs` passed: `{"version":"1.8.9","sharp":"0.35.3",
  "libvips":"8.18.3","pngBytes":95,"ptySpawn":"function"}`.
- Installed `ChatGPT Local Files.exe` reports FileVersion `1.8.9`. All four extension files
  under `resources/extension` hash-match the repo copies, so no 1.8.7-style split where the
  app and the extension disagree.
- Live probe of the running build: `GET /hello` → `{"version":"1.8.9","bridge":6,
  "compatible":true,"paired":true}` when the caller declares protocol 6.

**Open — the extension must be reloaded by hand.** Chrome still holds the 1.8.8 copy it was
loaded from, which sends protocol 5, so the new 426 gate rejects it on every stateful route.
That is the bump working as intended, but until `chrome://extensions` → reload on ChatGPT
Local Files, the browser side is dead. Watch after the reload: observations attributing to a
session instead of UNIDENTIFIED_CALLER, and message ordering now driven by `authoredTime`.


## Test suite — 10+ minutes / hangs — **ALL FIXED 2026-08-21**

Full suite before: minutes, often never finishing, 17+ spurious failures.
After: `36 passed (36)`, `1063 passed | 83 skipped`, **29.4s wall**.

- [x] **T-183 — `scheduleActivityPull` starved the event loop under the test harness.**
      It re-arms itself with `setTimeout`, and the content-script harness replaces
      `window.setTimeout` with `(fn, ms) => { clock += ms; Promise.resolve().then(fn); }`.
      That turned one background poll into an unbroken microtask chain: the second test in
      `content-script.test.ts` waited forever for a window `load` event no macrotask could
      deliver. `every()` escapes this because the harness stubs `setInterval` to a no-op;
      the pull re-arms with `setTimeout` and walked past that seam. Fixed by gating the
      re-arm on the existing `TEST_MODE` flag, matching what the harness already does to
      `every()`. Production is untouched — `TEST_MODE` is only true when `CLF_TEST_HOOK`
      exists. `content-script.test.ts`: hung -> **5.6s**.

- [x] **T-184 — the suite could talk to the installed app.** `src/main/bridge.ts` hardcoded
      `PORTS = [8765..8769]`. The developer’s own app holds 8765 while the suite runs, so
      with 16 forks racing for 5 ports a test whose bind lost fell through to the *real*
      bridge with a test token — `TIME_WAIT` sockets to 8765 from the test run proved it.
      The list is now overridable (`CLF_BRIDGE_PORTS`) and `vitest.config.ts` sets `0`, so
      every test bridge takes an ephemeral port. The shipped range is still asserted, in
      `bridge.test.ts`, against the exported `DEFAULT_PORTS`.

- [x] **T-185 — `resume.test.ts` never sent `x-extension-protocol`.** Every route past
      `/hello`, `/pair` included, refuses a caller that does not declare its protocol. So
      pairing answered 426, the token came back `undefined`, and all 17 tests failed on the
      *next* request with `expected 401 to be 202`. The helper now sends `BRIDGE_PROTOCOL`
      like the shipped extension does.

- [x] **T-186 — tests waited out real 15-second evidence windows.**
      `session.test.ts > rejects URL/Fiber conversation conflicts` sat in
      `awaitRequestCorrelation` for the whole `REQUEST_ID_GRACE_MS` to prove a negative.
      Added `evidenceWindow()` in `recorder.ts`, clamped so it can only ever shorten, driven
      by `CLF_EVIDENCE_MS: 1500` in test config; `PRIME/IDENTITY/JOIN_EVIDENCE_MS` use it
      too. Production keeps the measured 2.5s / 15s / 30s. `session.test.ts`: 18.8s -> 4.2s.

- [x] **T-187 — `continuation.test.ts > survives a deadline crossed while the durable write
      is in flight` was timing-fragile.** It jumped the clock from the caller after one
      `await Promise.resolve()`, but `commitContinuation` does a real durable write *before*
      the preflight, so the jump landed before `freezePrimeTransfer` — testing plain expiry,
      which is a different case two tests down. The jump now happens inside the mocked
      `rebindSession`, which is where the comment always said it happened.

- [x] **T-188 — five stale expectations in `content-script.test.ts`.** `closed` and two
      `ack` messages gained `navigationEpoch`, and the page-local overflow marker was
      reworded from "page-local queue filled" to naming the budget it hit. Expectations
      updated; no product change.

- [ ] **T-189 — `computer.test.ts` flakes under a full parallel run.** Three tests
      (`returns a Codex-style window state`, `pairs window state element centres`,
      `refuses a ref minted before the desktop helper restarted`) failed in one 16-fork run
      and pass alone and alongside `process-manager`/`exec`. They read the *real* foreground
      window, and the suite spawns dozens of transient consoles. Not reproduced since the
      orphan cleanup below; re-check before treating it as real.

- [ ] **T-190 — killing a `vitest run` leaves its whole worker tree alive.** Eight orphaned
      runs were found on 2026-08-21, the oldest holding 3502 CPU-seconds, together pegging
      ~9 of 16 cores and making every subsequent run slower than the last. Nothing in the
      repo causes this — it is how the runs were being cancelled — but a `npm run test:kill`
      helper that reaps `node.exe` whose command line contains `vitest` would stop it
      costing an afternoon again.

## v1.8.8 — post-implementation review + live attribution root cause — **INSTALLED 2026-08-21**

Full write-up with evidence:
`bughunt-2026-08-21/09-post-1.8.8-review-and-live-attribution-rootcause.md`.

Context: on 2026-08-21 a live `agents action=spawn` was refused four times with
`UNIDENTIFIED_CALLER` while the extension popup showed `Chat ID ✓`, `Request ID ✓`,
`Sent to app ✓`. Two separate causes. One is closed; the other is not.

- [x] **T-174 — the running app was 1.8.7 while the extension was 1.8.8. FIXED (built).**
      `src/main/version.ts` said `1.8.8` but `out/main/index.js` still carried
      `APP_VERSION = "1.8.7"` (built 2026-08-20 16:22). `FIXES-1.8.8.md` had recorded
      `npm run build` as "environment-blocked"; that was a Codex sandbox limit, not a source
      problem — it builds here in under a second. `restoreRecordedConversation()` is
      1.8.8-only, so the 1.8.7 bridge could never reattach a chat whose live session was
      lost, which is exactly the popup string *"the app has not opened a session for this
      chat yet"*. Rebuilt, repackaged and installed as 1.8.8 on 2026-08-21.

- [ ] **T-175 — request-id evidence arrives after the 15 s identity window, so the first
      `agents spawn` in a chat is refused. SURVIVES THE VERSION BUMP — still open.**
      Proven from `state/request-correlations.json` on the live machine: four refused
      `agents` calls produced only **two** correlation entries, at 20 s and ~2 min after the
      refusal (the 2-min one only because the page was reloaded). `IDENTITY_EVIDENCE_MS` is
      15 s (`kernel.ts:780`); all four missed it.
      Mechanism: `refreshFiber()` — the only thing that reads a connector call's
      `request_id` out of ChatGPT's message model — runs on a 1 Hz tick **only while
      `generating` is true** (`content.js:1386`), plus once at turn end (`content.js:1209`)
      and on connector-row mutations (`content.js:1544`). **Once generating goes false there
      is no further read at all.** If ChatGPT materialises the request id after that single
      turn-end read, nothing emits it until the next turn or a reload.
      Structural aggravator: `spawn` is the one call that cannot tolerate eventual
      attribution, and it gets the *least* help — the kernel's extra identity wait only fires
      when `swarmRunning()` (`kernel.ts:393`), which is false for the call that creates the
      run. The whole burden sits on `callerNow`'s 15 s.
      Fix order: (1) keep reading Fiber at 1 Hz for ~30 s after `generating` clears — turns
      "never, until you reload" into "a second or two", and is the highest-leverage change;
      (2) give `spawn` its own longer window (`SPAWN_EVIDENCE_MS`, 30–45 s) — the wait is
      event-driven so it costs nothing on success; (3) hold the spawn intent and complete it
      when the request id resolves, instead of refusing terminally.

- [ ] **T-176 — HTTP 426 makes the extension permanently delete queued observations.**
      `background.js` `drain()` treats any 4xx outside `[401,408,409,429]` as "permanently
      malformed": the entry is dropped and replaced with a gap marker. V-18's new 426 falls
      through that filter, so the moment app and extension disagree on protocol the extension
      destroys the journal instead of waiting for a reload. Worse, `call()` can 426 itself
      from a **cached** `portCompatible` trusted for `PORT_TRUST_MS` (30 s) without
      rechecking. Fix: 426 (and 403) belong in the retryable list — a protocol mismatch is a
      transient configuration error, not a bad observation.

- [ ] **T-177 — `BRIDGE_PROTOCOL` is still 5, so the 426 gate is blind to the mismatch it
      was built for.** 1.8.7's extension already sent protocol 5, so app 1.8.7 + extension
      1.8.8 passes the gate cleanly while the wire has changed underneath it
      (`resetActivity`/`truncatedFrom`, `authoredTime`, `retiredWorker`, the new
      `no_such_command` ack semantics). Bump to 6 and extend the changelog comment in
      `version.ts`. Release-gated: it will 426-reject every currently-loaded 1.8.7 extension
      until reloaded — do it with the release, not before, and fix T-176 first or the bump
      itself will eat transcript.

- [ ] **T-178 — late-arriving rows can never reach their correct time slot.** Observed live:
      a `CHATGPT` message stamped 06:57:44 rendered below a `YOU` message stamped 06:58:18.
      `chronological()` is deliberately turn-local — sorted by `time` inside a turn, by
      `seq`/`origin` across turns — which was sound while `time` always meant "when this page
      observed it". 1.8.8's `authoredTime`/`preferTime` (`store.ts:714`) now rewrites `time`
      **backwards** to ChatGPT's own `create_time`, so a backfilled message carries an early
      timestamp and a late `origin` and gets pinned to the bottom anyway. Fix: propagate
      `authoredTime` onto the stored event and let authored items sort across group
      boundaries; observed-time items must keep the current rule.

- [ ] **T-179 — `activeTurnId` can wedge permanently and freeze orphan cleanup.**
      `store.ts:526` sets `activeTurnId` to `event.turnId` or, when that is absent, a
      synthetic `seq-<n>` — but `turn_end` only clears it when the ids match or the end is
      unnamed, so a `seq-` value is never cleared. `durableQuiescence()` short-circuits on it
      (`bridge.ts:1238`) and `sweepStaleSwarm()` can then never retire that worker. The
      extension path fails closed on a missing `turnId` today, so the fallback is currently
      unreachable dead code that exists only to create a permanent wedge later — drop it.
      Separately, `activeTurnId` has no timeout: a tab closed mid-turn leaves it set forever.
      Same class: `rewriteUnattributedToolCalls` (`store.ts:1279`) resets `lastTurnOutcome`,
      `agents`, counters — but not `activeTurnId`, which survives the spread and can then
      never be cleared.

- [ ] **T-180 — asset quota is enforced twice, inconsistently, with a double-counting
      counter.** V-17 moved durable accounting into `store.ts` and exported the limits;
      `recorder.ts:68,70` still declares private copies of the same two constants and
      pre-checks against its own `assetBytes` map. That map also increments unconditionally
      after `writeAsset()`, which is content-addressed and writes nothing for a repeat — so
      identical screenshots inflate it and can cut off asset storage well before the real
      192 MiB. Delete the recorder's constants and pre-check; let the store be authoritative.

- [ ] **T-181 — the failure state is also the most expensive state.** On every `/activity`
      poll with no live session, `bridge.ts:757` calls `restoreRecordedConversation()` →
      `findSessionByConversation()` → `readAllSummaries()`, which reads **every** session's
      `meta.json`. With 60 recorded sessions that is ~60 file reads every 2 s per open tab,
      indefinitely, in exactly the state a user is most likely to be stuck in. Fix: a
      conversation-id → session-id index, or a short negative-result cache invalidated on
      session create/rebind. Related, cheaper: `readRecentEvents()` calls `flushSessions()`
      (all open sessions) on every call despite now being on the `/activity` hot path
      (`store.ts:853`); flushing only the session being read is enough.

- [ ] **T-182 — `rebuildSummaryFromHistory()` reads the whole journal with no byte bound**
      (`store.ts:~400`), despite `FIXES-1.8.8.md` describing V-13 as an "explicit bounded
      history rebuild" and despite `MAX_RECENT_READ_BYTES` existing for it. Only runs when
      both `meta.json` and `meta.backup.json` are unreadable — which is also exactly when the
      session is large and damaged. Bound it, or correct the release record.

## v1.8.4 — turn killer, reload identity, exec isolation — **INSTALLED 2026-08-20**

One live session reported chats dying on their own (`Error in message stream` → `Turn ended
for an unknown reason`, no user action), a reloaded chat showing every message twice, and
Overwrite looking switched off after a reload. All three were reproduced from the session
files on disk rather than guessed at. The Codex-port audit items from the same report are
below with what was fixed and what deliberately was not.

- [x] **T-167 — `view_image` returned an undecodable PNG and that killed the ChatGPT turn.
      FIXED.** Replaying `events.jsonl` across the store: four of the five `Error in message
      stream` events immediately follow a tool call returning `.audit-deep-corrupt.png` as an
      MCP `image` content block, recorded `outcome: ok`, asset 68 bytes. `hasImagePayload`
      only checked the 8-byte PNG signature, so a file that inflates to nothing was answered
      as a successful image, and ChatGPT's stream broke on the content block. `decodesAsPng`
      in `src/main/codex/view-image.ts` now really decodes: IHDR fields validated against
      colour-type/bit-depth tables, PLTE required for colour type 3, IDAT payloads inflated
      with `node:zlib`, and every scanline of every Adam7 pass checked for length and a legal
      filter byte. Running the actual stored asset through `viewImage` now rejects; with the
      file stashed it resolves, which is the regression pinned in
      `test/codex-view-image-parity.test.ts`.
      **Known gap, deliberate:** JPEG/GIF/WebP are still structural checks only. A corrupt
      JPEG can still reach ChatGPT the way this PNG did.

- [x] **T-168 — a reload made every assistant message appear twice. FIXED.** `messages.json`
      held two keys with identical text and an identical authored `time`, differing only in
      the `parent_id` segment of the logical id. `assistantLogicalId` keyed on
      `parent_id + working_turn_id + turn_exchange_id`, and rehydrating a conversation from
      the server re-parents the text message, so every already-recorded message came back
      under a second key. Identity is now ChatGPT's own `working_turn_id` /
      `turn_exchange_id` / `create_time`, which is the same before and after a reload. No
      text, DOM position or local clock takes part. Two messages of one branch sharing a
      creation millisecond fall back to the parent tuple, so a collision costs a weaker key
      rather than a swallowed message (`extension/fiber.js`, `test/fiber.test.ts`).

- [x] **T-169 — Overwrite stopped naming rows after a reload. FIXED.** Not a switch: the
      join had expired. `data-turn-id` is minted per page load — the store has both shapes,
      `g-1s6atlm1inbjf2-0-1` while a turn streams and `request-WEB:<load-uuid>-<n>` for the
      same turn after a refresh — so the `turnId` on every recorded call named no visible
      turn and every block fell through to the quieter page-named label. ChatGPT's connector
      request id is the durable half of that join and both sides already hold it: 183 of 183
      recent recorded calls carry one, and one request id covers a whole turn.
      `/activity` now sends `requestId` with each entry (`src/main/bridge.ts`) and
      `recordedCallsFor` in `extension/content.js` falls back to it when the turn id finds
      nothing — only when the turn names exactly one request, and only for a request no
      earlier turn claimed in the same pass. Covered in `test/content-script.test.ts`.

- [x] **T-170 — automatic compaction could arm and then lose the edge forever. FIXED.**
      No session in the store has ever had a non-null `autoCompactThreshold` or
      `autoCompactTriggeredAt`. Replaying session `2026-08-19-9ddc2f5f` (587 events, 40k
      threshold) shows why: it armed on the crossing tool call, lost the arm to that same
      turn ending `interrupted`, and then ran to 433,236 context tokens with `readyAt: null`
      — a monotonically growing counter can never cross the threshold from below twice.
      `updateAutoCompaction` now lets a retained threshold become ready at the first turn
      that ends `completed`. The trigger stays edge-based and once-per-chat, so a stale
      finished chat that merely opens above the threshold still never fires
      (`src/main/session/store.ts`, `test/session.test.ts`).

- [x] **T-171 — exec sessions were global across ChatGPT chats. FIXED.** Codex hangs
      `UnifiedExecProcessManager` off `session.services`, so one conversation cannot name
      another's process. This connector is one long-lived process serving every chat through
      one manager, so `write_stdin(session_id)` on a small integer from another chat reached
      that chat's shell. `src/main/codex/ownership.ts` records the owning conversation from
      the same request correlation the recorder uses, `write_stdin` refuses a session it can
      *prove* belongs elsewhere, and `session status` no longer lists another chat's session
      ids. The rule is one-sided on purpose: an unproven caller is never refused, because
      identity is not always resolved by the time a command runs and a guess must not take a
      working terminal away from the chat that opened it (`test/mcp.test.ts`).

- [x] **T-172 — screen-reader live regions were being recorded as chat errors. FIXED.**
      `errors()` recorded the text of every `[role="alert"]`, including the `sr-only`
      regions ChatGPT announces ordinary UI state through, which inflated the app's error
      counts. `displayed()` in `extension/chatgpt-dom.js` now skips a live region that is
      visually hidden. Unmeasurable or zero-sized rects still count as displayed — jsdom
      reports all-zero rects, and treating those as hidden silently dropped every real
      banner (`test/content-script.test.ts`).

- [ ] **T-173 — Codex-port audit items left unchanged, on purpose.** Recorded here so they
      are decisions rather than oversights:
      · **8 MiB `view_image` cap** — kept at Codex's number. Raising it is a wire-size
        question for ChatGPT, not a parity one.
      · **Frozen `view_image` schema** — kept identical to Codex's so a model that knows the
        tool is not surprised by ours.
      · **`Number.isSafeInteger` is stricter than Rust `u64`/`usize`** — `unsignedIntegerNumber`
        in `src/main/mcp/tools-core.ts` refuses values above 2^53-1 that Codex would accept.
        No real call is affected; changing it would mean carrying BigInt through the tool
        surface for values nothing produces.
      · **`image_url` data URL duplicated in `structuredContent`** beside the image block,
        which roughly doubles the payload (up to ~22 MB at the cap). Left for parity; it is
        the item most likely to be worth revisiting if large images ever misbehave.

**1.8.4 source verification before packaging:** `git diff --check` clean; `npm run verify`
clean with **993 passed / 83 skipped / 0 failed across 34 test files**, TypeScript clean first.
Bridge protocol is **5**, Fiber helper `VERSION = 8` and content `FIBER_VERSION = 8`; the wire
shape did not change. `/activity` entries gained one additive field, `requestId`, which an
older extension simply ignores.

**1.8.4 package, installed:**
- Installer: `release/ChatGPT-Local-Files-Setup-1.8.4.exe` — **137,642,387 bytes** — SHA-256
  `E49A8CD6AAE80231D9533C56923C53FE3043BE3F0B01AE931CE491F11B696315`.
- Blockmap: `release/ChatGPT-Local-Files-Setup-1.8.4.exe.blockmap` — **145,214 bytes**.
- Unpacked executable reports file version `1.8.4`, product version `1.8.4.0`.
- Packaged extension manifest is `1.8.4`; `manifest.json`, `background.js`, `content.js`,
  `fiber.js`, `chatgpt-dom.js` and `overlay.css` hash-identically to the source extension,
  before packaging and again from the installed `resources/extension`.
- Installed silently with `/S`; exit code 0, app relaunched and running.

**Live smoke still open.** Everything above is proven from the session files and the test
suite, not from a fresh chat on this build. The three things to watch first: a `view_image`
on a real image still renders, a reloaded chat shows each message once, and a reloaded chat
still shows this app's tool names with durations rather than the quieter page-named rows.

## v1.8.1 — live-smoke attribution + streaming identity patch — **PACKAGED, NOT INSTALLED**

The first installed 1.8.0 smoke ran twelve sequential harmless MCP calls in a brand-new chat
while the desktop transcript was watched live. It exposed two real shapes the synthetic tests
had not represented; both were then proven directly from the fresh session files.

- [x] **T-165 — one ChatGPT `request_id` can own many MCP calls in one turn. FIXED.** The live
      smoke attributed its first four calls and then sent eight to `Unattributed activity`, yet
      all twelve carried the same `wfr_01a0170d0cca72cead646a24216c8edf`. The registry had
      incorrectly treated a new message id/tool under that id as a contradiction. Ownership is
      now exactly **request id → conversation**: different calls in the same conversation are
      compatible; only another conversation claiming that id conflicts and fails closed.
      Active `test/correlation.test.ts` covers both cases.

- [x] **T-166 — ChatGPT can rotate raw assistant UUIDs while one streaming block grows.
      FIXED.** Live `messages.json` showed `Eight calls in, still zero writes.` growing through
      four strict prefixes under four different UUIDs, producing four `ChatGPT (partial)` rows.
      When a new raw id has no direct canonical match, the store now folds it onto the longest
      **same-turn + still-streaming + strict-prefix predecessor**, retaining the first canonical
      id and chronology anchor. It never matches across turns, never folds a final, and separate
      non-prefix commentary in the same turn remains separate.

**1.8.1 source verification before packaging:** `git diff --check` clean; `npm run verify`
clean with **894 passed / 78 skipped / 0 failed across 30 test files**, TypeScript clean first.
The cross-stack attribution/transcript group is **332 passed / 77 skipped / 0 failed**. Bridge
protocol remains **5** and Fiber protocol remains **5**; the wire shape did not change.

**1.8.1 package, deliberately not installed yet:**
- Installer: `release/ChatGPT-Local-Files-Setup-1.8.1.exe` — **135,040,838 bytes** — SHA-256
  `AA67994A8A50B88EA5D431ECEC11D39CFA601E065C36D601FCB906947E33918B`.
- Blockmap: `release/ChatGPT-Local-Files-Setup-1.8.1.exe.blockmap` — **142,107 bytes**.
- Unpacked executable reports file version `1.8.1`, product version `1.8.1.0`.
- Packaged extension manifest is `1.8.1`; bridge protocol `5`, Fiber helper `VERSION = 5`,
  content `FIBER_VERSION = 5`.
- Packaged `manifest.json`, `background.js`, `content.js`, and `fiber.js` hash-identically to
  the source extension. The installed app remains 1.8.0 until this installer is run.

## v1.8.0 — canonical attribution/transcript + compaction hardening — **INSTALLED, LIVE SMOKE FAILED**

This is the first-principles rebuild requested on 2026-08-18/19. The core invariant is one
logical ChatGPT item = one stable transcript item, and one MCP request is owned only by its
exact ChatGPT `metadata.request_id` → conversation mapping. The installed 1.7.9 data from the
same live run was used as forensic input before packaging rather than treated as evidence for
the new build.

- [x] **T-160 — deterministic request-id attribution replaces heuristic ownership. FIXED.**
      Incoming `x-request-id` is normalized once at ingress and joined only to ChatGPT's exact
      `metadata.request_id`; the correlation registry records request id, conversation id,
      message id, tool and observation time. URL and Fiber conversation identities are
      cross-checked; disagreement poisons that request instead of guessing. Unmatched modern
      requests go to `Unattributed activity` and never borrow a same-tool/latest/sole-active
      chat. Recorded tool calls retain resolved request id, conversation id and attribution
      method for diagnosis.

- [x] **T-161 — assistant transcript is canonical by ChatGPT message id and rendered HTML.
      FIXED.** Streaming/final revisions update the same logical message rather than append
      growing snapshots. Final state is monotonic, sparse re-observations cannot erase richer
      captured HTML, and the renderer uses sanitized ChatGPT-rendered markup instead of a
      second Markdown parser. Chronology keeps tool calls as separate structured events while
      message revisions remain anchored at their original logical position.

- [x] **T-162 — automatic compaction was level-triggered and could repeatedly attack stale or
      live chats. FIXED.** Automatic compaction is now a durable below→above threshold edge,
      bound to the exact turn that crossed it. Only that turn's `turn_end: completed` makes it
      ready; stopped/failed/interrupted turns consume the arm without readiness. Claim is
      one-shot and durable before browser action, automatic mode never clicks Stop, local
      tools/active turns block claim, and a genuine close→reopen clears any old unclaimed
      ready edge. Opening an old chat already above the threshold therefore does nothing.

- [x] **T-163 — 1.7.9 could lose a worker or prime attribution when ChatGPT's UI/Fiber DOM
      glitched. FIXED.** Forensic proof from the installed 1.7.9 run: worker-2 was marked
      failed when its conversation was considered closed, while the prime session itself
      intermittently spilled its own calls into `Unattributed activity`; the unattributed
      stream contains exact prime commands and rejected `agents` calls with
      `WORKER_IDENTITY_LOST`. Two source defects were pinned: a transient
      `conversationId() === null` was treated as a close, and live Fiber request evidence was
      refreshed too conditionally. `null` now means temporarily unavailable; only real tab
      removal or a proven concrete A→B navigation retires A. While any generation is live,
      Fiber request evidence is refreshed even when there is no rendered connector row and no
      currently bindable assistant DOM turn. Browser regressions cover both cases.

- [x] **T-164 — MCP `read` advertised line ranges beside multi-path reads without saying the
      combination is illegal. FIXED.** Tool description, `start_line` / `end_line` field
      descriptions and connector instructions now state that line ranges require exactly one
      resolved path; runtime rejection remains as the final guard. This removes a real
      avoidable failed call without weakening validation.

**1.8.0 verification/package:** `git diff --check` clean; `npm run verify` clean with
**890 passed / 77 skipped / 0 failed across 29 test files**, TypeScript clean first. The two
`HTMLFormElement.requestSubmit()` stderr lines are jsdom limitations in passing fixtures.
Bridge protocol is **5** and Fiber protocol is **5** because older 1.7.x extension code cannot
satisfy the new canonical message/request evidence contract.

- Installer: `release/ChatGPT-Local-Files-Setup-1.8.0.exe` — **135,040,591 bytes** — SHA-256
  `9F42BBD9A987006B7EA5500547BBB0B72534F8D34ED2B9DD8D037E5D99CB3319`.
- Blockmap: `release/ChatGPT-Local-Files-Setup-1.8.0.exe.blockmap` — 142,144 bytes.
- Unpacked executable reports file version `1.8.0`, product version `1.8.0.0`.
- Packaged `resources/extension/manifest.json`, `background.js`, `content.js` and `fiber.js`
  hash-identically to source; packaged manifest is `1.8.0`, bridge protocol `5`, Fiber helper
  `VERSION = 5`, content `FIBER_VERSION = 5`.
- **Later installed and live-smoked.** The executable was verified as `1.8.0 / 1.8.0.0`.
  That fresh-chat smoke exposed T-165 and T-166 above, so 1.8.0 is retained as historical
  evidence rather than the build to recommend. Chrome's unpacked extension still requires a
  reload/hard-refresh whenever the replacement build is installed.

## v1.7.9 — transcript / agent / resume stability rebuild — **PACKAGED, LATER INSTALLED**

This is the 2026-08-18 evening stability pass driven by the live prime/worker screenshots,
worker-1's architecture review, and the user's report that a completed Compact & Resume
opened the replacement chat and then left it blank for roughly one to two minutes before
typing the handoff. The user explicitly asked for an installer but **not** an install; live
smoke of the new packaged build therefore remains a later manual step.
That was true at package time; the executable currently installed on this machine was later
verified as 1.7.9 / 1.7.9.0 before the 1.8.0 package above was assembled.

- [x] **T-152 — the durable session journal could advance memory/meta before the JSONL line
      existed. FIXED.** `appendEvent()` now serialises construct → validate → `appendFile` →
      `nextSeq++` → tail/summary/meta projection. A failed disk append consumes no seq and
      cannot make `meta.json` claim a message/tool call that never reached `events.jsonl`.
      The same store now keeps a bounded 4096-event durable tail, so incremental `/activity`
      reads whose cursor is in the tail are O(delta) instead of reparsing the entire JSONL on
      every poll. Disk remains canonical; old cursors fall through to the file.

- [x] **T-153 — recorder restart remembered that a turn was open but forgot which turn.
      FIXED.** `storedHistory()` now reconstructs the newest still-open durable `turnId` and
      its start time, and `sessionForConversation()` restores them. A content-script/app
      restart in the middle of a generation therefore resumes the existing turn instead of
      minting a second local turn around the same ChatGPT answer.

- [x] **T-154 — reconstructed transcript could grow garbage prefixes, teleport late text to
      the start of a turn, and show the same final twice. FIXED.** `dropEcho()` collapses the
      live no-whitespace chain shape such as `I’veI’ve gotI’ve got…` without touching normal
      repeated prose. Recorder progress ids are no longer trusted forever: monotonic growth /
      redraw stays one item, but a reused DOM root carrying unrelated late commentary forks
      to a fresh logical id and fresh timestamp. Cross-id continuation aliases are restricted
      to a sufficiently long prefix inside a short forward-time window. `visibleStream()`
      suppresses a progress prefix once the settled final contains it, final prose is stored
      at most once per local generation across React remounts, and the Local Files stream is
      mounted at ChatGPT's native activity location instead of being hoisted above the turn.

- [x] **T-155 — worker identity/inbox state could split after the handler and workers could
      remain zombies after their final answer. FIXED.** A handler-proven caller is never
      overwritten by a weaker post-handler lookup; `callerNow()` writes the proven
      conversation back into the call context; `adoptAgent()` always acknowledges messages
      offered on the previous result. The bridge also auto-finishes the exact worker when one
      observation batch contains its settled final assistant message and matching completed
      `turn_end`, so a worker that correctly stops making tool calls still releases the slot
      and produces a report for prime. Explicit `finish` remains idempotent.

- [x] **T-156 — exact request identity and workspace resolution still had competing timing
      fallbacks. FIXED.** The inbound `x-request-id` / page `metadata.request_id` join remains
      the authority. Modern calls with a request id no longer let `workspaceKey()` fall
      through to `soleGeneratingConversation()` while the exact mate is merely late. Only
      operations that consume an existing workspace before their handler runs (relative
      read/find, implicit/relative patch base, implicit/relative exec cwd) wait, and they use
      the full 15 s exact-id window. Self-contained absolute reads and explicit absolute-cwd
      execs stay fast and do not teach a guessed workspace.

- [x] **T-157 — Compact & Resume replacement chat could sit blank behind unrelated startup
      work. FIXED.** On an app-opened marked page, `runCommand()` now runs *before*
      `checkStatus → resumeOpenTurn → restoreCapture`; the bootstrap is the reason that page
      exists and no longer waits on ordinary session restoration. Composer readiness now uses
      the connected composer / DOM mount itself, not four `document.readyState === complete`
      samples chained through timers that Chrome may throttle in a background tab. A short
      post-insert guard catches React replacing the editing host and reinserts once into the
      new empty composer. The ACK journal gate still holds replacement-chat observations until
      the A→B continuation commit. Regression deliberately leaves `status` unresolved and
      proves redeem → insert → send/ACK happens anyway.

- [x] **T-158 — Compact & Resume handoffs were biased toward short summaries. FIXED to the
      user's requested policy.** `HANDOFF_BRIEF_RULES` makes user messages the highest
      authority, preserves material user substance aggressively, centres current state,
      completed/verified work, planned/decided work and failed/unresolved work, and explicitly
      aims for roughly **10,000–30,000 tokens when the session warrants it, never above
      30,000**. A regression pins the authority language, range, ceiling and required state
      sections.

- [~] **T-159 — live installed 1.7.8 `agents` calls can currently surface a transport-level
      `ExceptionGroup: unhandled errors in a TaskGroup (1 sub-exception)`.** Reproduced in this
      pass on both `agents spawn` and `agents status`. The current source's real MCP endpoint,
      agent broker, bridge, swarm and resume suites are green, so there is no matching
      source-level handler failure left to patch blindly; this may be the already-installed
      binary / cached connector surface that this unreleased source replaces. **Do not call it
      fixed until a later installed 1.7.9 smoke proves `spawn → message both ways → status →
      finish` over the real connector.** The user's current instruction explicitly forbids
      installing this build, so that smoke is intentionally deferred rather than faked.

**1.7.9 source verification before packaging:** `npm run verify` clean on 2026-08-18:
**939 passed / 1 skipped / 0 failed across 27 test files**, with TypeScript clean first.
Targeted agent/bridge/resume/swarm/ipc group: **124/124**. Targeted MCP/workspace/session/content
group: **398/398**. The two `HTMLFormElement.requestSubmit()` stderr lines remain jsdom
limitations in passing fixtures, not product failures.

**1.7.9 package, deliberately not installed per user instruction:**
- Installer: `release/ChatGPT-Local-Files-Setup-1.7.9.exe` — **135,041,899 bytes** — SHA-256
  `0694DBE66A6F15223F5B93290C8C83AF0BBCB14E0A40D014A04248F397188AD7`.
- Blockmap: `release/ChatGPT-Local-Files-Setup-1.7.9.exe.blockmap`.
- Unpacked executable reports file version `1.7.9`, product version `1.7.9.0`.
- Packaged `resources/extension/manifest.json` reports `1.7.9` and matches the source
  manifest byte-for-byte; packaged `resources/extension/content.js` also matches source
  byte-for-byte.
- The existing 1.7.8 installer remains alongside 1.7.9 and was not overwritten or removed.
- No installer was launched, no installed application was replaced, and no unpacked Chrome
  extension was reloaded. T-159 therefore remains explicitly pending a later installed-build
  smoke instead of being marked fixed from source tests alone.

---

## v1.7.8 — attribution blackout / worker identity timing / exec_command paths — **INSTALLED**

Three defects, all found against the real connector on 2026-08-18 and all fixed here.

- **A request id vetoed every other grade of evidence.** `claimNamedCall`, `pickTarget`,
  `freshCallOrigin` and `awaitFreshCallOrigin` treated "ChatGPT sent an `x-request-id`" as
  "only the id may answer". Right while the join works and one page mate is late; wrong when
  the browser reports no ids at all, which makes the join a blackout that fails every call
  from every chat forever. Session `2026-08-18-0a7bf7bb` is the proof: 104 calls, no
  messages, nothing placed. The veto now applies only while `requestIdJoinAvailable()` —
  some conversation is demonstrably reporting ids. Contradictory evidence still fails closed.
- **The identity window was shorter than a fresh worker tab.** `PRIME_EVIDENCE_MS` was
  2.5 s; worker-1's first `agents` call was refused `WORKER_IDENTITY_LOST` at 16:33:56 after
  2540 ms while its own page evidence landed at 16:34:04. Calls carrying a request id now
  wait `IDENTITY_EVIDENCE_MS` (15 s), and the recorder waits `REQUEST_ID_GRACE_MS` (15 s)
  off the response path. Both are event-driven, so a prompt page pays nothing.
- **`exec_command` translated `cwd` and not `cmd`.** Every instruction says paths are
  virtual, so the model wrote `/totec/whatsapp-ai-bridge/...` inside the command and
  PowerShell read the leading slash as the current drive's root. `strayVirtualPath()` now
  refuses a `/root/...` written inside `cmd` and names the fix (set `cwd`, write relative);
  the tool description and the connector instructions state the exception outright. `cmd`
  is never rewritten — quoting, regexes and URLs cannot survive a guess.

---

## v1.7.7 — call identity / resume / worker lifecycle / MCP result handling — **INSTALLED**

This batch was found against the real ChatGPT connector on 2026-08-18. The distinction in
this section is intentional: **only defects in Local Files handling are called bugs.** A
schema refusal for malformed arguments, stale patch context, a shell syntax error, or a real
test/build failure correctly returned by a tool is not an MCP reliability failure.

- [x] **T-146 — prime MCP calls could be authenticated and recorded as worker-1. FIXED.**
      Live proof was stronger than a UI symptom: a prime `agents action=message` returned
      `An agent cannot message itself`; another prime control call returned
      `WORKER_IDENTITY_LOST`; several Core calls made by prime appeared in worker-1's local
      session. The app already had ChatGPT's deterministic join key but still fell back to
      timing evidence while the exact page observation was late. The join is now authoritative:
      inbound `x-request-id: wfr_…/<hop>` is reduced to `wfr_…` and matched to the same
      `metadata.request_id` reported from one concrete conversation. When an HTTP request id
      exists there is **no same-tool / sole-generation heuristic fallback**: zero matches wait
      then fail closed; matches in two conversations fail closed. `claimNamedCall` also uses
      request-id + tool so one ChatGPT request containing several connector calls still files
      each call correctly. Fiber results are epoch/conversation guarded so an async scan from
      chat A cannot arrive after SPA navigation and become evidence for chat B; ChatGPT
      `create_time` prevents a reload from making historical request evidence fresh again.
      Regressions cover late exact evidence, an unmatched id staying Unattributed, duplicate
      ids across conversations, and prime-vs-worker simultaneous `agents` calls.

- [x] **T-147 — Compact & Resume could create a three-event shadow `Resumed · …` session
      before the real session moved. FIXED.** Fresh chat B could submit the pasted handoff,
      acquire its conversation id, and post `/events` before `/commands/ack` committed the
      continuation A→B. `sessionForConversation(B)` then created a durable B session; the ACK
      subsequently rebound the original A session to B, leaving two local sessions for one
      ChatGPT chat and making restart lookup nondeterministic. App-opened chats now quarantine
      observations while their opening command is unacknowledged. The order is strict:
      submit bootstrap → learn B id → ACK/commit A→B → release B observations into the already
      rebound session. Regression deliberately blocks the ACK, forces an observation flush,
      asserts zero `/events` escape, then releases the ACK and asserts the queued observation
      appends normally. Desired invariant: one stable local session id, old timeline preserved,
      `chatIds` extended with B, new messages/tool calls appended.

- [x] **T-148 — closing a worker chat did not release its slot. FIXED.** The extension's
      service worker already sends `/closed` only after the final real tab for an exact
      conversation is gone and does not treat reload as close. The bridge handled that event
      only for the prime, so a bound worker could remain `active` forever and be restored from
      the durable swarm snapshot after restart. `workerConversationGone()` now terminalises
      that exact unfinished worker, persists the failure, frees the configured live-worker
      slot, and queues a report for prime. Bridge `/closed` dispatches prime first, otherwise
      worker. Regression closes an active worker conversation and asserts failed state + free
      slot + prime notification.

- [x] **T-149 — stopped/interrupted output could become a duplicate final and even a synthetic
      `completed` turn. FIXED.** `finishGeneration()` used to call `reportMessages(false)` for
      every terminal outcome, so partial stopped prose could be emitted as
      `assistant_message final:true`. A React remount could give the same partial prose a new
      DOM/message id; recorder dedup by `(messageId,text)` then stored it twice. Worse, if the
      explicit interrupted `turn_end` was lost across detach/reload, recovery treated that
      `final:true` as proof of completion and synthesized `turn_end outcome:'completed'`.
      Stopped/interrupted turns no longer publish a final answer; completed local generations
      use the unique `g-…` generation identity and recorder stores at most one final per such
      generation even after remount. Regression pins both the stopped-no-final behavior and
      one-final-per-generation invariant.

- [x] **T-150 — failed shell commands were internally recorded as successful MCP calls.
      FIXED for 1.7.7.** This pass's own history exposed it: `exec_command` calls that really
      exited 1 (including the deliberately wrong Windows PowerShell `&&` command and an early
      failing verify run) were displayed as `(ok) … exit 1`. `noteExec()` correctly set the
      call outcome to `error`, but the outer `guard()` later saw a normal ToolResult and wrote
      `ok` over it. `noteOutcome()` now has monotonic severity (`error > rejected > ok`), so a
      wrapper can never downgrade a more specific tool outcome. A normal `write_stdin` poll
      now uses `noteExec()` too, so a long-running command that exits non-zero between the
      initial `exec_command` and its continuation is also recorded as failed. Explicit
      `signal=kill` / Ctrl-C remain successful control actions and intentionally use process
      evidence without converting the requested stop into a tool failure. This changes local
      history/UI/compaction semantics only; non-zero shell exit is still returned as ordinary
      command output rather than a transport-level MCP exception.

- [x] **T-151 — MCP SDK request-context shape had drifted; the standard header path was dead.
      FIXED for 1.7.7.** Current `@modelcontextprotocol/server` exposes the original HTTP
      request as `ServerContext.http.req` and the JSON-RPC request under `mcpReq`. Local Files
      still typed a private `http.headers` shape that current SDK handlers do not provide, so
      request identity worked only because `mcp/inbound.ts` separately carried the raw Node
      header through `AsyncLocalStorage`. `kernel.ts` now types the callback from the SDK's
      real `ServerContext` and reads `http.req.headers.get('x-request-id')` first, keeping the
      raw inbound carrier only as compatibility fallback for older/odd hosts. This removes a
      silent dependency on an obsolete context shape without weakening the proven
      request-id→conversation join.

### Explicitly **not** MCP faults in this 1.7.7 pass

The following calls failed/refused exactly as they should and must not be counted in tool
reliability metrics: an `apply_patch` whose expected import context was stale; a Windows
PowerShell command using unsupported `&&`; the first `npm run verify` after source edits,
which reported real TypeScript test-fixture errors; and a call that asked for `max_lines: 260`
although the published schema caps it at 200. They are caller/source mistakes with useful,
correct tool responses. The external ChatGPT connector has also been observed to lose a tool
result after Local Files executed successfully; that is a host/delivery limitation rather
than proof of a Local Files execution fault. Local mutation flows therefore remain designed
to be retry-safe where semantics allow it (`finish`, continuation capture/commit, command
ACKs), but Local Files must not silently deduplicate two genuinely separate model-issued
mutations merely because their arguments happen to match.

**1.7.7 source verification before packaging:** `npm run verify` clean on 2026-08-18:
**929 passed / 1 skipped / 0 failed across 27 test files**, with TypeScript clean first.
The two `HTMLFormElement.requestSubmit()` stderr lines are jsdom limitations in passing
content-script fixtures, not product failures. `git diff --check` is clean apart from Git's
normal CRLF conversion warnings on this Windows working tree.

**Installed-build smoke:** after relaunching 1.7.7, a deliberate `exec_command` `exit 7`
was returned to the model as ordinary shell output as designed, while the local session
record correctly stored the call as `exec_command (error) … exit 7`. That directly verifies
T-150 in the packaged/running binary rather than only in unit tests.

**Correction to the record:** this file previously said "Installed build: v1.6.0" and
"v1.7.0 assembled, not installed". That was wrong — the installed executable was already
`1.7.0`, dated `19:38`, i.e. the *stale* 1.7.0 built before the T-93 – T-100 batch. Anything
observed on this machine before 23:02 was observed against a build without the paint gate,
the generation-identity mapping or the banner-attribution fix, and does not count as
evidence for or against them.

**The Chrome extension is a separate, manual step.** Installing the app updates
`resources/extension` on disk; it cannot reload an already-loaded unpacked extension.
Before T-91: `chrome://extensions` → reload ChatGPT Local Files, then hard-reload the
ChatGPT tab, or the page keeps running the old `content.js` and the smoke tests nothing.

**Previous release for reference:** v1.6.0,
SHA-256 `F4E396A339B45556BA69C63BB3A02719BFFF23CB70976ED6245613711A7292D1`.

---

## P0 — agent identity and bootstrap rebuild — **CODE DONE 2026-08-18, LIVE SMOKE OPEN**

The rework Tobias specified: conversation-bound worker identity, `join` as recovery only,
the task itself as the bootstrap, no persistent `agent_key` anywhere, native Compact &
Resume only, and no interval-driven agent lifecycle on either side of the bridge. Green at
this point: typecheck clean, **913 passed / 1 skipped / 0 failed** (27 files).

What the model-facing surface now is, in one paragraph, because several older items below
were written against the surface it replaced. An agent *is* the ChatGPT conversation it runs
in. The prime is bound from the chat that spawned. A worker is the chat the app opened for
its slot, bound by the extension's report *before the model there reads anything* — binding
is the lifecycle transition, so an app-created worker chat is already an active worker with
no join, no key, and nothing typed by the model. Ordinary file/command calls that cannot be
placed get no agent and are **not** refused, so phones and unrelated chats keep working;
`agents` control calls that cannot be placed are refused with `WORKER_IDENTITY_LOST`.
`join_key` is the only credential left, is minted for the *user* on an explicit click, is
spent on use, and cannot move a binding that already exists.

### Closed by this rework

- [x] **T-27** **Tab storm.** Structurally gone rather than mitigated. The extension no
      longer opens tabs at all: the app opens exactly one chat inside the same transaction
      that creates the command, and the `chrome.alarms` recovery tick that reopened tabs for
      commands it thought unopened is deleted along with the `alarms` permission, the
      persisted `opened` list, `openMarked`/`markerUrl`, and `GET /commands`. Covered by
      *opens no tabs and holds no alarm of its own* and *one worker chat at a time*.
- [x] **T-28** **`join_agent` lands in Unattributed.** The path that produced this is not on
      the normal route any more — a worker never joins, so "cannot safely identify this agent
      chat" cannot happen during startup. The identification code it was about survives as
      recovery and as control-call routing, and is covered adversarially in
      `test/swarm.test.ts` and over the wire in `test/agents.test.ts`. The browser-level
      regression T-28 asked for is **still owed** and is folded into the live smoke below.
- [x] **T-29** (second half) **`active` as proof of health.** No longer meaningful: `active`
      now means *the extension reported this conversation*, which is evidence from the page
      rather than from a key the worker might never have received. There is no key to lose,
      so there is no zombie state to recover from.
- [x] **T-64** **Targeted wake into an existing worker chat.** Superseded and deliberately
      not built. `revive` is deleted; every command opens a chat that does not exist yet, and
      a marker that lands in a conversation that already exists types nothing and does not
      even redeem. Reviving into an existing chat is the thing the design now forbids.
- [x] **T-65** **Delivery evidence beyond "the next authenticated call".** Binding *is* the
      completion boundary: the ack retires a worker command only when the worker is no longer
      a pending spawn, and drops it otherwise with "the chat this app opened for it never said
      which conversation it was".
- [x] **T-81** **Agent↔conversation binding must not be last-writer-wins.** `bindConversation`
      binds once and refuses to move, refuses a conversation another agent holds, and refuses
      an agent that has ended. Four tests in `test/swarm.test.ts` pin this down.

### Superseded — read the newer decision, not the older entry

- [x] **T-92** **OpenRouter/Flash as an explicit fallback.** Overtaken by Tobias's later
      instruction: native Compact & Resume *only*. The whole external-compaction path is
      deleted — `src/main/openrouter.ts`, `test/openrouter.test.ts`, `session/compact.ts` and
      `HANDOFF_SYSTEM_PROMPT` are gone, so there is no provider choice left to preserve, no
      silent substitution to forbid, and no provider half of T-115 to configure. Auto Compact
      as a *threshold* question is untouched by this and stays where T-115 left it.
- [~] **T-30** **Resume bootstrap gives up after four attempts.** The retry ladder it
      describes no longer exists: the page gets one attempt and reports a definitive
      `failed`, because the in-page retries were a clock the design does not allow and a
      failure the page reports is a failure the app must believe. The *underlying* complaint
      — ChatGPT refusing a large composer insert — is unaddressed and stays open under T-18.

### Consequences to carry, not bugs to fix quietly

- [ ] **T-130** The desktop window can no longer *start* a compaction. The Compaction view is
      a read-only Handoff view and the header lost `resumeBtn`/`cancelCompact`, because the
      chat writes its own handoff now and a second starter would be a second writer. Decide
      whether the window should regain a "start a handoff in the connected chat" button, or
      whether the view should say plainly that this is done from the chat.
- [ ] **T-131** `adoptedProseId` double-transcription is proven in jsdom only. It needs one
      live pass against a real ChatGPT turn before it counts as verified.
- [x] **T-132 — README tool table and tool sections rewritten, 2026-08-18.** The table is
      now capability → *current* tool (`read`, `find`, `apply_patch`, `exec_command`,
      `write_stdin`, `observe`, `computer`, `session`, `agents`), the `edit_file` /
      `write_binary_file` / `screenshot` paragraphs were replaced with `apply_patch` and
      `observe` ones, and "Running commands" no longer describes `run_powershell`,
      `run_command`, `launch_app`, `inspect_repo` or `process`. Two claims were corrected
      rather than carried over: `list_roots` is gone (roots live in the server
      instructions), and "commands run only in an approved folder" now says what is true —
      the `cwd` is checked against the approved roots, the command itself is not confined
      to them. A one-line note about the Core/Desktop split was added, pointing at
      `docs/tool-surface.md`.
- [ ] **T-137** README's **Connecting it to ChatGPT** section still describes creating *one*
      app in ChatGPT, but `server.ts` publishes one URL per surface (`/mcp/core/…` and
      `/mcp/desktop/…`, each with its own token) and `usefulSurfaces()` decides which are
      worth connecting. A user following the README connects Core and never learns Desktop
      exists. Exposed by the T-132 rewrite, which deliberately did not widen into it: the
      fix has to match the Setup tab's live wording, which needs the running app in front
      of you rather than a source read.

### Found by the live smoke — 2026-08-18

- [x] **T-138 — the identity window discarded the evidence that named the caller.** Every
      `agents action=spawn` from a real chat was refused with `UNIDENTIFIED_CALLER` (three
      attempts, ~2.6 s each). Instrumented live: the page's named `tool_evidence` for the
      right conversation reached the app **5.5 s before the call started**
      (`stamped=1787052368708`, call `after=1787052374249`), relay lag only 2 ms — ChatGPT
      paints the connector row while it is still composing the request. `freshCallOrigin`
      and `awaitFreshCallOrigin` required `call.at >= after`, so the one piece of evidence
      that named the caller was thrown away and the 2.5 s deadline expired. `claimNamedCall`
      already allowed a 20 s lead; the identity path never did. Fixed in `recorder.ts` with
      `namedOrigins()`, which reads the same `SIGHTING_LEAD_MS` window and relies on
      `!call.claimed` so an older call cannot vouch for a later one. **Live-verified**: the
      same spawn now logs `verdict=named waitedMs=0` and `tool agents ok in 13 ms`, and the
      chat became prime of run `b9fccb54`.
- [x] **T-139 — every short-tasked worker failed to start.** With the spawn working, both
      workers of the first run died at once: *"the browser could not start the chat —
      ChatGPT replaced the composer while inserting the bootstrap"*. The insert had actually
      worked. `deliverCommand` verified it by looking for `boot.text.slice(0, 80)` inside
      `composer.textContent`, but the composer is a rich-text editor: the blank line between
      the task and the wrapper becomes a paragraph break, and `textContent` stitches the
      paragraphs back with no separator, so the newline is simply gone. Any task short
      enough to leave that blank line inside the first 80 characters could never match — and
      the failure retired the worker slot before the chat said a word. Fixed by comparing
      with whitespace squeezed out of both sides. The suite stayed green through this
      because the jsdom fake for `execCommand` appended text verbatim; it now models
      paragraphs, and a regression covers a worker bootstrap with a short task.

- [ ] **T-141 — the extension Chrome actually loads is the packaged copy, not `extension/`.**
      The app points *Load unpacked* at `resources/extension` inside the installed build
      (`extraResources` in `electron-builder.yml`, and `extension-path.ts` depends on it),
      so a machine set up the normal way is running
      `release/win-unpacked/resources/extension` — Chrome's own Secure Preferences names
      that path. During this smoke that made a fixed `content.js` invisible: pressing Reload
      on chrome://extensions re-read the stale packaged copy, both workers failed again with
      the T-139 message, and the fix looked wrong when it had simply never been loaded.
      Worth one line in the contributing/testing notes, and worth asking whether the dev
      flow should point Chrome at `extension/` instead — every future extension fix has this
      trap in front of it.

- [x] **T-142 — concurrent workers cannot be told apart by the identity window. FIXED, LIVE VERIFIED.**
      Live run `f2507104`: both workers bootstrap and bind (`6a844601…`, `6a844606…`), then
      their near-simultaneous `agents` calls are both refused `WORKER_IDENTITY_LOST`, because
      `namedOrigins` sees *both* workers' `agents` evidence inside `SIGHTING_LEAD_MS` and
      returns named-ambiguous (worker evidence @1787053585194 and @1787053589194; the first
      server check `after=1787053591624` sees both). Reproduced again in run `f5159b6f`: the
      prime chat's own `agents action=status` and worker-2's `message` to prime were both
      refused the same way, and one checkpoint labelled worker-2 carried worker-1's
      `package.json` result — the same ambiguity mislabelling a result rather than refusing.

      **Fix, and it is deterministic rather than a timing heuristic.** ChatGPT sends
      `x-request-id: wfr_<id>/<suffix>` on the connector's HTTP request and holds
      `metadata.request_id = wfr_<id>` on the same request inside its own message model —
      measured live, identical halves: inbound `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`
      against page evidence `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`. `fiber.js` now
      carries `request_id` and `create_time` per call, `bridge.ts` validates them,
      `kernel.ts` reads the header off `mcpCtx.http.headers`, and `recorder.ts`
      `joinByRequestId()` is consulted *before* any window logic. The ordering fallback
      (`reserveNamedOrigin`, `ORDER_MARGIN_MS`, `issuedAt`) is kept only for evidence with no
      request id, and is a deletion candidate now that the join is live-verified.

      **The wiring that was missing, and the measurement that found it.** The header is on
      the socket but *not* in the MCP call context: live, `mcpCtx.http.headers` is null while
      `x-request-id` is plainly on the request. So the first build of the join never matched
      and the smoke still read `verdict=named-ambiguous` with the two ids sitting there
      identical. `mcp/inbound.ts` now carries the id from the surface's HTTP handler to the
      tool dispatch in an `AsyncLocalStorage`, and `claimNamedCall` honours it too, so the
      call is *filed* into the chat that issued it rather than only identified — which is
      what the cross-worker mislabelling above was.

      **Live, run `1895f9bf`:** `verdict=joined` on the spawn
      (`req=wfr_01a014ccf3da71bd828f7c0dee9d11c1`, matched against that conversation's own
      evidence), both workers bound, and worker-1's `agents` call resolved `joined` while
      worker-2's evidence sat in the same window — the exact shape that was
      `named-ambiguous` minutes earlier. Regression: "places simultaneous same-tool calls
      from two chats by the request id ChatGPT sent" in `test/session.test.ts`.

- [x] **T-143 — one growing caption is recorded twice when ChatGPT re-stamps it. FIXED.**
      Live in worker-2 of the run at 14:02: `#a0` held
      "I'm checking the README directly and will report only the heading" and `#p0` then
      held that same sentence plus "plus a one-sentence project description." — two rows in
      the Chat timeline for one sentence, the first frozen at its prefix. Mechanism: ChatGPT
      mounts the sentence as an assistant `.markdown` block, then wraps it in the reasoning
      container and *replaces* the node, so `adoptedProseId` has no surviving stamp to
      inherit from and the caption is re-stamped mid-turn. Fixed in `recorder.ts` by
      deriving identity from the text as well: a snapshot that begins with the whole of the
      caption the turn is currently growing is aliased onto that caption's id
      (`continuedItem`/`progressAlias`). This is the live case T-131 asked for. Regression:
      "keeps one caption when ChatGPT re-stamps it mid-sentence" — it reports two ids
      without the fix.

- [x] **T-144 — an app-authored message was drawn below the whole turn it happened in. FIXED.**
      Live: prime's message to worker-1 is stamped `1787057617031`, three milliseconds after
      the `read` above it, and the Chat panel drew it *below* a refusal that happened 32
      seconds later. `chronological()` groups events by turn, anchored at the turn's
      `turn_start` seq, and an `agent_message` carries no `turnId` — the app is not the page
      and has no generation id — so it became its own group anchored at its own seq, behind
      everything. Turn-less app events are now placed by time into the turn that was open
      when they happened, and keep their appended position if that turn had already ended.
      Two regressions in `test/chronology.test.ts`; the first fails without the fix.

- [x] **T-145 — "the only chat generating" survived the browser being closed. FIXED.**
      Same session: Chrome was shut down mid-run, the worker's turn carried on server-side at
      ChatGPT, and its next `agents` call — correctly refused `WORKER_IDENTITY_LOST`, since
      identity is proven from a page that no longer exists — was still *filed* into worker-1
      as "placed by the only chat generating". That grade is a statement about now, produced
      here entirely from memory nothing could refresh. `claimGeneration`,
      `soleGeneratingConversation` and `browserCouldReport` now require the conversation to
      have reported within `LIVE_REPORT_TTL_MS` (20 s); the extension reports every few
      seconds while a turn runs, so anything older is a page that has stopped talking to us.

      Worth keeping in view rather than closing over: with the browser gone a run cannot be
      controlled at all, while its workers' turns keep running blind at ChatGPT. The refusal
      is right, and the situation is still a hole in the story.

- [ ] **T-140 — a failed bootstrap leaves its own text in the composer, and it persists.**
      Found while cleaning up after T-139: the abandoned worker-2 bootstrap was still
      sitting in the *New chat* composer afterwards, restored from ChatGPT's own draft
      storage in a completely different tab, and had to be deleted by hand before the smoke
      could go on. Two consequences. The user finds a wall of agent instructions in the box
      they were about to type into, in a tab they never saw opened. And the next bootstrap
      to land on that composer is refused with *"the composer already holds something the
      user was writing"* — a false positive that turns one failure into every later one
      failing too. `deliverCommand` should take back exactly what it inserted before it
      reports `failed`, and only what it inserted: a draft that was already there stays,
      because refusing to overwrite that is the rule this must not break.

### Live smoke still owed for this rework — nothing below is verified

- [ ] **T-133** One press, one chat. Turn multi-agent on, spawn two workers, and confirm the
      sidebar gets exactly two new chats, each carrying its task as the literal first user
      message, with no "New chat" spinners and no third tab.
- [ ] **T-134** A worker acts with no startup of its own: its first `agents` call routes to
      the right worker, `message` reaches the prime, `finish` is terminal, and a second
      `finish` is answered as a repeat.
- [ ] **T-135** Recovery, end to end: kill the extension's report (or close the tab before it
      binds), take the one-time key from the worker row's key button, paste it into the chat,
      and confirm the worker starts, the key is spent, and a replay from another tab is
      refused. This is also the browser-level regression T-28 asked for.
- [~] **T-136** Identity loss is honest: an unrelated chat gets `AGENTS_BUSY` and learns
      nothing about the run, a control call with no page evidence gets `WORKER_IDENTITY_LOST`
      and a pointer to recovery, and an ordinary `read` from a phone still works.
      **First half verified live 2026-08-18:** while run `19beca0e` was owned by
      conversation `6a844c43`, a spawn from an unrelated chat was refused `AGENTS_BUSY`
      with nothing about the run in the message. The other two halves are still open.

---

## P0 — turn lifecycle, reload split and sequential-call attribution — **CODE DONE 2026-08-17, LIVE SMOKE OPEN**

Three coupled defects, each measured in real session logs rather than inferred, each fixed
and pinned by regressions. `npm run verify` is green at **839 passed / 1 skipped** (24 files).
**Not packaged or released.**

- [~] **T-123 — a missing stop button was read as a finished turn.** `CLF_DOM.generating()` is
      `document.querySelector(STOP) !== null`, and `observe()` ended the turn on the first
      sample that missed it. ChatGPT unmounts that button across tool phases, streaming
      reconnects and plain rerenders. Session `2026-08-17-d1354db2`: `turn_start` seq 342 →
      `turn_end` seq 343 **432 ms later**, `outcome:"unknown"`, run reopened at seq 347 under a
      new generation; same shape at 357/358/360 across a 2.7 s gap, and at 249/251. `unknown`
      is the signature — endOutcome() found no answer, no error, no stall, because nothing had
      ended. The damage lands in the app: `turn_end` clears `turnStartedAt`, the pending
      sightings and the named-call evidence, so **54** of that session's own connector calls
      graded `inferred` into `2026-08-17-09ab937b` ("Unattributed activity"), the first of them
      194 ms after the premature end. Fixed with a continuous-absence settle window
      (`TURN_SETTLE_MS = 4000`) measured on the clock — *not* counted in observations, because
      `watchTranscript()` also drives `observe()` from a MutationObserver microtask and the
      rerender that unmounts the button is itself a burst of mutations. A pending local tool
      extends the window up to `TURN_SETTLE_MAX_MS`; an explicit user stop still closes at
      once; the outcome is captured on the first quiet observation so a banner dismissed
      mid-window cannot downgrade a failed turn. **Open:** live smoke.

- [~] **T-124 — reloading mid-turn split one assistant run in two.** `RUN_ID` is a random
      per-document namespace, so a reloaded content script cannot reconstruct the id the
      previous document was using; it saw a stop button, found no generation of its own and
      opened a second one (session `2026-08-17-d1354db2` seq 367/368). The app holds the
      durable half of that identity, so `liveConversations()` and `/activity` now expose
      `activeTurnId` and `resumeOpenTurn()` restores that generation — binding `/c/<id>` first,
      before any observation can be journalled unbound — with no second `turn_start`. It
      restores it whether or not the stop button is visible at that instant, because a page
      caught mid-render and a page that finished during the reload gap are indistinguishable
      from one sample; the ordinary settle window then decides, so a turn that really did end
      closes exactly once under the resumed id and one that was only flickering carries on.
      Progress/prose `#p` and `#a` identities stay stable across the reload as a result.
      **Open:** live smoke.

- [~] **T-125 — sequential calls declared each other contested.** A call reaches the recorder
      only after its tool finished, then waits up to `SIGHTING_GRACE_MS` (5 s) for the page.
      `contested` was `claiming.size > 1`, so an ordinary burst of *sequential* calls had all
      its attribution waits open at once and every call vetoed every other one — which disables
      `claimGeneration()` outright, the only grade a turn has when ChatGPT draws no row.
      Session `2026-08-17-09ab937b` shows runs 2.8 s and 3.9 s apart, all `inferred`, while the
      chat was demonstrably mid-turn. Now measured as real execution overlap on half-open
      `[startedAt, startedAt+durationMs)` intervals with no slack — both endpoints are stamped
      by this process, so there is no clock to reconcile — plus `shortEvidence()`, which keeps
      a rendered block that cannot answer for every waiting call ambiguous. The cross-device
      refusal ("never lets one contested block fall to whichever call gives up last") is
      unchanged and still passes. **Open:** re-measure Unattributed against a real session.

- [~] **T-126 — a tool call rendered after the commentary it ran underneath.** The recorder
      appends a call only once its tool has finished and attribution has resolved, so its `seq`
      is later than everything the page observed while it was running — but its `time` is
      `startedAt`. Reading by `seq` therefore shows the call below its own commentary, and a
      slow call below the `turn_end` of the turn that made it (`2026-08-17-d1354db2` seq 390,
      stamped 1.4 s *before* the `turn_start` above it). The desktop rendered raw `seq`; the
      injected page stream sorted the whole feed by `time`, which is worse — reload backfill
      carries observation time, so historical answers were being dragged into the live turn.
      Now one contract in `src/shared/chronology.ts`, mirrored in `content.js` and pinned
      against it by test: reordering happens only *inside* a turn this feed opened, boundaries
      keep their place, and everything else stays at its `seq`. `seq` remains the identity and
      cursor key — a row can be seq 500 and still render between seq 2 and 3 of its own turn.
      `streamTurnGroups()` now indexes turns by durable id instead of walking a pointer at the
      newest one, so a call delivered after the next turn opened goes back to the turn that
      made it, and an event this feed cannot name joins no turn at all rather than being
      guessed into the live one. **Open:** live confirmation that the two views agree.

- [~] **T-127 — current live chat still loses its own tool calls between extension turn
      lifecycle and MCP attribution. CODE FIXED 2026-08-17, LIVE SMOKE OPEN.** The
      2026-08-17 live session `2026-08-17-7463fb07` gives a clean
      reproducer that separates two different failures which currently look identical in the
      UI:

      1. **Conversation-owned but turn-unowned.** Seq 3 starts local generation
         `g-1q3xmfmf85xkw-1-1`; seq 6 records `turn_end: unknown` at 19:00:37; the first Core
         MCP call does not start until 19:00:40. Seq 7-11 are therefore written into the
         correct conversation session, but have no `turnId`. The extension renderer's
         `streamTurnGroups()` currently refuses every event it cannot join by durable turn id,
         so those successful calls disappear from the overwritten ChatGPT turn even though the
         app recorded them. This is a **presentation/lifecycle mismatch**, not an MCP execution
         failure. The immediate extension-only fix may place same-conversation `tool_call`
         events with `turnId:null` into the surrounding recorded turn by their `startedAt`
         window without rewriting the underlying event.

      2. **Truly unattributed.** After the extension has already closed the generation, later
         successful calls are written to `Unattributed activity` session
         `2026-08-17-eceb1519` with `attribution:"inferred"` and no turn id. Examples from this
         same chat include `session`, `exec_command`, `read` and `apply_patch` calls made while
         this browser conversation was visibly still continuing. This is an **attribution
         failure**, not a failed MCP call: the tools returned valid results, but the recorder
         could no longer prove which conversation issued them.

      **Root cause confirmed:** the extension was declaring `turn_end: unknown`
      when ChatGPT temporarily removes the stop/generation control while entering a connector
      tool phase. Once that happens `liveConversations()` no longer has an open local turn to
      bind subsequent calls to. The MCP connector request itself carries no ChatGPT
      conversation id, so the recorder intentionally refuses to guess and falls back to the
      unattributed session. In other words, the missing caller id is a protocol limitation,
      but the trigger in this run was the extension closing a still-live generation too early.

      **Source repair in this pass:** `content.js` no longer treats an unexplained missing STOP
      control as proof the turn ended. It emits an ephemeral `turn_state(active:false)` instead
      and keeps the durable local `g-...` generation open. `recorder.ts` keeps that distinction:
      strong named/page evidence may still place a call on the open generation, while weak
      `claimGeneration()` and workspace fallback are disabled until direct generation evidence
      returns. This preserves the cross-device refusal rather than making `pickTarget()` guess.
      A real new user message is now a hard turn boundary even when the old STOP disappeared
      and the new STOP appeared between two observations. Tool/progress rows continue to be
      scanned while the local generation is open even through a STOP dropout. Process-global
      `/activity.pendingTools` no longer decides an ordinary browser turn's lifetime; it remains
      available to compaction's process-settling path, where process-global state is actually
      what is wanted.

      Fiber call evidence is also prevented from smuggling ChatGPT's recycled
      `data-turn-id` into the durable recorder id. Only the newest Fiber turn matching the
      currently bound assistant generation receives the local `g-...` id; historical/reused
      matches still prove the conversation made the call but carry no durable turn id.

      Regressions cover: indefinite unknown STOP dropout without `turn_end`; user-message
      boundary both with and without a quiet observation; tool rows arriving during dropout;
      foreign/global pending tools not holding a completed turn; `turn_state` withdrawing and
      restoring weak generation identity; named evidence retaining the durable turn while the
      stop signal is quiet; and two Fiber turns reusing one page id without leaking that id into
      recorder evidence. **Not installed or live-smoked by explicit user instruction.**

      **Acceptance:** one ordinary chat can move commentary -> Core tool -> commentary -> Core
      tool repeatedly without any premature `turn_end`; all calls remain in the conversation
      with the correct local generation; sending a new user message or refreshing cannot move
      prior calls to Unattributed; genuinely cross-device/ambiguous calls must still refuse
      attribution rather than being guessed.

- [ ] **T-128 — tool-surface failures observed during the 2026-08-17 extension pass must stay
      distinguishable from MCP/product bugs.** These all happened while investigating T-127:

      - `apply_patch` rejected a patch containing an empty `TODO.md` update with
        `PATCH_INVALID: Update File TODO.md: empty hunk`. **Not MCP fault:** invalid patch text;
        validation correctly prevented partial changes.
      - A second `apply_patch` rejected a multi-file patch because the expected
        `test/extension.test.ts` context did not match. **Not MCP fault:** stale/wrong context;
        atomic validation again prevented partial changes.
      - A later `apply_patch` intended to update `extension/content.js` and
        `test/content-script.test.ts` forgot the second `*** Update File:` header, so the test
        assertion was searched for inside `extension/content.js` and the whole patch was
        rejected. **Not MCP fault:** malformed patch; atomic validation prevented the first
        hunk from landing by itself.
      - `read` rejected `start_line/end_line` with two paths:
        `INVALID_ARGUMENT: start_line/end_line apply to one file...`. **Not MCP fault:** caller
        violated the published schema.
      - One `exec_command` running `rg -n "clf-when|clockText\\(|className = ..."` stayed alive
        with no output until it was force-killed after ~22.5 s. **Unclear / low priority:** the
        process-control path behaved correctly and kill worked; reproduce the exact command
        outside the harness before blaming Core. This looks more like shell/quoting/rg behavior
        than an MCP transport failure.
      - The first targeted `vitest` run exited 1 with 11 failures after the deliberate UI
        changes. Most were stale assertions expecting the old text glyphs/timestamps; one
        exposed that toggling timestamps did not invalidate the stream render signature, and
        one reflected the new decision to render same-conversation `tool_call` events with no
        turn id. **Not MCP fault:** `exec_command` returned the real test failures correctly;
        the implementation/tests needed updating. The corrected run later passed 192/192.
      - One PowerShell search command had mismatched quotes and failed with
        `The string is missing the terminator: ".` **Not MCP fault:** malformed shell input.
      - Another `apply_patch` was rejected with
        `PATCH_INVALID: Update File extension/content.js: empty hunk` while trying to combine
        the stream-signature and test updates. **Not MCP fault:** malformed patch structure;
        no partial change landed.
      - A retry of the targeted tests accidentally requested `max_lines: 220`, above Core's
        published maximum 200, and was rejected at schema validation. **Caller error, not MCP
        execution failure.** The useful error was the single range violation; the giant schema
        dump is the separate harness-noise issue already tracked elsewhere in this file.
      - A combined inspection command (`git status; git diff --stat; git diff ... |
        Select-Object -First 260`) exited 1 after printing the requested diff tail. The repo
        itself was readable and a plain `git status --short` immediately succeeded. Most likely
        the downstream PowerShell truncation closed the pipe while `git diff` was still writing
        (plus CRLF warnings), so treat this as an **inspection pipeline non-zero**, not an MCP
        transport or repository failure, unless the exact command reproduces without the pipe.
      - This ultrathink pass accidentally called `write_stdin` with `max_lines: 240` although
        the schema maximum is 200. The client rejected it before Core ran and again expanded the
        full schema. **Caller argument error; not MCP execution failure.** It is another exact
        reproducer for the external schema-dump problem T-122.
      - Several large `apply_patch` attempts used stale test anchors or accidentally contained
        an empty hunk. They failed with either a context-not-found error or
        `PATCH_INVALID: ... empty hunk`; no partial edit landed. **Caller/stale-patch errors;
        atomic patch validation behaved correctly.**
      - The first post-lifecycle targeted run had 3 failing content-script regressions because
        the tests still encoded the old behavior (`pendingTools == 0` meant end; a silent turn
        was expected to become `unknown`; one fast tool fixture had no final answer). The
        command reported real assertion failures and the fixtures were corrected. **Not MCP.**
      - A later targeted run had 1 failure in the new Fiber-id regression because
        `refreshFiber()` only queues observations and the test read the fake worker before the
        normal observer flush. Adding the real observer tick made the exact test pass. **Test
        harness timing mistake; not MCP.**
      - One typecheck run failed on two real compile errors introduced by this pass: a literal
        `CallEvidence` fixture was missing the new process-state fields and one test tried to
        read `turnId` from the return value rather than from the stored `tool_call` event. Both
        were fixed and typecheck returned clean. **Implementation/test errors; not MCP.**
      - `rg ... test/*.test.ts` failed on Windows because the quoted/native wildcard reached
        ripgrep literally. **Caller shell/platform mistake; not MCP.**
      - The live old connector may still display false huge deltas on edits made during this
        session, because the running app predates the source fix below. That is **expected old
        binary behavior**, not evidence that the new source calculation failed. The user
        explicitly prohibited building/installing/reloading this pass.

      Do not count validation refusals or a deliberately killed child process as "MCP calls
      failed" in reliability metrics. Track separately: **tool execution failure**, **client
      argument error**, **process timeout/hang**, **conversation attribution failure**, and
      **extension presentation omission**.

- [~] **T-129 — success-duration badges can show a technically real but semantically false
      number. CODE FIXED 2026-08-17, LIVE SMOKE OPEN.** The live extension showed chips such as `✓ 655ms` / `✓ 10.0s` that
      read like "the command completed in this time". For `exec_command` that is not always
      what the number means. `tools-core.ts` calls `waitManagedProcess(..., yield_time_ms)` and
      records `result.durationMs` immediately even when `result.running === true`; the tool
      returns a `session_id` and the child keeps running. `summarize.ts` then formats that same
      duration as the green success metric `✓ <duration>`. So a long build can visibly say
      `✓ 10.0s` at the exact moment the response says **Still running**. This is a summary
      semantics bug, not timing corruption and not an MCP transport failure.

      **Source repair:** `CallEvidence` now carries explicit `running` and
      `processSessionId`, with the child/process lifetime kept separately from the MCP call's
      wall latency. `kernel.ts` always records `ToolCallRecord.durationMs` as request/response
      latency; it no longer lets a child lifetime overwrite that field. `exec_command` records
      managed-process state, and every `write_stdin` branch records the state it observed after
      polling, interrupting or killing. A live child summarizes neutrally as
      `Started <command> · running`; only a completed clean exit may get the green
      `Ran <command> · ✓ <duration>` form. Failure semantics remain error/red as before.

      The existing extension suppression of ambiguous old success-duration badges remains a
      compatibility presentation guard for recordings made before these fields existed.
      A future enhancement could fold the later `write_stdin` exit back into the original
      exec row with one stable call id, but that is no longer required to avoid the false
      completion claim in new records.

      **Acceptance:** no UI or session summary may imply a still-running process completed; a
      completed quick command may show a duration only if that duration is explicitly defined;
      long-running commands should transition pending -> exited with one stable call identity.

- [~] **T-130 — `apply_patch` line deltas explode for tiny edits far apart in a large file.
      CODE FIXED 2026-08-17, LIVE SMOKE OPEN.** The screenshot value `~+2818 −2809` was real
      output from the old algorithm, not a CRLF rewrite. `lineDelta()` removed common prefix
      and suffix, then refused an exact LCS whenever the residual block exceeded 1500 lines.
      Two single-line edits thousands of lines apart therefore made the entire unchanged
      middle region look replaced. The large-block path now runs a bounded Myers edit-distance
      pass (`MYERS_EDIT_LIMIT = 512`): sparse big-file changes stay exact at O((N+M)D), while a
      genuinely huge rewrite still hits the cap and is explicitly approximate. Patch hunk
      application also counts its own add/delete markers directly, so it does not need to
      rediscover a sparse edit after the fact.

      A second bug was fixed at the same boundary: repeated `*** Update File:` blocks used to
      sum intermediate deltas, so `one -> two -> three` reported +2/−2 and
      `one -> two -> one` reported a change despite identical final content. Each staged path
      now preserves `originalText` and reports one disk-original -> final delta. Direct MCP
      patch output prefixes the metric with `~` when a true bounded fallback is approximate.
      Regressions cover LF, CRLF preservation, 3,200–4,000 line sparse changes, repeated-block
      replacement, complete undo, and an intentionally giant rewrite that remains approximate.

- [~] **T-131 — worker checkpoints worked, but this chat was not actually the prime.
      CODE FIXED 2026-08-17, LIVE SMOKE OPEN.** Live `agents status` repeatedly said
      `This conversation is not registered as an agent, so this is the run as an observer sees
      it.` Both workers could join, send checkpoints and finish, and their final results were
      durable in `state/swarm.json`; the broken direction was prime identity. A reply attempt
      from this chat was refused with `Workers may only message the prime agent` because the
      initial spawn had created the run before its creating conversation was proven/bound.

      Prime control now prefers exact per-request Fiber evidence (`tool == "agents"`) through
      `awaitFreshCallOrigin()`, with the old fresh generic connector-row proof only as a bounded
      compatibility fallback. Most importantly, the first `agents spawn` may not mutate swarm
      state if neither a conversation nor a transport identity was proven: it refuses and
      creates **zero workers** instead of creating an unreachable/unbound prime. A regression
      drives the complete path: exact Fiber evidence binds the prime, a keyed worker sends a
      checkpoint, the prime proves its next status call and receives that checkpoint in the
      result. Existing worker capability/authentication and ambiguity refusal remain intact.

- [~] **T-132 — old worker session rows inherit the current worker's `joined` badge.
      CODE FIXED 2026-08-17, LIVE SMOKE OPEN.** Worker ids are reusable slots (`worker-1`,
      `worker-2`), so matching a session row to live swarm state by `agentId` alone makes every
      historical `worker-2` look active whenever today's `worker-2` is active. The renderer now
      borrows a live worker badge only when **both** the agent id and exact ChatGPT
      `conversationId` match. A renderer source regression pins the two-key requirement.

**Final source verification for this pass:** `npx tsc --noEmit` clean; full `npx vitest run`
green at **938 passed / 1 skipped / 0 failed across 26 files**. No build, package, installer,
extension reload or app install was run, by explicit user instruction.

**Still needed for the live-facing items above: a later installed live run.** One normal chat, no subagents: every visible
assistant/interim update and every local MCP call exactly once, chronological, no split
generations, nothing of that chat's own in Unattributed, and a mid-turn reload that neither
duplicates nor re-mints. Nothing here is closed by unit tests alone.

## P0 — 1.7 live transcript / recording / compaction blockers — **VERIFIED 2026-08-16**

Release target for this batch is **v1.7.0**. Do not build/install until the three failures
below are fixed together and live-smoked in the real ChatGPT page + desktop Chat panel.
They are coupled: the browser renderer is recording a bad transcript, the attribution
pipeline splits one real chat across two local sessions, and compaction then summarizes an
already incomplete / aggressively collapsed record.

- [~] **T-88 — ChatGPT page splits one assistant update into many duplicate rows and puts
      the synthetic stream at the wrong chronological position. LIVE VERIFIED.** In the
      current chat, one commentary sentence is visibly broken into several CLF rows, with
      prefixes repeated multiple times; earlier commentary/tool activity is grouped near
      the top of the assistant turn instead of remaining where ChatGPT emitted it. A later
      scroll also reproduced the giant blank completed-turn gap / spinner state.

      **Disk proof:** current session `2026-08-16-1ac48a0a`, turn
      `request-WEB:979b98c9-a3b6-43ea-bb74-d8f2c7034868-0`, contains duplicated progress
      snapshots at events #20–25, #35–42, #81–89 and #105–108. Examples include a full
      sentence, then the same prefix again, then its suffix, then a concatenation containing
      the earlier text multiple times. This is stored duplication, not only a CSS problem.

      **Confirmed mechanism:** `content.js::progressDelta()` assumes the current visible
      commentary is a monotonic prefix-extension. ChatGPT re-lays out/reparents the same
      commentary during a turn, so a non-prefix rewrite is returned whole. The new
      `unseenProgress()` only deduplicates exact newline-delimited strings; when the DOM
      snapshot contains duplicated/concatenated prefixes as one changed line, it is still
      considered new and is recorded again. Then `pageOrderedStream()` renders those
      recorded fragments as independent `.clf-stream-row`s. Finally
      `CLF_DOM.turnMount()` returns `{ host: first turn section, before:
      host.firstElementChild }`, so the *entire* reconstructed stream is inserted at the top
      of the assistant section rather than occupying the exact native chronology positions.
      This combination explains both “20 pieces” and “all far too high in the chat.”

      **Required direction:** one logical commentary item must have stable identity and be
      *updated in place while it grows*, not appended as a new event for each DOM snapshot.
      Use the page/Fiber message/activity identity when available; otherwise use a local
      observation id tied to the specific native node/lifecycle. The settled turn must
      restore ChatGPT-native commentary/final prose; synthetic rows should own local tool
      activity, not permanently replace completed native prose. Regression must reproduce
      reparent → shrink → grow → redraw without generating a second logical commentary row.

      **Implemented 2026-08-16 (code complete, awaiting T-91 live smoke).**
      - `chatgpt-dom.js`: new `progressRoots()` (outermost `[data-interrupted]` only) and
        `progressItems()`, which stamps each container with `data-clf-progress-id` so the
        identity survives a reparent and a React clone gets its own id instead of merging.
      - `content.js`: `progressDelta`/`unseenProgress` deleted. `progressUpdates()` reports
        each item's *whole current text* under its id and sends nothing when unchanged.
      - `session.ts`: `progress` events carry `progressId` + `origin`; `foldProgress()`
        collapses a run of snapshots to the newest text at the earliest position. Applied in
        the renderer timeline and in `packSession()`.
      - `recorder.ts::recordProgress()` writes the snapshot at the anchor's time and skips a
        snapshot already contained in what it holds; `bridge.ts` re-emits `/activity`
        progress at `event.origin` so `streamBySeq` updates a row in place.
      - `turnMount()` now anchors the stream at the native commentary box (then the first
        `.markdown`), not at `host.firstElementChild` — which is what put it far too high.
      - `renderStreams()` owns the surface only while the turn is live; a settled turn
        restores native commentary/prose, clears `data-clf-native-hidden`, and keeps only
        the local tool/agent rows.
      - Regressions: `test/content-script.test.ts` — "keeps one row when the page reparents,
        shrinks, grows and redraws the same caption", "hands ChatGPT's own commentary and
        prose back when the turn settles"; `test/session.test.ts` — "folding redrawn
        commentary".

- [~] **T-89 — One real ChatGPT chat is split into the real session plus a constantly
      updating `Unattributed activity` pseudo-chat. LIVE VERIFIED.** With this single active
      work chat, the desktop panel showed both rows updating seconds apart. At verification:
      `2026-08-16-1ac48a0a` = 140 events / 3 user messages / 45 tools / ~16k rough tokens,
      while `2026-08-16-7b63e7e8` = 369 events / 0 user messages / 368 tools / ~206k rough
      tokens. Clicking the latter showed the exact `screenshot`, `computer`, `search_files`,
      `read_file`, `run_powershell`, etc. calls being made for this chat. This is the
      desktop symptom the user describes as every ChatGPT chat becoming two chats.

      **Confirmed mechanism:** `recorder.ts::pickTarget()` intentionally refuses browser
      liveness / a single generating conversation as attribution evidence. Non-agent MCP
      calls are attached only if `claimConversation()` can consume a page connector
      sighting. But the current page frequently omits/groups connector rows, and Fiber has
      already proven one visible row may represent several real calls. Therefore the exact
      DOM pipeline that is known to be incomplete is also the gate deciding whether an MCP
      call belongs to the chat. When it cannot produce one sighting per call,
      `pickTarget()` returns `conversationId: null` and `targetSession()` creates/uses
      `Unattributed activity`. This makes a circular dependency: calls missing from
      ChatGPT's DOM are guaranteed to be missing from the chat's local recording too.

      **Required direction:** stop using *visible row count* as the primary correlation
      primitive. The live Fiber investigation already found the stronger source:
      `turn.messages` exposes each connector request with `recipient: api_tool.call_tool`,
      `content.text.path` and the paired result's `metadata.invoked_resource`, even when
      ChatGPT collapses several calls into one visible row. Reconcile pending MCP calls
      against those per-call React/Fiber messages (tool path + order + stable message/call
      identity and safe argument fingerprint where possible), then move/commit them to the
      conversation. Keep an unresolved pool only for genuinely ambiguous cross-device
      traffic. A single browser chat must never be permanently split merely because its
      renderer collapsed tool rows.

      **Implemented 2026-08-16 (code complete, awaiting T-91 live smoke).**
      - `fiber.js` VERSION 3 → **4**: `callsOf()` reads `turn.messages` and emits one
        descriptor per connector *request* — `{messageId, tool, order, answered}` — pairing
        results by `metadata.parent_id`, restricted to paths starting `/TobisComputer/` so
        another connector's traffic can never vouch for ours. `turnsOf()` reads the turn
        *sections*, not the rows, so a turn that rendered no row still reports its calls.
      - `content.js`: `readTurnCalls()` rebuilds each descriptor field by field (tool name
        checked, never trimmed; duplicate message ids dropped on both sides) and
        `refreshFiber()` emits a `tool_evidence` observation once per message id.
      - `bridge.ts`: `tool_evidence` added to `OBSERVATION_KINDS`, `parseCallEvidence()`
        re-validates independently of the extension.
      - `recorder.ts`: `noteCallEvidence()` banks per-call evidence per conversation, and
        `claimNamedCall(tool, startedAt)` — tried *before* `claimConversation()` — places a
        recorded call against an unclaimed request naming the same tool. The three refusals
        are unchanged: evidence is consumed, must fall in the call's window, and two
        conversations offering the same tool is a refusal rather than a coin toss.
      - Nothing new crosses the world boundary: no argument value, no result body, no path,
        no whole React props. Asserted in `test/fiber.test.ts`.
      - Regressions: `test/fiber.test.ts` — "the calls a turn says it made" (7 cases);
        `test/session.test.ts` — folded run of 5 calls behind 1 row, a turn with no row at
        all, wrong-tool refusal, and evidence spent once.

- [~] **T-90 — Compaction meter can say ~180k tokens while the model receives only ~20k,
      because `packSession()` intentionally deletes most successful tool evidence. LIVE
      DATA VERIFIED.** Source session `2026-08-16-be468059` had `estimatedTokens=182666`,
      375 events and 349 tool calls. The raw stored tool args/results total **713,349
      characters (~178,338 tokens by the app's own 4-char estimate)**. Of those, **289
      successful no-file-change calls contain 600,921 characters**. The saved handoff
      `2026-08-16-0f023d11` is only 14,146 characters. This magnitude matches the user's
      OpenRouter observation that the actual compaction request was only around 20k tokens;
      it is not explainable by tokenizer variance.

      **Confirmed mechanism:** `compact.ts::packSession()` turns every successful tool call
      without `changes` into only `tool ${head}` in tier 2. Its args and result are thrown
      away before packing. That means `read_file`, `read_files`, `search_files`, test output,
      `git diff`, process status and inspection results can make the session meter huge but
      contribute only a one-line title to the compaction request. These read-only results
      are often the *evidence* the next coding agent needs, so “no file changes” is the
      wrong definition of dispensable context. The mismatch is made worse by T-89: calls
      routed to `Unattributed activity` are outside the selected chat entirely and cannot
      enter its handoff at all.

      **Required direction:** make the meter and pack plan describe the same retained
      information. Preserve semantically useful read/test/inspection results under a
      configurable budget instead of reducing all successful no-change calls to titles.
      Deduplicate repeated observations/results, prioritize user messages + failures + file
      mutations + recent/source-bearing read/test evidence, and stage across multiple
      passes when needed rather than silently collapsing ~180k recorded tokens to ~20k.
      Show both `recorded estimate` and `packed/sent estimate` in the compaction UI so a
      legitimate reduction is visible rather than surprising. Add a regression fixture
      dominated by large successful `read_files`/test outputs and assert the handoff keeps
      the facts only present in those results.

      **Implemented 2026-08-16 (code complete, awaiting T-91 live smoke).**
      - `packSession()` gained a **tool-evidence tier** between essentials and commentary.
        A successful no-change call is now packed with its args and its result rather than
        `tool ${head}`, and the evidence tier is filled before the context and progress
        tiers, so what a tool returned outranks what the assistant said about it.
      - Non-essential entries carry a `full` and a `brief` form: an entry that will not fit
        in full is retried at its title rather than deleted, so a long session degrades to
        "named but summarised" instead of all-or-nothing. Narration deliberately has no
        short form — it is what a tight budget is meant to lose.
      - Repeated identical `tool + args + result` triples are carried once; later copies say
        `result: identical to #<seq>`.
      - New setting `compaction.toolResultChars` (default **4000**, 0 restores the old
        titles-only behaviour), in `Config`, the zod schema, the IPC schema and the
        Settings panel.
      - `CompactionState` gained `recordedTokens` and `packedTokens`, both surfaced in the
        Chat panel as `~X tokens recorded → ~Y sent`, so a legitimate reduction is visible.
      - Regressions in `test/session.test.ts`: keeps a fact present only in a successful
        result; one copy of a six-times-read file; shortens rather than drops under a tight
        budget; `toolResultChars: 0` reproduces the old behaviour.

      **Still open in T-90:** the *meter* above the composer still reports the recorded
      estimate only. Both numbers are now shown in the Chat panel once a pack has been
      built; making the pre-flight meter predict the packed size would need a dry pack per
      poll and was left out deliberately.

- [ ] **T-91 — 1.7 release smoke for the coupled pipeline.** **Unblocked 2026-08-16 23:04:
      the 23:02 rebuild is installed and running.** The one step left before smoking is the
      extension reload (`chrome://extensions` → reload, then hard-reload the ChatGPT tab);
      until that is done the page is still executing the pre-batch `content.js`. **Updated
      2026-08-17:** Tobias explicitly changed the presentation policy for 1.7.4: Overwrite now
      ships **ON by default**, with a persistent popup switch to restore stock ChatGPT. This
      smoke still judges the local log first, but when Overwrite is ON the CLF chronology is
      now expected to be visible; switch it OFF to verify the native fallback path separately.
      On the real installed build:
      one ChatGPT conversation must map to one primary local session; run at least 20 local
      calls including grouped/fast calls; verify every call appears once, commentary appears
      once and in native chronology, completed native prose is visible with no blank gap,
      and no relevant call falls into `Unattributed activity`. Then compact a deliberately
      tool-heavy session and compare the app's recorded-token estimate, packed/sent estimate,
      OpenRouter usage and resulting handoff coverage. Only after this passes build/install
      **v1.7.0**.

- [ ] **T-92 — 17.1 handoff provider UX: preserve OpenRouter/Flash as an explicit fallback,
      not the default path. Composer UX shipped; the rest stands.**

      > **Precedence, 2026-08-17.** This entry predates Tobias's request for configurable
      > auto-compaction and must not be read as ruling it out. The two are different
      > questions and only one of them is settled here:
      >
      > - *Which provider writes the handoff when one is asked for* — **T-92's question,
      >   and its answer stands.** Flash never takes over by itself because something
      >   failed. There is no silent substitution.
      > - *When a handoff is asked for at all* — **T-115's question, and T-115 is
      >   authoritative.** The user turns Auto Compact on, sets the token threshold, and
      >   picks the provider. Auto Compact is **OFF by default**, and Flash is used
      >   automatically only where the user has chosen Flash as the auto provider.
      >
      > A user who switched a setting on and named a provider is not being fallen back on;
      > they are being obeyed. What T-92 forbids is the app deciding that for them.

      Normal
      `Compact & Resume` uses ChatGPT itself to create/save the handoff. Do **not** delete the
      existing OpenRouter/Flash compaction implementation during the 17.1 cleanup: it is the
      escape hatch for the exact failure mode where the current ChatGPT conversation is at a
      hard context ceiling and the site refuses every further message, so a ChatGPT-native
      `save_handoff` request cannot even be submitted.

      **Composer UX — done, 1.7.4.** One compact control on the ChatGPT input; a normal click
      uses `ChatGPT (default)`; the chevron opens a drop-up with `ChatGPT (default)` and
      `Flash fallback`, so Flash can be chosen for one run without entering Settings or
      changing any default. The hover-to-open shortcut this entry once suggested was built
      and then removed: hover now raises the explanatory tooltip instead, so one gesture on
      one target means one thing. Hover explains, click chooses.

      **No trigger-happy automatic fallback.** Flash must not silently take over on ordinary
      timeout/network/tool/page errors — that prohibition is unaffected by T-115, which is
      about the user switching automation on deliberately, not about the app substituting a
      provider behind their back. A `Auto only on hard context refusal` setting remains a
      separate future idea, **OFF by default**, activating only from a positive, specific
      hard-context-refusal signal rather than heuristics. Until such a signal is proven
      reliable, manual selection is the authoritative *fallback* path.

### Recorder-first hardening — verified 2026-08-16 by test, still behind T-91 live

Everything below is green under real Node (`node_modules\vitest\vitest.mjs run`, 23 files,
712 passed / 1 skipped / 0 failed) and `tsc --noEmit` clean. "Verified" here means *the
regression exists and fails without the fix* — none of it has been through the live page,
which is still T-91's job. **Policy changed 2026-08-17:** production Overwrite now defaults
ON at Tobias's request; the same restore gate remains available as a persistent popup OFF
switch and must be exercised during the live smoke.

- [x] **T-93 — With the renderer off, this extension changes nothing a user can see.**
      `paint()` was presentation running unconditionally from `pullActivity()`:
      `applyPageLabel()` overwrote ChatGPT's own label text and added `clf-*` classes, a
      title and block styling even with `RENDER_STREAM = false`. It is now gated on
      `RENDER_STREAM && status.connected === true && status.paired === true`, and — because
      a switch that only stops *new* paint leaves the old ones on screen — a new `unpaint()`
      releases every label this app applied when the gate closes. Invisible capture stamps
      (`data-clf-progress-id`, `data-clf-page-tool-id`) are deliberately unaffected: the
      recorder needs them and no user can see them. Two tests in
      `test/content-script.test.ts` assert the *presentation*, not byte-for-byte innerHTML:
      native label text, `title`, `className`, no `clf-tool`/`clf-page`/`clf-stream`, no
      `[data-clf-native-hidden]`, and no `clf-`-prefixed children at all — one for a fresh
      page, one for a page this app had already painted before the switch was thrown.
      Every existing labelling test now asks for the renderer explicitly (`renderingOn()`),
      so the feature is still fully covered; it just has to be requested.

- [x] **T-94 — A live turn is identified by node/generation identity, never by reverse
      page-id lookup.** `renderStreams()` needed to know whether a logical turn *is* the
      generating one. `pageTurnIds` maps local generation → page id, and page ids are
      reused, so inverting it is ambiguous by construction — two generations can hold the
      same page id and the loser silently steals the live stream. `localGenerationOf(turn)`
      answers from identity instead: if any of the turn's nodes is or contains `genNode`
      the answer is the current `turnId`; otherwise `settledGenerations.get(node)`, which is
      seeded for every node at `turn_end`. Page id stays a hint and a legacy event spelling.

- [x] **T-95 — An old error banner can no longer fail a later turn.** `errorFirstSeen`
      stored `Date.now()` and `endOutcome()` kept a banner if its stamp was `>=
      turnStartedAt`. Two turns inside one millisecond — which is what the tests produce and
      what a fast local turn produces — made the tie read as "this turn's", so a banner from
      the previous generation marked the next turn `failed`. It now stores the *generation
      key*, and the seeding loop moved to immediately after `emit({kind:'turn_start'})` so a
      node is stamped with the generation it was actually first seen in. A node nothing has
      recorded yet can only have arrived on this tick, so it defaults to this turn — the
      same intent as the clock version, without a tie to lose. This was a real product bug
      that the T-93 gate merely exposed.

- [x] **T-96 — `tunnel/index.ts::killTree` no longer depends on `taskkill` being on PATH.**
      The same bug already fixed in `exec.ts`, present independently here: a bare
      `spawn('taskkill', …)`, `unref()`, immediate return. ENOENT arrives asynchronously on
      the `error` event, so the surrounding `try`/`catch` could never reach the
      `child.kill()` fallback and a tunnel child survived on a machine whose PATH does not
      carry System32. It now calls the shared `terminateProcessTree(pid)` and falls back to
      `child.kill('SIGTERM')` on rejection. **This is not hypothetical here:** the PATH of
      the shell this work was done in contains exactly one directory
      (`…\resources\rg`), which is a live reproduction of the parent-environment case.

- [x] **T-97 — PATH repair keeps a healthy environment byte-identical.** `test/env.test.ts`
      now pins both halves separately: a fully equipped inherited path (System32, Windows,
      Wbem, WindowsPowerShell\v1.0, plus an unrelated entry) comes back unchanged with
      `pathKeys` still `['Path']`, and a path holding only System32 gains the other three
      Windows directories while System32 stays first and no entry is duplicated.

- [x] **T-98 — The exact live same-line corruption is pinned.** `chatgpt-dom.js::dropEcho()`
      already collapsed a caption the page double-wrote with no newline between the copies,
      but nothing in the test tree held it, so any future simplification of
      `commentaryText()` would have removed it silently. The fixture is the string observed
      on the page — `Yep bro, **that screenshot basically confirmsYep bro, that screenshot
      basically confirms the gate theory` — and the assertion is that exactly one `progress`
      event is emitted carrying only the authored copy. A second test guards the other
      direction: `Reading it. Reading it again, properly this time.` is real prose that
      repeats its opening and must survive intact (`MIN_ECHO_CHARS = 24`).

- [x] **T-99 — A long answer is de-duplicated across a restart by a digest of its whole
      text.** The stored copy of an answer over `MAX_MESSAGE_CHARS` (12 000) is elided, so
      comparing it with the live text it came from called every long answer new on every
      reload. `storeText(…, { identify: true })` writes `digest = sha256(scrubbed full
      text)` and `storedIdentity()` prefers it, which was already the implementation — now
      with the two tests that hold it. First: a >12 000-char assistant message is stored
      `truncated: true` with `chars` = the real length and a 32-hex `digest`, and after
      `resetRecorderForTests()` an identical replay stores nothing. Second, and the one that
      actually discriminates: two answers with the same message id, the same length, the
      same opening and therefore a *byte-identical* elided copy on the log line, differing
      only in their last characters, are kept as two events. The pre-digest
      `legacy:chars:head200` identity collapses that pair, so this fails the moment the
      digest stops covering the whole text.

- [x] **T-100 — Capture-side attribution regressions, the ones the local log is judged by.**
      Four fixtures in `test/content-script.test.ts`, all on the "no duplicates, no wrong
      attribution, nothing unattributed" requirement rather than on the dormant renderer:
      a turn that produced only commentary and no prose does not get that commentary
      promoted to a final answer; two different answers of the same length that ChatGPT
      filed under one reused `data-turn-id` (the first section removed, a new one appended
      with the same id, which is how sequential id reuse actually looks) stay two messages;
      a generation binds to a section it has so far written only commentary into; and a
      generation does **not** bind to a section merely because this app renamed a tool row
      inside it — `sectionSignature()` reads page-authored text only, stripping this app's
      own surfaces and the TOOL rows, so our own output can never become the evidence that
      a section is ours.

- [ ] **T-101 — Collapse the model-facing tool surface to eight orthogonal primitives.
      DESIGN SETTLED, NOT STARTED. Gated on T-91.** Full decision record, exact schemas,
      skill rules, compatibility plan and required tests: **`docs/tool-surface.md`**. In
      brief: `read`, `apply_patch`, `exec_command`, `write_stdin` for normal coding;
      `observe` + `computer` with computer use; `session`; `agents`. `find` appears only
      when the command capability is off. Measured starting point is 45 tools / 60,484
      bytes / ~15,100 tokens, and the argument for cutting it is selection reliability and
      the fact that the tool prefix is the one cost compaction can never reclaim — not the
      byte count, which is ~3% of the real ceiling. Three things were resolved in source
      rather than assumed and must not be re-litigated: the MCP transport is **stateless**
      for the era ChatGPT speaks, so `agent_key` cannot be deleted (it is isolated to
      multi-agent instead, with `transportIdentityStatus()` as the migration hook); some
      hosts collapse root-level discriminated unions, so every action-style tool is a flat
      enum schema; and a "legacy names stay callable but unlisted" shim is technically
      available (`createMcpHandler` builds a fresh server per request, so `tools/list` and
      `tools/call` can be answered by different registrations) but is **rejected** — the
      user's decision is a clean break, no aliases, no grace period, old chats break, and
      the invariant is *no hidden callable surface, ever*. Release notes must lead with
      "breaking connector change: refresh the connector and start a new chat".
      Sequencing: the recorder must learn to label from structured call metadata **before**
      the rename lands, so it can be diffed against real 1.7.x recordings.
      **Packaging locked 2026-08-17 (`docs/tool-surface.md` §6.1):** one CLF plugin, one CLF
      app, one tunnel, many progressively disclosed skills. Skills may hide instructions and
      resources, never tool schemas. Splitting across multiple apps or plugins is rejected
      for the default experience — OpenAI's docs describe a plugin as containing *an* MCP
      server (singular), give skills no dependency edge that mounts tools, and require apps
      to be picked per conversation before the first message. Do not reopen this without a
      ChatGPT client that offers real deferred tool discovery. The two-part `list_changed` /
      unlisted-name canary is documented in §6.2 as a **non-blocking** experiment: nothing in
      T-101 waits on it.
      **REOPENED 2026-08-17 by measurement, same day (`docs/tool-surface.md` §6).** ChatGPT's
      harness already does deferred per-app tool discovery: a turn starts with a one-line app
      summary only, and `api_tool.list_resources(paths=[…], query=…)` injects a *relevance
      subset* of that app's schemas (9 of Gmail's 21; our own 44 have been arriving in
      subsets all along). OpenAI's Tool search guide documents the mechanism, including
      `defer_loading` per MCP server, persistence of discovered tools across turns, and a
      **gpt-5.4+** model requirement. Consequences: the byte/prefix argument for the collapse
      is dead and §1 is amended; selection reliability survives and now carries the case,
      joined by **retrieval recall** (a tool a plain query fails to surface is a tool the
      model does not have); older models still load everything eagerly, so the eager path
      sets a hard ceiling on total surface size. The §7.2 invariant is untouched — client-side
      deferral is honest, server-side concealment is not. **Do not fix the surface until E1 in
      §6.3 is run** (does a 3-tool scratch connector load eagerly, or is deferral
      unconditional?), because it decides whether an always-loaded core is expressible at all.
      **TOPOLOGY LOCKED 2026-08-17, E1 answered, implementation started (§6.4/§6.5).**
      `api_tool.list_resources(paths=["TobisComputer"])` with **no query returns the whole
      server surface**; a query narrows it, but nothing guarantees the harness asks a narrow
      one. Deferral is therefore a typical-case win and not a worst-case bound, and the only
      real bound is the size of the server being pulled. Ship **two** surfaces:
      **Core** = `read`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents`
      (6 max; `find` replaces the exec pair when command execution is off, so never 7), and
      **Desktop** = `observe`, `computer` (2). No Workflows/Agents/Sessions connectors — a
      one-tool connector does not earn its setup cost, `session` must stay on Core because the
      app itself drives `save_handoff` during native compaction, and `agents` is off by
      default so it costs nothing when unused. Desktop earns its boundary: separate
      permissions, heaviest schemas, unnecessary for most coding sessions. Each surface is a
      **real** discovery boundary — no cross-surface listing or calling, asserted both ways.
      Transport, resolved from tunnel-client docs rather than guessed: cloudflared/manual get
      both surfaces free from one process (one origin, two token paths), but the **OpenAI
      tunnel needs one tunnel id per surface** — `tunnel-client` does support channel
      multiplexing, yet ChatGPT's connector UI can only address a tunnel id and empty-channel
      traffic is normalised to `main`, so extra channels are unreachable from ChatGPT.

## P1 — live tool/harness bugs found while monitoring Claude — 2026-08-17

- [x] **T-102 — `exec_command` records a non-zero process exit as `outcome:"ok"`. LIVE
      REPRODUCED.** In current session `2026-08-17-0ee9f758`, event seq 30 ran `rg` and the
      managed process exited **1**. The stored summary correctly says `Command failed` / `✕
      exit 1`, but the same authoritative `tool_call` stores `call.outcome:"ok"`. A consumer
      using the structured outcome therefore disagrees with the human-readable summary and
      can treat a failed build/test/search command as successful. Non-zero process exit must
      produce a non-ok authoritative outcome; the summary and outcome must derive from the
      same process result. **Likely root cause confirmed in code:** `noteExec()` only writes
      `evidence.exitCode` (`src/main/mcp/call-context.ts:154-159`), while the recorder fallback
      in `src/main/mcp/kernel.ts:341` uses only `result.isError` and therefore defaults an
      ordinary completed non-zero shell result to `ok`.

      **Closed 2026-08-17 (1.7.2).** `noteExec()` now sets `error` for a completed non-zero
      exit or a timeout. It only fills an outcome nobody set — a refusal stays `rejected` —
      and a still-running process (`exitCode === null`) is left alone, because a dev server
      doing what was asked of it has not failed. Four cases covered in `test/mcp.test.ts`.

- [ ] **T-103 — Desktop cannot reliably inspect or activate a requested background window.
      LIVE REPRODUCED.** `observe(window=329406)` returned the requested Terminal's metadata
      but warned that the picture may be covered, and its screenshot was in fact the
      foreground Chrome window rather than the requested Terminal. The obvious recovery call,
      `computer([{type:"focus",window:329406}, ...])`, then rejected with
      `FOCUS_FAILED: requested 329406 but foreground is 66910 after asking Windows to activate
      it`. This makes read-only monitoring of another app unreliable and can leave the model
      unable to recover because the focus action itself is blocked by the same foreground
      condition. A successful window-targeted observation must show that HWND, or report a
      clear non-success without returning a misleading covered screenshot; a requested focus
      action needs reliable success/failure semantics rather than making the recovery path
      self-defeating.

      **Re-audited in the 2026-08-17 ultrathink pass:** the current source has already removed
      the dangerous part for read-only observation: `screenshot(window=...)` no longer throws
      merely because the HWND stayed in the background, returns `focused:false`, and the Desktop
      tool contract explicitly warns that the pixels may show an occluder. UI Automation queries
      are also independent of foreground focus. What remains here is a real Windows capability
      improvement (off-screen HWND capture such as PrintWindow/DWM and stronger activation), not
      a hidden MCP execution/attribution bug. It was deliberately not mixed into the recorder,
      patch/process and extension repair batch.

- [ ] **T-104 — One trivial argument-range mistake dumps the complete tool schema into the
      conversation. LIVE REPRODUCED.** Calling `exec_command` with `max_lines:220` instead of
      its maximum **200** returned the useful error (`220 is greater than the maximum of 200`)
      followed by the entire `exec_command` JSON Schema. That turns a one-field typo into a
      large context/log payload and is especially expensive in coding-agent loops. Runtime
      validation failures should return the failing field/path, received value and allowed
      constraint compactly; full schemas belong in explicit discovery/debug output.

      **Not ours — measured 2026-08-17 against the real endpoint.** `exec_command` with
      `max_lines: 220` gets back a 223-byte reply: `Input validation error: Invalid arguments
      for tool exec_command: max_lines: Too big: expected number to be <=200`. `computer` with
      `ms: 12000` answers identically for `actions.0.ms`. This app never emits a schema on a
      validation failure; the dump is added by the client validating against the published
      JSON Schema before the call arrives, so there is nothing here to fix. Leaving the item
      open only as a note in case the schemas themselves can be made smaller.

- [x] **T-105 — Connector ownership matching is prefix-based, and the new "lookalike"
      regression test does not exercise the dangerous prefix case. FOUND DURING CLAUDE RUN.**
      `extension/fiber.js:79-82` currently accepts every `app_name` whose name begins with
      `ChatGPT Local Files`; `extension/content.js` uses the same `startsWith` rule. Fiber sees
      descriptors for *all* connectors on the page, so another connector advertising e.g.
      `ChatGPT Local Files Backup` would be falsely vouched for as local activity. The new
      test says "a name is not a prefix game" but its negative fixture is
      `Not ChatGPT Local Files Core`, which does **not** begin with the brand and therefore
      passes even with the over-broad matcher. Match the two current names (`ChatGPT Local
      Files Core`, `ChatGPT Local Files Desktop`) plus the explicit legacy name exactly, and
      make the negative control itself begin with `ChatGPT Local Files` so the regression
      actually fails under prefix matching.

      **Closed 2026-08-17 (1.7.2).** Both files now hold the same explicit three-name list —
      `ChatGPT Local Files Core`, `ChatGPT Local Files Desktop`, `TobisComputer` — compared by
      equality, for the `app_name` and for the first path segment of `/<connector>/link_…/<tool>`.
      The negative fixture is `ChatGPT Local Files Backup`, which does begin with the brand, so
      the regression fails if anybody reintroduces prefix matching.

- [x] **T-106 — `read` silently ignores `start_line` / `end_line` when more than one path is
      supplied. LIVE REPRODUCED.** The schema text says those fields are "Single path only",
      but the combination is still accepted. A call for two files with `start_line:75,
      end_line:90` returned both files from line 1 until the byte cap, with no warning that
      the requested range had been discarded. That is dangerous agent behaviour: a valid-
      looking call silently changes semantics and burns context instead of failing where the
      model can correct it. Reject the incompatible argument combination (or at minimum make
      the result explicitly say the range was ignored); do not silently coerce it away.

      **Closed 2026-08-17 (1.7.2).** Refused with `INVALID_ARGUMENT`, naming how many files the
      call resolved to and the first few of them. The check runs after glob expansion, since a
      pattern is the usual way a single-path call becomes a multi-path one, and the two schema
      descriptions now say the range is refused rather than "single path only".

- [x] **T-107 — The 1.7.1 connector split renamed the connector out from under the extension,
      and every call in every chat lost its page evidence. LIVE REPRODUCED, ROOT CAUSE OF
      "Unattributed activity".** `extension/fiber.js` and `extension/content.js` still matched
      the single pre-1.7.1 name `TobisComputer`, while the page now serves
      `invoked_resource.app_name: "ChatGPT Local Files Core"` and request paths beginning
      `/ChatGPT Local Files Core/link_…/`. Read live on
      `chatgpt.com/c/6a82ea5a-9fb8-83eb-a98a-d2e1b365f9d3`. Three symptoms, one cause:
      `pickTarget()` got no conversation so calls were filed under **Unattributed activity**
      (`2026-08-17-30fed77a`: 346 events, 340 `inferred`, 4 `agent`, none attributed); local
      rows were misread as ChatGPT-native and reported as `page_tool`, which is why the desktop
      timeline showed `ChatGPT: Inspected repository, tested core tools…` as if the assistant
      had said it; and the real chat session `2026-08-17-7365eb08` held 2 of roughly 30 calls.
      **Closed 2026-08-17 (1.7.2)** by the exact three-name ownership list — see T-105.

- [x] **T-108 — The same assistant answer was stored twice. LIVE REPRODUCED.** Session
      `2026-08-17-7365eb08` events 20 and 21: identical 542-character text, identical digest
      `82cd96f5…`, 19 ms apart. The derived message id flips from ChatGPT's reused page turn id
      to the local generation id across the settling tick, so the `seenMessages` key changed
      even though the rendered node and its text had not. **Closed 2026-08-17 (1.7.2):**
      `reportMessages()` now also keys a `reportedAssistant` WeakMap on the message *node* plus
      its text, so this node having already said this exact thing suppresses the repeat
      whatever id the current tick derives.

- [x] **T-109 — The stage panel was narrower than the composer it sits above.** `.clf-stage`
      sized to its content because ChatGPT's mount centres rather than stretches its children.
      **Closed 2026-08-17 (1.7.2):** `injectStage()` measures the element it is inserted before
      and pins that pixel width (with `max-width: none`); the stylesheet keeps
      `align-self: stretch; width: 100%` and the 48rem cap as the fallback before the first
      measurement lands.

- [x] **T-110 — The Flash chooser opened invisibly behind the composer, so the chevron read as
      a dead button.** The menu lived inside the composer control and opened upward with
      `position: absolute`, into a subtree ChatGPT clips and stacks below its own bar — the
      user saw "something shadowy spawn behind the input field". **Closed 2026-08-17 (1.7.2):**
      the menu is built into `document.body` instead, is `position: fixed` at a very high
      z-index, and `openMenu()` positions it from the chevron's own rect; a once-only
      capture-phase `pointerdown` + `Escape` handler dismisses it, and teardown removes it.

- [x] **T-111 — `Thinking` was recorded as a step ChatGPT took, and the real reasoning
      headlines overwrote each other. LIVE REPRODUCED.** Live on conversation
      `6a82fb71-fbd0-83eb-977c-ba528ba28772`, one headline node carried three captions in
      turn and all three were stored under the same `messageId` `…#t0` — `Thinking`, then
      `Inspecting Package, Documentation, and Tests`, then the settled summary — each
      superseding the last and all sharing the first one's timestamp, which is why a whole
      turn's steps could collapse to one row stamped with a single time. ChatGPT reuses one
      node for every reasoning step, so a stamp that identifies the *row* cannot identify the
      *step*; whether a turn's steps survived depended on whether React replaced the node,
      which is exactly why this appeared to work in some turns and not in others.
      **Closed 2026-08-17 (1.7.2):** `pageToolItems()` drops busy captions (`Thinking`,
      `Worked for 22s`, …) matched whole, so a step named "Thinking through the release gate"
      still counts, and mints a revision of the row id when the caption becomes a materially
      different step. A caption that is the same step finishing — `Inspecting X` → `Inspected
      X`, compared after stemming — keeps its id and updates in place. See TOOL_CALL_ISSUES.md.
      **Superseded by T-113:** the "one node per turn" reading above was wrong, and the id
      revisions it added never fired live. The busy-caption filter is the part that survived.

- [x] **T-113 — Reasoning steps were identified by their row, and ChatGPT does not keep the
      row. LIVE MEASURED.** The 1.7.2 fix in T-111 assumed one headline node per turn; a 400ms
      DOM probe on conversation `6a82febd-c534-83ed-a74c-bc6a739b6127` showed the opposite —
      every step gets its own row, which starts as `Thinking`, becomes `Inspecting Local Files
      Source Directory`, then settles to `Inspected local source directory files`. React
      *replaces* those rows as they settle, and that broke a row-shaped identity in both
      directions at once. It recycled: the node for step one was destroyed, its freed stamp was
      claimed by step two, and a new step arrived under the old step's id and overwrote it
      (live: five steps, all under `…#t0`). And it duplicated: for one tick the outgoing and
      incoming node both held `Read README and provided intermediate updates`, so one step was
      recorded twice, as `#t1` and as `#t2`.
      **Closed 2026-08-17 (1.7.3):** identity now comes from the caption, not the row.
      `stepIdentity()` keeps a per-generation list of the steps seen and matches a caption
      against it newest-first after stemming, so `Reading README` and `Read README` are one
      step updated in place whichever node they arrive on, and anything else is appended as
      the next step. The row stamp is gone. Three tests in `test/content-script.test.ts`.

- [x] **T-114 — Interim messages were stored reading themselves three and four times over.
      LIVE MEASURED.** `seq25`-`seq29` of session `2026-08-17-da2de453`: the commentary
      container holds the paragraph it is replacing alongside the replacement, and `innerText`
      runs the two together with no newline, so a message arrived as a chain of ever-longer
      prefixes of itself — `**Schritt 3 erled` + `Schritt 3 erledigt: Die ersten 15 Zeilen` +
      the same sentence carried further, on one line. `dropEcho()` only recognised an exact
      `A + A`, and no link of that chain is one, so the whole thing was stored and drawn.
      **Closed 2026-08-17 (1.7.3):** `dropEcho()` now peels restated segments from the front
      repeatedly, leaving the last and fullest pass. A segment still has to be restated
      exactly, back-to-back, and be at least twelve characters and two words, so prose that
      genuinely repeats a short opening is untouched — the existing guard test still passes.

- [x] **T-112 — Everything this app could actually fix in TOOL_CALL_ISSUES.md.** Closed
      2026-08-17 in 1.7.2: `apply_patch` now creates the parent folders it always promised to
      (and removes them again on rollback); `exec_command` reports the folder it ran in and
      says when that was a default; the managed-session path decodes PowerShell CLIXML stderr.
      The PATH/env, taskkill and helper-encoding findings were already fixed earlier. The
      resolution table at the top of TOOL_CALL_ISSUES.md records each one and its evidence.

- [x] **T-118 — `apply_patch` rejected an otherwise-valid atomic patch when the same file was
      named in two separate `*** Update File:` blocks. LIVE REPRODUCED 2026-08-17, FIXED
      2026-08-17.** The whole patch was refused before mutation when `extension/content.js`
      appeared twice for two logically separate hunks. Root cause was a flat `touched` Set in
      `applyResolvedPatch`, which claimed a path on first mention and refused every later one
      whatever the two operations were. Preflight now resolves against a staged per-path view
      (`StagedPath`) instead of re-reading the disk, so a second update block sees the first
      block's text exactly as a second hunk inside one block does, and the path is committed
      once with aggregate `hunks`/`delta` — one `FileChange` per path, response shape
      unchanged. `originalBytes` still holds the real starting file, so the commit's
      optimistic check and the rollback are untouched: both blocks fail or land together.
      The guard was not deleted, it was made state-aware — delete+update, update+delete,
      update-after-move-away, two moves onto one destination, add-onto-move-destination,
      double add and add+update are all still refused, now naming what actually collided.
      13 regressions in `test/patch-files.test.ts`; forcing the old blanket refusal back
      fails 6 of them.

- [x] **T-119 — non-TTY `exec_command` PowerShell stdout was decoded as IBM437/us-ascii and
      mangled Unicode. FIXED, VERIFIED 2026-08-17.** `CONSOLE_UTF8` in `src/main/exec.ts` sets
      both `[Console]::OutputEncoding` and `$OutputEncoding` to BOM-less UTF-8 ahead of the
      user command, on both the `runPowerShell` and `prepareShellCommand` paths. Verified by
      round-tripping `äöüß → — … “quotes” 😀` through stdout *and* stderr (stderr is decoded
      separately and cleaned of CLIXML, so it is its own path). Negative check: blanking
      `CONSOLE_UTF8` fails both, and prints the reported corruption exactly — `����  - .
      "quotes" ??`, with the curly quotes silently straightened and the emoji reduced to
      `??`, from a shell that still exits 0.

- [x] **T-120 — `exec_command` with `shell=cmd` could exit 0 without running a quoted child
      command. FIXED, VERIFIED 2026-08-17.** Both paths are implemented: the pipe path passes
      `windowsVerbatimArguments: true` with `/d /s /c` and the script wrapped in one outer
      quote pair (`src/main/exec.ts`), and the node-pty path passes the finished command line
      as a single string rather than an argument list (`src/main/process-manager.ts:490`).
      Side-effect regressions on both — write a file through `node -e`, then read it back —
      because the failure mode is empty output behind a clean exit. Negative check: reverting
      the pty path to the argument list fails all three console tests with `The system cannot
      find the path specified.`

- [x] **T-121 — native Windows absolute paths gave a poor error. ALREADY FIXED, VERIFIED
      2026-08-17.** `rejectNativePath` in `src/main/sandbox.ts` takes the second of the two
      options: the path is still refused — nothing resolves from a native path, because one
      canonical form is what makes the containment checks mean anything — but the refusal
      names the exact virtual path to use instead, and offers no correction for a path that
      has no correct form. Covered by 5 tests in `test/sandbox.test.ts`. Sandbox roots
      unchanged.

- [ ] **T-122 — pre-execution full-schema dumps on an invalid `max_lines` or `computer` wait
      are upstream client-side validation, not something these handlers can intercept.**
      EXTERNAL / OPEN, confirmed 2026-08-17. The dump is emitted before the request reaches
      this process, so there is no local seam to intercept it and no local fix was attempted.
      Recorded so it is not re-investigated. Do not spend time on it.

---

## P0 — connected ChatGPT transcript must be app-owned — **NEW ARCHITECTURE**

**Decision, 2026-08-16:** stop treating ChatGPT's rendered tool rows as the transcript.
When this browser is connected to ChatGPT Local Files, the local session record is the
primary source for the activity stream. ChatGPT remains the host and visual language, but
its choice to collapse, group, delay, reorder or omit tool rows no longer decides what the
user gets to see.

**Live proof from this exact prime chat:** session `2026-08-16-7ec035f5` had 92 recorded
MCP calls when inspected. The user turn beginning at event #109 produced **22 local tool
calls** before the next turn, while ChatGPT exposed only a small handful of rows on screen.
Evidence screenshots:
`docs/evidence/2026-08-16-current-chat-missing-most-tool-calls.png` and
`docs/evidence/2026-08-16-delete-timestamp-overlap.png`.

**Why the current extension cannot solve this by relabelling harder:**

1. `/activity` currently returns only `tool_call` events. The app has the full local stream,
   but the browser is deliberately handed only tool summaries.
2. `content.js::paint()` can only decorate DOM blocks returned by
   `CLF_DOM.toolBlocks(turn)`. A local call for which ChatGPT rendered no row has literally
   nowhere to appear. Grouped/collapsed rows make this normal, not an edge case.
3. Those rows are React-owned. `paint()` injects title/icon/agent/time into a node; ChatGPT
   can replace that node on its next render. The one-second observe tick and two-second
   activity tick then paint it again. This is the observed **appears briefly → disappears →
   appears again** behaviour. `watchToolRows()` records evidence but does not own a stable
   presentation surface.
4. The recorder does not yet hold the page-exclusive half of the stream. It stores a final
   `assistant_message` only after generation stops; `progressLine()` samples only the last
   line under `[data-interrupted]`; native ChatGPT tools such as web search do not pass
   through `recordToolCall()` at all.
5. Turn identity is currently unsafe at generation start. Live evidence on the present
   turn: `turn_start` was `request-…-7`, while the first two recorded progress updates were
   stamped `request-…-5`. `currentAssistantTurn()` simply takes the newest assistant
   section, so if the STOP button appears before the new section mounts it latches the
   previous turn. This was previously only a candidate; it is now reproduced.
6. Whole-message `textContent` also records ChatGPT chrome. The live log contains authored
   user text ending in `Show moreShow less`. That is stored data pollution, not spacing.

**Target event model / renderer:**

- **Local MCP events are authoritative.** Every call the connector actually executes comes
  directly from the app recorder, including agent id, outcome, duration, summary and safe
  details. Never infer these calls back out of ChatGPT's DOM.
- **The page contributes only things the app cannot know itself:** visible assistant
  commentary/final text, native ChatGPT tools such as web/search, visible errors and turn
  boundaries. Capture them once when first observed and send them into the same session
  log. Never extract or surface hidden/private reasoning; only text/tool activity that the
  ChatGPT UI itself exposes to the user.
- **Use local observation time for live page-only events.** Do not numerically merge
  ChatGPT server `create_time` with the recorder clock. For historical backfill, retain
  page order rather than pretending two clocks are one.
- **One extension-owned stream per assistant turn.** Hide/suppress ChatGPT's native
  reasoning/tool activity for that turn only after our replacement exists, then render the
  recorded stream chronologically in ChatGPT's visual style: assistant update → MCP call →
  native web/search call → assistant update → … → final. User bubbles stay ChatGPT-owned.
  Visible assistant prose is mirrored from the page; the native prose node is hidden only
  once the replacement has the same content, so a renderer miss degrades to ChatGPT rather
  than to a blank turn.
- **React no longer owns our rows.** The synthetic stream is an extension-owned sibling
  anchored to the logical assistant turn. A MutationObserver re-attaches the one container
  if ChatGPT replaces its subtree. Do not repeatedly mutate individual React tool rows.
- **Connected mode only.** When the companion is absent/disconnected, ChatGPT remains
  untouched and the stock transcript is the fallback.

- [x] **T-75** **Do not record ChatGPT message chrome.** Fixed and regression-tested: `messagesIn()` currently reads the
      whole `[data-message-id].textContent`, which has reproduced stored text ending
      `Show moreShow less`. Extract the authored message-content subtree or clone/remove UI
      controls before text extraction. Fixture: a clamped user message round-trips byte-for-
      byte as authored and never contains `Show more` / `Show less`.
- [x] **T-76** **Session-row delete must not cover the timestamp.** Fixed and regression-tested: `.sess-del` is absolute
      at the same top-right position as the age text; live hover changes `just now` into
      `just [trash]`. Reserve a real right gutter/button column in `.sess-top`; z-index is
      not a fix. Screenshot above is the regression reference.

## P0 — the desktop Chat panel is structurally broken — **DONE**

Two root causes, several symptoms. Fixed together; `npm run verify` green (468 passed,
typecheck clean). **Not yet confirmed visually in a running build** — needs a smoke pass.

**Root cause A (confirmed):** `src/renderer/styles.css:1200`

```css
[data-panel='chat'] .card { grid-template-rows: auto minmax(0, 1fr) auto; }
```

The Sessions card has 3 children (`h2`, `.scroll`, `.foot`) and fits. The session card has
**4** (`h2`, `.subhead`, `.scroll`, `.foot`, `src/renderer/index.html:390-563`). So the
track list is applied to the wrong children: `.subhead` — the Timeline/Compaction/Settings
switcher — receives the `minmax(0, 1fr)` track, and `.scroll` plus `.foot` fall into
implicit `auto` rows. T-2 and T-3 both follow from that.

**Root cause B (confirmed):** `styles.css:633` declared a bare `.tool { display: flex }` for
a permission checkbox. The Chat timeline's recorded tool call is a
`<details class="tool">` (`chat.ts:298`) whose own rule at `:1413` never set `display`, so
it inherited `flex` — and a `<details>` laid out as flex stops stacking its `<summary>`
above its body and puts them side by side. That is the entire reason the arguments/result
panel appeared welded to the right edge of the card instead of opening underneath the row.

- [x] **T-1** Session card now carries `is-session` and its own four-track template
      (`auto auto minmax(0,1fr) auto`); the shared rule stays three-track for the Sessions
      card. Every child has an explicit track — nothing relies on implicit rows.
- [x] **T-2** Switcher no longer floats into the middle of an empty card. Was T-1: the
      `1fr` track was on `.subhead`. Screenshot: "shit jumped into middle lol".
- [x] **T-3** Timeline no longer paints over the header and switcher. Was T-1: `.scroll`
      sat in an implicit `auto` row sized to its whole content. Screenshots: "empty", and
      "Edited …/test/agents.test.ts +37 −5" overlapping the tab row.
- [x] **T-4** Expanded tool call opens inline, directly under its row. Fixed by scoping the
      permission rule to `.tools .tool` and stating `display: block` on the timeline's
      `.tool` so a stray rule cannot take it away again. Screenshots: "Hier ←", and the
      clipped ARGUMENTS/RESULT box.
- [x] **T-5** `test/renderer-layout.test.ts` now asserts one grid track per card child,
      that the single flexible track belongs to the body and not the nav row, that `.tool`
      is `display: block` and does not share a selector with the permission checkbox, and
      that the document has no duplicate ids. All four fail without the fixes above.
- [x] **T-6** Duplicate id `agentFilter` split into `chatAgentFilter` (chat panel) and
      `logAgentFilter` (activity panel); `chat.ts` and `main.ts` each bind their own. The
      Activity panel's agent filter was unreachable dead code before this.
- [x] **T-7** Swept. `.tool` was the only real collision. `.model, .agent` is a deliberate
      shared rule, not a duplicate, and `.chip` is already scoped where it matters.
- [ ] **T-53** Smoke the P0/P1 fixes in a built, installed app at the default window size:
      empty Compaction view, a long timeline, and an expanded tool call with a large
      arguments payload. jsdom does no layout, so the tests above constrain the structure
      but cannot prove the pixels. **Also now covers the extension:** load the unpacked
      extension on a real ChatGPT page and confirm `fiber.js` finds the shapes it looks for
      (`__reactFiber$`, `turn.messages`, `recipient: "api_tool…"`, `content.text` JSON with
      `path`, `metadata.invoked_resource`, `collapsedSameToolCallCount`). Every test for
      T-55/T-56 runs against a fixture *of* that shape and so cannot prove the shape. If
      any of it is wrong the helper fails closed and rows keep ChatGPT's labels — no
      breakage, but no benefit either, and silently.

## P1 — Chat panel controls: what the user actually reaches for — **T-54 open**

Everything else in this section is done. `npm run verify` green: typecheck clean, 482
passed / 1 skipped. Not yet smoked visually (T-53 covers this batch too).

- [x] **T-8** Standalone **Compact** button deleted. The header now carries exactly one
      primary action, *Compact & resume*, plus *Cancel* while a job runs.
      `startCompaction(false)` stays reachable in code for the internal path.
- [x] **T-9** Settings left the switcher and became a gear (`#chatSettingsBtn`) in the
      header. The gear toggles: pressing it again returns to whichever of
      Timeline/Compaction the user came from (`lastContentView`). The switcher is now two
      views, both of which really are views of the session.
- [x] **T-10** Per-agent **Clear** as an `×` on the row itself, prime and workers, with a
      tooltip that says which of the two things it does. Backed by a real lifecycle
      operation, not a deletion: `clearAgent()` (`src/main/agents.ts`) routes the prime to
      `resetSwarm()` (the whole run) and a worker to `failAgent()` — the existing terminal
      transition. So a cleared worker keeps its tombstone: it cannot act, cannot be
      messaged, its chat cannot be claimed, its slot is free for a replacement, and the
      prime is told in words that the *user* ended it rather than the default "never came
      up" wording. `swarm:clearAgent` additionally cancels that one worker's queued browser
      commands (`cancelWorkerCommands(reason, agent)`) so a sibling's tab is not withdrawn.
      8 tests in `test/agents.test.ts`.
- [x] **T-11** *Clear swarm* is now enabled whenever `state.agents.length > 0`. Gating on
      `running` left a finished-but-present run with no way out — exactly the state someone
      wants to clear before starting the next one. (backlog)
- [x] **T-12** The agent filter is scoped to the session it was chosen in (`filterFor`), and
      also drops itself if the chosen agent is not in the current events. Both paths reset
      to *All* rather than showing an empty timeline with nothing lit to explain it.
      (backlog)
- [ ] **T-54** The `×` on the **chat-picker** row is deliberately not built yet. That row
      already carries a trash icon that permanently deletes the recording; adding a second
      destructive-looking glyph beside it, meaning something else, is how people delete the
      wrong thing. It also has no backend operation behind it — a recorded session has no
      "slot" to free, and for a live one "clear" would have to mean *stop recording this
      chat*, which is a different feature. Decide what it should mean before drawing it.
- [x] **T-13** The problems badge now counts the `p.bad` rows the feed still holds instead
      of keeping a running total. The feed keeps 500 lines and drops the rest, so the total
      drifted away from what the Problems filter could show — "4 problems" above an empty
      list reads as a broken filter rather than as rows having aged out. Repaints in both
      directions: on a new problem, and when a quiet run of info lines evicts an old one.
      The badge hides again at zero. (backlog)

## P2 — the ChatGPT page is the hub (extension) — **T-14 and T-20 partly open**

The vision: everything visible in ChatGPT itself, through the extension. No switching to
the desktop app to find out what happened.

### What the 2026-08-16 live Fiber investigation changed

Three assumptions in the current extension are now known to be false, and they are the
reason T-15 has never worked outside one chat. **The selector is fine** — `span[class*=
"tool-message"]` + `[aria-label="Open tool call list"]` still finds the row in both a
working and a failing chat.

1. **One visible row is not one call.** An expanded row read
   `Called tool … 4 earlier tool calls hidden`, and its React props carried
   `collapsedSameToolCallCount: 4`. Clicking it opened a side panel with nine real calls.
   `planLabels(blocks, calls)` models one rendered block ↔ one recorded call; that is
   simply not what the renderer does.
2. **A collapsed row already knows exactly what it ran.** The comment in
   `chatgpt-dom.js:32-47` says a collapsed connector row carries no name, no tool id and
   no connector attribute. Its `__reactFiber$…` does: a few `.return` hops up reach props
   with `turn.messages`, where the request message has `recipient: "api_tool.call_tool"`
   and `content.text` JSON containing `path: "/TobisComputer/…/agent_status"`, and the
   paired result has `metadata.invoked_resource.{app_name, resource_uri}`. That
   distinguishes this connector from Gmail/Calendar, which nothing in the DOM does.
3. **The recorder cannot cover a long-lived chat's history.** Verified on disk:
   `2026-08-15-669ae2b4` (conversation `6a80ec6c…`) holds 21 events and **10** recorded
   tool calls, all attributed to `prime` — *not* zero as first reported — but every one of
   them is from a single turn on 2026-08-16, while the chat's visible connector rows go
   back days. The recorder only ever holds the slice it observed live, so relabelling from
   recorder history alone can never work on an old chat. This is inherent, not a bug.

- [x] **T-14** **Superseded by the app-owned synthetic stream; current status is tracked by T-88/T-91 and T-93–T-100.** The old plan tried to chronologically interleave ChatGPT-owned rows. Half of the original complaint is answered by
      T-15/T-56/T-16: the undifferentiated run of "Called tool" rows now names each call,
      says how many it stands for, opens the folded ones, and carries a time — so the order
      of the tool calls survives and is readable. What is still stacked is ChatGPT's own
      reasoning box above all of the tool rows, so a caption that happened *between* two
      calls still reads as if it came before both.

      **Two things block the rest, and neither is layout work.** (1) *No caption identity.*
      `progressLine()` returns only the **last** line of the `[data-interrupted]` box, so
      the extension has no per-caption node and cannot say which caption preceded which
      call — a merged stream needs reasoning messages out of `turn.messages` via `fiber.js`,
      i.e. a T-55 follow-on. (2) *Copying is not merging.* The captions are read out of a
      box the page is already rendering, so emitting them again between the tool rows shows
      each one twice; that was exactly the mistake the removed timeline block made. The
      real fix reorders ChatGPT's own nodes, which is the thing T-56 argues against.
      **Ordering source** when it is attempted: ChatGPT's message model is authoritative for
      everything ChatGPT knows about, because it is one sequence from one clock. Do not
      merge its `create_time` with the recorder's `time` numerically — see T-58.
- [x] **T-15** **Superseded as the primary path by the app-owned synthetic stream; current status is tracked by T-88/T-91.** Relabelling remains useful only as fallback/history evidence. Root cause was (1) and (3) above, not
      the selector and not the styling. Both halves are now in: rows are modelled as groups
      (T-56) and a row the recorder has no entry for is named from the page's own record
      (`applyPageLabel`) instead of staying "Called tool" forever. A page-named row is
      styled and worded as what it is — a name, not a finding: no icon, no outcome colour,
      no result or duration, and a tooltip saying where the name came from. It stays
      *unbound*, so a recorded call still takes the row over later; the recorder remains
      authoritative wherever it has an entry. 4 tests. **Still open:** confirm on the live
      page that the Fiber shapes `fiber.js` looks for are the ones actually there — every
      test for this necessarily runs against a fixture of the shape, which cannot prove the
      shape. This is the one part that a build cannot verify and T-53 must.
- [x] **T-55** **MAIN-world Fiber helper.** `extension/fiber.js`, plus a second
      `content_scripts` entry with `"world": "MAIN"`. It reads only the Fiber on connector
      rows, stamps each row with `data-clf-fiber="<index>"` so the two worlds agree on
      identity without racing React, and posts back an allowlisted descriptor: app name,
      tool name, path, message/turn/conversation id, timestamp, fold count, and whether a
      result has come back. **No argument values at all** — the request JSON has been
      observed carrying `agent_key` directly, and there is no key-level allowlist that
      generalises across tools, so none of it crosses. Native `postMessage`/`JSON.parse`
      captured at load; an unrecognised shape yields `null` for that row and the row keeps
      ChatGPT's own label. Pinned by two tests in `test/extension.test.ts`: the manifest
      really does put this and only this in the MAIN world, and the source touches no
      secret and serialises no whole object.
- [x] **T-56** **A connector row is a group, not a call.** `planLabels` now takes
      `{ callId, original, hidden }` and returns `[index, call, hiddenCalls]`. A row
      consumes `1 + hidden` calls and is labelled with the *last* of them, which is what
      "4 earlier tool calls hidden" means. The even-count fast path counts spans, so it no
      longer fires on mismatched sets — the old rule counted every row as one call and so
      produced confidently wrong labels on any collapsed turn, which is worse than the
      wall of "Called tool" it replaced. A group that does not fit is skipped rather than
      split. The row shows a `+N` chip naming the folded calls in its tooltip. 5 tests,
      including that a missing or nonsense fold count means no folding.
- [x] **T-57** **Trust boundary.** The page can post the helper's own messages, so
      `readDescriptor` rebuilds every descriptor field by field: version, integer index in
      range, tool name against `^[a-z0-9_.-]{1,64}$` **checked and never capped** (capping
      would turn a value that failed validation into one that passes), length limits on
      every string, and duplicate indices dropped on both sides rather than picking one.
      Evidence from here is presentation only: it may relabel a row already on the page,
      and it never writes a recorded event, decides an agent's identity, or vouches that a
      call belongs to this chat — `connectorRows()` still does that, from the DOM. 8 tests.
- [x] **T-16** **The shadow log is gone.** `injectTimeline`, `timelineRows`, the
      `progressByTurn` map and the `.clf-timeline*` rules are deleted. Taking it apart
      showed both of its halves were duplication: its tool rows restated rows already on
      the page a few pixels above it, and its progress captions are read by
      `progressLine()` straight out of the `[data-interrupted]` reasoning box the page is
      *already displaying*. The one thing it carried that the rows did not was the time,
      which is now a `.clf-when` on each relabelled row. The calls that genuinely had
      nowhere to appear are the ones ChatGPT collapsed into a neighbour, so the `+N` chip
      became a real control (`role="button"`, `aria-expanded`, Enter/Space) that opens
      them in a `.clf-fold-list` under the row — inside `block`, outside ChatGPT's header
      button, with the click stopped so one press does not also open the row's own card.
      Open/closed survives a repaint. 5 tests.
- [x] **T-58** **Superseded for the live renderer by the app-owned stream and generation-identity work tracked in T-88/T-94.** Live page-only events are stamped on first local observation instead of merging ChatGPT server time with the recorder clock. Historical page metadata still preserves page order. ChatGPT's `create_time` is server time; the recorder's `time`
      is this machine's. Interleaving them by numeric comparison will reorder events that
      are seconds apart. Order within each stream by that stream's own sequence, and place
      recorder-only items relative to their nearest *matched* neighbour rather than by
      absolute time. A matched pair is also the only honest place to measure the offset.
- [x] **T-17** Attribute each row to its agent (prime / worker-n / plain chat), so the page
      shows *which* agent ran *which* tool, not just that a tool ran.
      **Done.** `/activity` already carried `agent`; nothing consumed it. Each relabelled
      row now leads with a `.clf-agent` pill (plus `data-clf-agent`) in front of the title,
      read as a speaker prefix, and every folded call in the `.clf-fold-list` carries its
      own — that is where mixing agents up is easiest, because ChatGPT collapses rows by
      *tool name*, which says nothing about who called it, so one row can hide two agents'
      work behind a third's label. Nothing is shown in a chat with no agents, where there
      is one possible answer. Unlike page-sourced evidence this can be stated flatly: the
      app ran the call. `agentText()` still bounds it — an id long enough to push the tool
      name off the row would hide the point of the row. 4 tests.
- [x] **T-18** **The second field above the composer.** `.clf-stage` is the composer
      duplicated and set behind it — taller, joined by the hairline along its own bottom
      edge — mounted as a sibling *before* `composerBox()` rather than inside it, because
      a block element in ChatGPT's input row fights its layout and a click anywhere in
      there is turned into "focus the textarea". `compactionState` already carried
      `reasoning` and a 2 000-char `preview` of the streaming brief and nothing consumed
      them; `/activity` now sends both, capped to a 1 200-char tail. The panel shows the
      reasoning until the brief starts and the brief after that — two texts scrolling in
      one box is neither of them — and follows the tail only while the reader has not
      scrolled up, measured *before* the text is swapped. `stageView()` is pure and
      tested. **Both gates are on `mine`:** the app has one compaction slot and every tab
      polls the same state, so without them a chat sitting idle would stream a brief being
      written about a different conversation. Reasoning additionally respects
      `compaction.showReasoning`; the brief does not, since it is going into this chat
      either way. 7 extension tests + 2 bridge tests, plus
      `setCompactionStateForTests()`.

      *Deliberately unchanged:* the bootstrap still passes through the composer of the
      **fresh** chat for the ~500 ms `deliverCommand` spends confirming React took it.
      That window is the check that stopped blank worker tabs holding live leases, and
      shortening it trades a visible half-second for an invisible failure. What made it a
      wall of text was that it stayed on screen afterwards as a user message — T-19.
- [x] **T-19** **The opening instruction is folded away.** Both cases, by one mechanism:
      `/activity` returns `bootstrap: 'resume' | 'worker' | null` from the session's own
      `origin`, and `foldBootstrap()` moves the first user message's children into a
      `<details>` reading "not something you typed". Read off the session record rather
      than remembered in the tab, so it still holds when the chat is reopened days later;
      safe because `runCommand()` refuses to run once a conversation exists, so the first
      user message of an app-opened chat is ours by construction. **Moved, not copied** —
      two copies of a several-thousand-character brief in one page is the original problem
      with one of them merely hidden — and **folded, never removed**: it is real input a
      real model was given, and a transcript that quietly drops part of its own input is
      worse than a long one. The guard asks the DOM (`:scope > .clf-boot`) rather than a
      flag, so a React re-render that takes the fold with it is refolded instead of
      leaving the wall of text back on screen forever. 6 tests + 1 bridge test.
- [~] **T-20** **Live updates multiply.** The reopen flood is fixed at its root: `pagehide`
      fires both when a page goes away *and* when it is frozen into the back/forward cache,
      and `content.js` reported both as `closed`. So a bfcache round-trip ended the session
      and the next observation from the same tab reopened it — ten lines in 70 seconds
      across five tabs, with nothing having happened. `content.js` now ignores
      `event.persisted`, and as defence in depth the recorder only announces a reopen after
      `REOPEN_NOTICE_MS` (60s) of real absence: a reload or a brief disconnect is not news.
      2 tests in `test/content-script.test.ts`. **Still open:** the general "repeated
      identical rows" dedup in the Activity feed — needs a rule for what counts as the same
      row, which is not the same question as this one.
- [x] **T-21** Extension **auto-connects to the desktop app** with no manual step. Already
      true and verified while doing T-23/24/25: `call()` provisions on the first
      authenticated request and `status` provisions when the popup opens, so a browser
      that has never connected needs nothing typed. What was missing was the other end of
      it — see T-25 — not the connecting.
- [x] **T-22** **Session recording/write ON from first launch.** `DEFAULT_SESSIONS.record`
      is `true` (`src/main/config.ts`). Applies to configs that do not carry the key —
      somebody who already switched recording *off* keeps that choice, because flipping a
      privacy setting underneath a user is not a default change. 4 tests in
      `test/config.test.ts`; `test/mcp.test.ts`'s fixture now states its capabilities
      explicitly so the gating tests do not silently change meaning when a default moves.
- [x] **T-63** **The session store refuses to write before it has been told where.** Fallout
      from T-22, found in `git status`: `root` starts as `''` and `path.join('', id)` is a
      *relative* path, so an uninitialised store did not fail — it wrote real session folders
      into the process's working directory. Recording being off by default hid it entirely;
      turning it on left ten `2026-08-16-*/` recordings scattered through the repository
      (all `"title": "Unattributed activity"`, `conversationId: null`, one `list_roots` each —
      confirmed test artifacts before deleting). `assertReady()` now guards `sessionDir()`
      and `readAllSummaries()`, `test/mcp.test.ts` calls `initSessionStore(base)` because
      calling a real tool records it, and `unsetSessionRootForTests()` backs 2 tests in
      `test/session.test.ts` asserting the store throws instead of falling back.
- [x] **T-23** **Provisioning is singleflight.** `provision()` is now a wrapper that
      returns the `/pair` already in flight; `pairOnce()` does the work. Every caller —
      first use, popup, 401 recovery — waits on the same promise. Pinned by a test that
      fires four concurrent `status` messages and asserts the app minted exactly *one*
      token; it fails with 4 when the shared promise is removed, which is the loop
      described here: each `/pair` revokes the one before it, so every tab's next request
      401s and provisions again.
- [x] **T-24** **Polling volume.** `discover()` believes a confirmed port for
      `PORT_TRUST_MS` (30 s) instead of running a `/hello` in front of every authenticated
      request — that alone roughly doubled the traffic of a poll which already runs every
      two seconds in every open tab, against a 900/min budget. Nothing is lost: a request
      to a port the app has left throws, and the catch calls `forgetPort()` so the next
      call scans properly. Test: five `/activity` calls produce at most one `/hello`.
      *Still open:* `/commands` polling is per-worker already but is not a singleton
      across concurrent callers the way `/pair` now is.
- [~] **T-25** **Disconnect means disconnected.** Background/token semantics are done; page-control propagation remains T-82. `unpair` sets a `disconnected` flag as
      well as clearing the token, and `call()` refuses (`error: 'disconnected'`) rather
      than provisioning; `status` no longer provisions either, because opening the popup
      to check is not a request to undo the thing you opened it to check. Only `pair()`
      clears it. Stored in `chrome.storage.local`, not `session` — a choice a browser
      restart undoes is not a choice, it is a delay. The popup says "Disconnected" and
      offers "Connect this browser" instead of describing it as a connection that has not
      finished yet. 3 tests, including one that restarts the worker.

## P3 — multi-agent correctness

- [x] **T-26** **Default worker count 3 → 2.** `DEFAULT_MULTI_AGENT.maxWorkers` is now `2`
      (`src/main/config.ts`); three concurrent workers reproducibly trips ChatGPT's "too
      many requests". Multi-agent itself stays off by default — it opens browser tabs.
- [ ] **T-27** **Stop the tab storm.** Screenshot 2 shows a sidebar full of spinning "New
      chat" entries. Once a bootstrap has been sent and a concrete `conversationId`
      acknowledged, recovery must prefer that bound conversation. An expired join lease is
      not grounds for opening another tab; only a proven dead/closed original is. Regression
      test: a sent bootstrap with a known live conversation never spawns a second tab.
      (backlog)
- [ ] **T-28** **`join_agent` lands in Unattributed activity** while the worker stays
      `invited` — `join_agent rejected … Cannot safely identify this agent chat right now`
      in screenshot 1, reproduced live. Keep a browser-level regression on this path: a
      ChatGPT DOM change can otherwise turn every browser call unattributed in silence.
      (backlog)
- [x] **T-29** **Active zombie workers.** A worker can flip to `active` while the tool
      result carrying its `agent_key` is lost, leaving it unable to make keyed calls,
      message, or finish. Treat `active` as insufficient proof of health until the worker
      makes one keyed follow-up call. Make join-result delivery idempotently recoverable:
      the same bound conversation retrying must get a usable key back.
      Done: `join_agent` now always spends its evidence wait, and a conversation the
      extension has already reported as bound to an agent is routed to
      `joinBoundConversation()`, which rotates and re-issues the key. Authorisation is the
      reported binding *plus* a connector row rendered after the call began — never
      `provenConversation()`, which is documented as narrow-and-contradict only. The
      second half ("`active` is not proof of health until one keyed follow-up call")
      is **not** done and stays open as part of T-27's re-measurement.
- [ ] **T-30** **Resume bootstrap gives up.** `bootstrap failed on attempt 4 — ChatGPT
      refused the inserted text` → `gave up on resume:… — 4 attempts failed` (screenshot 1).
      Related to T-18: a smaller payload into a dedicated field should not be refused the
      way a giant composer insert is.
- [x] **T-31** `createAgents` must be transactional — a blank later worker currently can
      leave a half-created run behind. Pre-validate every task/label before any prime
      creation, worker insertion, secret minting, binding, or spawn.
      Done: the whole request is normalised and validated up front, worker ids are reserved
      for the request as a unit, and — the destructive half of the same bug — validation now
      runs *before* the orphaned-run takeover, so a refused request no longer ends somebody
      else's run and creates nothing in its place.
- [x] **T-32** `finish_agent` must be genuinely idempotent: a lost tool result plus retry
      must not produce a duplicate final report or rewrite `finishedAt`.
      Done: `finishAgent()` returns early for an already-terminal agent with `repeat: true`,
      and the tool answers a retry as a retry rather than as a second finish.
- [x] **T-33** Bridge queue overflow must reuse `drop()`'s cleanup rather than raw-shifting,
      or worker/resume state is orphaned.
      Done: overflow goes through `drop()`, so the evicted command's resume job ends and its
      worker slot fails instead of staying `invited` for good.
- [x] **T-34** `agent_message` events must survive compaction, count toward the token
      estimate, and render meaningfully — delivered worker reports in the prime session are
      what makes Compact & Resume continuity work at all.
      Done in all three places: tier 1 of `packSession` (with the direction stated, and a
      compaction rule telling the model how to read each direction), `eventTokens`, and the
      renderer timeline. The renderer half is now guarded by a test that checks *every*
      declared event kind has a case, since the `default` arm fails silently by design.

## P4 — surface the agents

- [x] **T-35** **Sub-agents are visible on Home beside the other tool permissions.** The
      Permissions card now has a Sub-agents row with the same master switch/expand pattern,
      shows the six broker tools it exposes, and mirrors the existing Chat-settings switch.
      The worker-count/detail settings stay in Chat; the important “is this tool surface
      exposed at all?” control is no longer buried there.

## P5 — cross-platform

**Do not mistake this for a packaging change.** Adding `dmg`/`AppImage` targets to
`electron-builder.yml` produces artifacts that install and then do not work. The blockers
are in the runtime, and mac/Linux parity may not be claimed until T-47 through T-51 are
actually done and a build has been run on each platform.

- [ ] **T-36** Make the Electron app run on **Linux and macOS** with no feature lost. The
      goal is that the code stops assuming Windows.
- [ ] **T-37** Replace platform branching with capability checks wherever that is cheap —
      more universal and more resilient, which is the actual point.
- [ ] **T-47** **Platform adapter layer.** One seam per OS-specific capability (shell,
      screen capture, input synthesis, window enumeration, process listing, path
      conventions, binary discovery), with a Windows implementation that is the current
      behaviour and real implementations behind it for the other two. Callers stop naming
      an OS.
- [ ] **T-48** `scripts/fetch-tunnel-client.mjs` hardcodes `PLATFORM='windows-amd64'`,
      shells out to `powershell.exe` for unzip/move, and asserts a `tunnel-client.exe`
      exists. Needs per-platform asset selection, a Node-native extract, and a
      platform-correct binary name/permission bit (`chmod +x` on POSIX).
- [ ] **T-49** `src/main/computer/index.ts` unconditionally spawns `powershell.exe` plus the
      Win32 helper (`src/main/computer/helper.ts`). This is the largest single blocker:
      screenshots, window focus, and input synthesis all need real macOS and Linux backends
      behind T-47, not a stub that reports success.
- [ ] **T-50** MCP tool descriptions, error strings, and desktop UI copy repeatedly hardcode
      Windows ("your Windows paths", NSIS/`%LOCALAPPDATA%` wording, backslash examples).
      Audit `src/main/mcp/tools.ts`, `mcp/instructions.ts`, `src/renderer/index.html` and
      the README; the model is told the host is Windows in several places and will act on it.
- [ ] **T-51** **Build matrix.** `electron-builder.yml` emits NSIS only and
      `dist`/`dist:dir` are `--win` only (`package.json`). Add mac and Linux targets *and* a
      way to actually build them; treat a target that has never produced a launched app as
      unsupported.
- [ ] **T-52** Config comments and UI say secret storage is Windows-only. Electron's
      `safeStorage` is already the right abstraction — lean on it and correct the copy
      (`src/main/secrets.ts`, `src/main/config.ts`).

## P6 — recorder / attribution hardening (backlog)

- [ ] **T-38** Presentation and compaction should order by `(time, seq)` while cursors stay
      monotonic by seq; deferred attribution can otherwise append a tool call physically
      after the `turn_end` it logically preceded. `summary.updatedAt` must never decrease.
- [ ] **T-39** Recorder grace can consume a connector block belonging to the *next* call,
      filing an earlier call into the chat that rendered it and starving the real owner.
      `test/agents.test.ts` currently works around it with `flushRecorder()`.
- [ ] **T-40** "Recent session" is not "live ChatGPT chat" — the unattributed stream must
      not be labelled "one live now" merely for being the most recently written.
- [ ] **T-41** `/closed` should clear bridge liveness immediately instead of leaving
      `conversationSeen` alive until TTL.
- [ ] **T-42** Contested sighting matching must keep ambiguity persistent: two overlapping
      calls and one row must not let the last contender take the row because the first
      timed out.
- [ ] **T-43** Provider-specific connector fingerprinting, so a second connector in the same
      account stops being a collision source. A MAIN-world helper may read a sanitized tool
      name and an opaque provider fingerprint only — never args, results, or tokens, and it
      must fail closed if the Fiber shape changes.
- [ ] **T-44** Read-only visual state should reflect *effective* enabled capabilities, not
      merely what is checked underneath the read-only suppression. The mixed Desktop group
      is the confusing case.
- [ ] **T-45** Test harness: `test/content-script.test.ts` prints async JSDOM
      `Cannot read properties of null (reading '_location')` after teardown. Suite is green,
      but the noise hides real async failures. Disconnect observers on teardown.
Promoted out of `POST_V1.5.1_HARDENING_BACKLOG.md` so the active list is the only queue:

- [ ] **T-59** Bounded crash window: a completed, attributed tool call exists only in RAM
      until it is persisted. A crash inside that window loses the one record of work that
      already happened to the user's files. (backlog)
- [x] **T-60** Terminal sender semantics: what a `finished`/`failed` agent's queued messages
      mean, and who may still send to or on behalf of one. T-10's clear path now creates
      these tombstones deliberately, so this is no longer hypothetical.
      Done: a terminal agent may no longer *send*. It keeps its credential on purpose (that
      is the only thing that lets a retried `finish_agent` be told apart from an impostor),
      and that retained credential was letting a worker go on queueing work for the prime
      after it had reported and stopped. Sending *to* a terminal agent was already refused;
      both refusals now name the agent and its state.
- [ ] **T-61** Resume success must distinguish **bootstrap typed / chat opened** from
      **handoff actually redeemed**. Reporting the first as success is what makes a failed
      resume look fine — see T-30. (backlog)
- [ ] **T-62** After an app restart, attribution grace should consider whether the browser
      companion is actually present, rather than inferring "no chats open" from an empty
      in-memory conversation map. (backlog)

- [ ] **T-64** Targeted wake into an existing worker chat. The bridge has exactly one
      command kind, `open-chat`, and the content script refuses to act on a tab that already
      has a conversation id, so the prime cannot reach a worker whose ChatGPT turn has ended.
      Doing it properly needs tab discovery by conversation id, repeatable (not one-shot)
      lease semantics, and a composer path that cannot overwrite what the user is typing —
      the invariant that path exists to protect. Only worth it if held finishes and
      checkpoints turn out not to be enough in practice. (backlog)
- [ ] **T-65** Delivery evidence beyond "the next authenticated call". Retirement of an
      offered agent message assumes the previous tool result arrived, which is evidence and
      not proof; the connector supplies no session id and no request id to tell a retry from
      a follow-on call. The unrecoverable case (a retried `finish_agent` acknowledging a
      message away and terminalising) is closed by `offeredOnFinish`, and a worker that ends
      with unconfirmed messages now says so in its report. The general case is still open and
      is not fixable locally: revisit if the transport ever gains an identity, or if the
      extension's own record of a rendered connector row can be made to stand in for one.
      (backlog)

- [ ] **T-66** A plain page reload re-registers the chat as new/most-recent in the app.
      Reported live 2026-08-16: reloading a ChatGPT tab — no new message, no new chat —
      makes the app treat that conversation as freshly arrived and push it to the top as
      the most recent chat. Not yet reproduced or traced. The likely candidates, in order:
      the content script re-announcing the conversation on every load so the app stamps a
      new "seen" time; `observe()` re-emitting the visible turns as fresh events on a cold
      start, since the journal that dedupes them lives in `chrome.storage.session` and a
      reload starts it empty; or the session store bumping its ordering key on any inbound
      activity rather than only on real new content. Whichever it is, the fix is that a
      reload must be recognised as *the same* conversation continuing, and re-observed
      history must not count as new activity. Check first whether it also duplicates
      recorded events, which would be the worse half of this. (backlog)

- [x] **T-67** **Superseded by the app-owned synthetic stream; current live gate is T-91.** Connector tool rows sit at the end of the assistant turn, not where the
      calls happened. Reported live 2026-08-16, with the labelling fix already working:
      a turn that reasons, calls a tool, reasons again and calls another renders as all
      the prose and reasoning first, then a block of tool rows at the bottom. That is
      ChatGPT's own layout, not something this extension does — nothing here moves a row —
      but it is what makes a long turn unreadable, because the row no longer sits next to
      the thinking that explains it. The rows now carry real tool names and the recorder
      knows each call's `time` and its position in the run, so the ordering information
      exists on both sides. Decide between: interleaving the rows back into the turn by
      moving ChatGPT's own nodes (accurate but the most invasive thing this extension
      would do to the page, and it fights every re-render); or leaving the rows alone and
      giving each one a marker that ties it to the reasoning step it belongs to. Check
      first whether the Fiber group node exposes the position of its messages within the
      turn — if it does, this is a read rather than a guess. (backlog)

- [x] **T-77** **Do not Compact & Resume a turn that is still generating.** The bridge now
      rejects `/compact` with `409 turn_still_generating` while that conversation has a
      live generating turn; the page maps it to “Wait for this ChatGPT turn to finish
      first.” Regression coverage lives in `test/resume.test.ts` and
      `test/content-script.test.ts`.
- [ ] **T-78** **Resume jobs need durable generation identity.** Commands survive app
      restart; `resumeJobs` do not. A restored stale resume command can coexist with a new
      job for the same session and later ack/end the wrong generation. Persist/reconstruct
      the job or key every command/job completion check by a generation/command id.
- [ ] **T-79** **Content observation queue must not silently drop oldest events.** The
      content-side queue is capped before the service worker's durable journal and can
      discard user/assistant/turn events with raw oldest-first eviction. Add priority/gap
      semantics and a regression under a stalled extension worker.
- [ ] **T-80** **Session metadata commits only after the event append succeeds.**
      `appendEvent()` currently increments `nextSeq`, mutates summary counters and schedules
      meta before `fs.appendFile` resolves. Disk-full/AV/transient failures can leave meta
      claiming events that never reached the log. Commit after success or rollback/rebuild;
      inject an append failure in tests.
- [ ] **T-81** **Agent↔conversation binding must not be last-writer-wins.** Duplicate/stale
      worker tabs can rebind the same agent to a different conversation and poison later
      attribution/recovery. Define conflict/terminal semantics and test two tabs racing one
      worker id.
- [x] **T-82** **Disconnect state reaches the ChatGPT page control.** `background.js`
      persists and reports deliberate disconnect, `content.js::checkStatus()` preserves
      it, and `controlState()` disables the action with the explicit “Browser connection
      is disconnected in ChatGPT Local Files” explanation. This closes the remaining half
      of T-25.
- [x] **T-83** **Conversation lifetime is tab-owned, not document-owned.** `pagehide` now
      only flushes observations; it never closes the app session, so a reload cannot kill
      the live turn. The service worker persists tab → conversation ownership in
      `storage.session` and `chrome.tabs.onRemoved` closes `/closed` only after the final
      tab for that conversation is gone. Two-tab regression coverage lives in
      `test/extension.test.ts`, document-reload coverage in `test/content-script.test.ts`.

- [x] **T-84** **Prime handover must retire the old chat-instance clock/state.** Live after
      Compact & Resume, the new prime was already running here while stale UI still looked
      like the old prime had been working for hours and the source session stayed tagged
      “opening fresh chat”. The broker now resets `prime.joinedAt` when a fresh prime
      redeems either handover path while preserving the run's `createdAt`; the desktop no
      longer derives a permanent busy badge from `compaction.stage === 'ready'`. Covered
      in `test/agents.test.ts`; live smoke still verifies the pixels.

- [x] **T-85** **Compact & Resume reasoning panel visually grows out of the ChatGPT composer.**
      The extension field now uses a full rounded composer-like surface, extends its empty
      lower padding behind the native input, keeps all actual text above that overlap,
      raises the reasoning/body font size and renders it at full opacity. This is geometry
      only; it never writes compaction text into ChatGPT's textarea.

- [x] **T-86** **Session delete no longer sits over the chat age.** The timestamp itself
      reserves the delete button's hover hit target, instead of hoping parent padding wins
      against an absolutely-positioned button in flex layout. The layout regression checks
      the reserved timestamp margin directly.

- [x] **T-87** **Hide Compact & Resume on an empty ChatGPT chat.** A fresh `/` page has
      nothing to compact, so the extension no longer injects a disabled “Send a message
      first” control that eats composer width. The control is mounted only after ChatGPT
      assigns a conversation id on the first sent turn, and is removed again if navigation
      returns to a brand-new chat. Covered in `test/content-script.test.ts`.

- [x] **T-115** **Auto-compaction, configurable — built in 1.7.4, not yet live-verified.**
      Requested by Tobias on 2026-08-17; **supersedes any older planning text that reads
      auto-compaction as parked or as a future idea, T-92 included.** The two entries answer
      different questions — T-92 says which provider writes a handoff that has been asked
      for, this one says when one is asked for at all — and where they appear to overlap,
      this one governs.

      Shipped as `compaction.auto` / `autoTokens` / `autoProvider`: off by default, the
      threshold defaulting to the advisory line the app already warns at, and the provider
      defaulting to ChatGPT. Flash becomes the automatic provider only by being chosen,
      which is why the provider is asked separately from the switch rather than inherited
      from the last manual press. Not silent fallback, and T-92 does not forbid it: nothing
      here lets the app pick a provider on its own, and with the switch off the behaviour is
      exactly what it was.

      Lifecycle, as corrected by Tobias: the cycle repeats indefinitely — a chat crosses the
      threshold, compacts, resumes into a fresh chat, and that chat later crosses it in
      turn. The guard is `autoTried`, keyed on the conversation being compacted, because the
      source chat stays above the threshold forever afterwards (compacting does not shorten
      it, it opens a different one) and a bare threshold comparison would re-ask every two
      seconds for as long as the tab stayed open. A failed or cancelled attempt does not
      clear the key: a provider that could not write a brief a moment ago is unlikely to
      manage it on the next poll, and a retry loop against a failing provider is the shape of
      a run that spends money all night. Pressing the button clears it by starting a run the
      user asked for. It also declines to interrupt a turn already in progress, and goes
      through `startCompact` so it inherits the same stop/settle barrier as a press.

      Covered in `test/content-script.test.ts` and `test/config.test.ts`, including that a
      config written before these fields existed reads as off. **Not yet exercised on a live
      page** — the threshold has only ever been crossed in a fixture.

- [x] **T-116** **Context-window meter — built in 1.7.4, not yet seen on a live page.** A
      two-pixel track along the bottom of the Compact & resume button, filling as the
      conversation does, amber approaching and red at the line, with the numbers in the
      hover text. On the button rather than beside it: composer width is scarce, and a
      separate widget would have to earn its own space and then explain what it had to do
      with the button next to it.

      What it fills *towards* depends on the settings, which is the part worth keeping
      straight. With auto-compaction on it is the threshold, because that is where
      something will actually happen; with it off it is the app's own limit, turning amber
      at the advisory line on the way. Both numbers, and the count itself, arrive in the
      `/activity` payload as `tokens` and `context` — the same fields T-115's trigger reads,
      so the bar someone is watching and the threshold that acts are the same number. A
      meter that filled against a figure of its own would show a full bar and do nothing, or
      compact a conversation that still looked half empty. Nothing is scraped from the page.

      Says "roughly", and means it: this counts what the recording holds, which is what a
      brief would be written from — not ChatGPT's own accounting of its window, which the
      page cannot see.

- [~] **T-117 — Overwrite is now ON by default and user-controllable; live browser validation
      is the remaining gate.** Tobias explicitly reversed the old fail-closed policy on
      2026-08-17. Production `content.js` defaults `RENDER_STREAM` to true, then loads the
      persistent `chrome.storage.local.renderStreamEnabled` preference before first paint so
      somebody who switched it OFF does not get a flash of replacement UI. The popup now has
      a persistent ON/OFF switch plus **Overwrite now**; the latter broadcasts through the
      background worker's existing tab→conversation registry and tells each known ChatGPT
      content script to pull activity and rebuild immediately. OFF runs the existing
      `unpaint()`/restore path, removes `.clf-stream`, unhides native commentary/tool rows and
      leaves capture running. Focused regression run on 2026-08-17: `content-script`,
      `extension`, `bridge` = **210 passed**.

      The safe boundary is unchanged: live reasoning/commentary/tool activity may be owned by
      the extension, while settled final rich Markdown/citations remain ChatGPT/React-owned.
      Do not clone or permanently hide that final prose yet. **Still open:** reload the
      unpacked extension in Chrome, hard-reload a real ChatGPT conversation, visually verify
      default ON, toggle OFF→ON, press Overwrite now, and confirm no blank/duplicate native
      rows across a live then settled turn. Only that live smoke closes T-117/T-91.

- [x] **T-127** Conversation-scoped working folder, so a coding chat stops repeating
      `/totec/chatgpt-local-files/` on every call. **Resolved 2026-08-17.**

      Design constraint found first, and it dictated everything else: there is no
      per-conversation identity at tool-call time. `dispatch` sets `caller.conversationId`
      to null on purpose (`kernel.ts`), and `transportIdentityStatus()` measures that the
      connector supplies no session id. So identity is an ordered ladder — the agent id when
      multi-agent is on, otherwise the single ChatGPT chat that is mid-turn — and when
      neither answers there is **no** workspace and a relative path is refused with the
      absolute form to write instead. Ambiguity costs a retry, never a wrong file. No
      workspace id, no workspace tool, nothing model-visible to set.

      `src/main/workspace.ts` holds it; `resolveIn()` in `kernel.ts` is the single choke
      point every tool path argument now goes through, which both applies the folder and
      learns it from absolute paths. The sandbox is unchanged underneath: prefixing happens
      *before* validation, so `..` still meets `checkSegment` segment by segment. Workers
      inherit the prime's folder at spawn and may then diverge; the folder rides the handoff
      through a compaction and is re-resolved (not trusted) on resume.

      Two edge cases caught in review and fixed before landing. Inheritance read only
      `currentWorkspace()`, which finds `agent:prime` from the second spawn onwards while
      everything the prime learned sits under `chat:<conversation>` — later workers silently
      inherited nothing; `primeWorkspace()` now reads both keys and mirrors the answer back.
      And `apply_patch` joined its base onto the patch path and `posix.normalize`d the result
      before the sandbox saw it, erasing the `..`: with cwd `/workspace/nested`,
      `../escaped.txt` landed at `/workspace/escaped.txt` with no error at all. Patch paths
      now go to `resolveIn` verbatim with the base alongside. Negative check on 2026-08-17:
      restoring the old normalise makes that regression pass the write through.

      31 tests in `test/workspace.test.ts`, plus patch-escape and resume cases in
      `test/mcp.test.ts`. **Known gap:** the OpenRouter compaction path names a session, not
      a chat, so it recovers the folder via `soleConversationForSession()` and carries none
      when two chats share a session. The ChatGPT-native path (the default) carries it
      directly.

- [x] **T-128** Automatic compaction on by default at the 400k ceiling, and the meter now
      says `283k/400k · autocompact on` as its first tooltip line. **Resolved 2026-08-17.**
      A one-time migration moves a config still carrying both old defaults (`off` / 300k)
      onto the new one and leaves anything a user actually chose alone.

- [x] **T-129** A ChatGPT reload mid-turn records the turn two or three times over. **Resolved
      2026-08-19.** From
      the real log `2026-08-17-30c5be99`: turn `g-w2vck21rmu96n-1-4` (seq 3) never gets a
      `turn_end`, a reload at ~8:20:19 opens `g-6ywrgby6cavy-0-1` (seq 43) and re-records
      the same six commentary captions at observation time, then a `turn_end` carrying **no
      turnId** (seq 58) is followed by a third `turn_start` (seq 59) re-recording them
      again. The visible symptom is the injected stream appearing to start at the reload
      moment with everything before it gone.

      All three failure modes now have active regressions. (1) Reload identity remains pending
      until a successful `/activity` pull supplies the app's durable open turn; Stop cannot
      mint a replacement while that question is unanswered. (2) Reload capture is canonical
      Fiber-v8 message/activity identity, so settled history is not replayed as the adopted
      turn and everything genuinely after reload keeps the resumed local id. The tests cover
      both a turn that remained live and one that finished inside the reload gap. (3) Both
      `content.js` and the recorder fail closed on unnamed lifecycle boundaries, and a stale
      named end can no longer tear down a newer active generation. The seven-test
      `a content script reloaded into a turn already in flight` block is fully enabled.

- [ ] **T-46** Self-update: never invoke the NSIS installer synchronously from the running
      MCP process — it kills the process carrying the call and has left a stale `app.asar`
      installed. Detach the installer, persist a post-install verification marker, and only
      report success once the restarted app verifies installed hashes against the staged
      build. (backlog)

---

## Decided — do not re-open

- **Chat card header shape (T-8/T-9).** Exactly one primary action, *Compact & resume*,
  plus a gear icon. No standalone Compact button. Settings is not a peer tab of
  Timeline/Compaction.
- **Recording default (T-22).** Session recording/write is ON from first launch. Decided,
  not a question.
