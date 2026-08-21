# Extension background/lifecycle and performance audit

**Date:** 2026-08-21 (Europe/Berlin)  
**Repository:** `C:\Users\totec\chatgpt-local-files`  
**Scope:** `extension/background.js`, `extension/manifest.json`, `extension/popup.*`, the
content/background protocol edges in `extension/content.js`, and the existing extension
tests.  
**Boundary:** source, tests, AppData and configuration were read-only. The only repository
write from this audit is this report. No product/test code was changed and no commit/build was
made.

## Method and evidence

I read `AGENTS.md` completely and then read
`bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` completely before tracing
the current worktree. Existing tests were not re-run for this pass, per the parent audit's
instruction that they are already green; the findings below come from current source and
adversarial ordering traces not covered by those tests.

The following source probes were run from the repository root:

```text
rg -n "drain\(|type: 'drain'|restoreOpenChatgptTabs\(\)|chrome\.alarms" extension/background.js extension/content.js
420:async function drain() {
810:    await drain();
852:  await drain();
986:    const result = await drain();
1006:      await drain();
1010:  async drain() {
1177:async function restoreOpenChatgptTabs() {
1221:  void restoreOpenChatgptTabs();
1228:void restoreOpenChatgptTabs();

rg -n "AbortController|async function call|serializeTab|pulling = true|flushing = true" extension/background.js extension/content.js
478:  const controller = new AbortController();
546:async function call(path, init = {}, retried = false) {
883:function serializeTab(tab, operation) {
3518:    pulling = true;
```

The only `AbortController` hit is the bounded `/hello` probe at
`background.js:477-493`; the authenticated `call()` fetch at `background.js:560-568`
has no signal or deadline.

## Findings (current tree)

### F1 — HIGH — pending journal entries have no autonomous retry; tab close has no durable close outbox

**Status:** SOURCE, current. This is a delivery/lifecycle gap, not a schema or recorder
deduplication issue.

**Evidence:**

- `background.js:420-422` returns from `drain()` whenever there is no token, and
  `background.js:464-467` stops on any non-OK `/events` response while retaining the journal.
- The only direct drain call sites are event ingestion (`background.js:973-988`), a bind
  (`background.js:998-1008`), and tab transition/close (`background.js:809-812`,
  `background.js:851-857`). `HANDLERS.activity` (`background.js:1013-1020`), `status`
  (`background.js:898-912`) and `pair` (`background.js:914-917`) do not drain pending data.
  There is no alarm or worker-owned retry timer in `manifest.json` or `background.js`.
- `content.js:577-587` intentionally removes a page batch as soon as the worker reports
  `durable: true`; that is correct only if the worker later has a way to retry delivery.
- `releaseTab()` deletes `tabConversations[key]` and persists that deletion before its one
  `drain()`/`/closed` attempt (`background.js:840-857`). A failed `/closed` is not stored as a
  pending close and no later status/pair event retries it.

**Repro ordering:**

1. Keep a ChatGPT tab open and make the app unavailable (or deliberately disconnect the
   browser). Emit one observation. `events()` persists it, `drain()` returns with a positive
   `pending` count (or breaks on `app_not_found`), and the content script drops its page copy
   because `durable === true`.
2. Start/connect the app while the chat is idle. The regular `activity` and `status` traffic
   reaches the worker, but neither path calls `drain()`. No subsequent `POST /events` occurs.
3. Close the tab while the bridge is unavailable. The local mapping is removed, the single
   `/closed` call fails, and the worker retains no close intent to retry after reconnect.

**Impact:** durable observations can remain in `chrome.storage.session` indefinitely while
the user sees no delivery; an idle chat never flushes merely because the bridge came back.
Closing during an outage can leave the app-side conversation open forever, or permit a later
retry of events after the app has already been told the browser view closed. A permanently
bad first conversation also blocks every later conversation because `drain()` breaks instead
of isolating/retrying per conversation (`background.js:426-430`, `464-467`).

**Fix direction:** make the journal an explicit per-conversation outbox with a durable retry
state, bounded exponential backoff and a reconnect/status-triggered drain. Keep failed
conversations from starving other conversations, and retain a separate durable `/closed`
outbox until the app acknowledges it. Distinguish “stored in the browser journal” from
“accepted by the app” in diagnostics; do not solve this by dropping the durable journal.

**Confidence:** HIGH for the missing retry/close state from source. The exact browser/app
outage timing is a deterministic trigger; live bridge outage behavior was not claimed.

**Residual of prior A7:** the old cross-chat provisional bind is no longer reproduced because
`tabKey()` now includes `documentId` (`background.js:692-695`) and terminal cleanup purges that
document's provisional entries (`background.js:771-785`, `826-838`). However, that change
trades the old misbind for silent loss on a fresh chat reload: an opening observation queued
under `tab-T:document-old` cannot be rebound by `document-new`, despite the comment at
`background.js:994-996` saying the tab key survives reload. The purge emits no gap marker.

### F2 — HIGH — same-document SPA navigation has no epoch in the background protocol

**Status:** SOURCE, current. `documentId` protects a browser document, but not visits/routes
inside that document.

**Evidence:**

- `authorizeDocument()` and `ownsDocument()` validate only tab/document ownership and the
  terminal lease (`background.js:720-740`, `761-769`). `releaseTab()` accepts an expected
  conversation and document but no navigation generation (`background.js:826-857`).
- On an A → B route change, content sends the old close asynchronously at
  `content.js:1110-1118`; it increments its local `epoch` only after queuing that message.
  The message contains no epoch.
- `deliverCommand()` checks that the route is fresh only once, before its first await
  (`content.js:4763-4774`), then waits for the composer and inserts/sends without checking
  the route/epoch again (`content.js:4800-4832`). It polls a mutable current conversation
  and ACKs that as the command's destination (`content.js:4839-4849`).
- `startCompact()` similarly awaits a 15–20 second stop/settle barrier and then uses the
  mutable `conversationId` without an epoch guard (`content.js:4226-4260`).

**Repro ordering:**

1. Tab T/document D is on chat A. Navigate A → B. The content script queues
   `closed(A)` and increments its local epoch.
2. Before the worker processes that message, navigate B → A and let the new observation/bind
   restore `tabConversations[T] = A`.
3. The delayed `closed(A)` is still authorized: the document is D and the expected
   conversation is A. `releaseTab()` removes the *new* A mapping and posts `/closed`, because
   it has no way to tell the old A visit from the new A visit.

The same missing epoch exists in a marked bootstrap: redeem on a fresh route, navigate the
same document into an existing chat while `waitForComposer()` is pending, and the command can
insert/send into that unrelated chat. A compact operation can similarly finish its barrier
after the user has navigated.

**Impact:** stale same-document work can close or mutate the wrong ChatGPT visit, split local
session continuity on A → B → A, insert a worker/resume prompt into a user chat, or compact a
different conversation. The per-tab queue serializes messages but does not identify their
navigation generation, so serialization alone cannot reject this ordering.

**Fix direction:** carry a content navigation epoch/nonce in every owned message and have the
worker retain the current epoch per document; reject stale `closed`, `events`, `compact`,
`redeem` and `ack` messages. Re-check epoch and route immediately before every command/compact
side effect, and bind command ACKs to the captured destination rather than a mutable global.
`documentId` remains necessary but is not sufficient.

**Confidence:** HIGH for the protocol gap; the repro requires a deliberately delayed bridge or
fast A → B → A route, not a timing assumption in the implementation.

### F3 — HIGH/MEDIUM — authenticated bridge requests have no deadline and can pin worker/page lifetimes

**Status:** SOURCE; live occurrence depends on a loopback listener that accepts a request but
does not complete it, so the platform portion is unverified.

**Evidence:**

- Only `hello()` creates an `AbortController` and clears its timer
  (`background.js:477-493`). The authenticated `call()` sends `/events`, `/activity`,
  `/closed`, `/compact` and command requests with a bare `fetch()` and no timeout or signal
  (`background.js:546-568`).
- `content.js:3516-3655` holds `pulling = true` across the whole `ask({type:'activity'})`
  call; `content.js:559-590` holds `flushing = true` across event delivery.
- All owned background operations for a tab are chained by `serializeTab()`
  (`background.js:880-891`, used at `1117-1121`). A hung fetch therefore also queues
  navigation, close, registration and later observations for that tab indefinitely.

**Repro ordering:** point the loopback port at a listener that accepts an authenticated
`/activity` connection and never sends response headers. The first pull remains pending;
`pulling` never resets, and a subsequent `tabs.onUpdated`/`tabs.onRemoved` operation waits
behind the unresolved tab queue. Repeat with multiple tabs to multiply unresolved fetches and
page queues. The source probe above shows that the only existing timeout is for `/hello`.

**Impact:** a frozen app can keep a service-worker event alive, prevent `/closed` from being
posted, stop activity/liveness updates, and accumulate page-local events up to the 400-entry
gap path. When the bridge eventually recovers, the old request has no cancellation or
idempotency result to tell the caller whether it committed.

**Fix direction:** wrap every bridge request in a bounded AbortController deadline; classify
timeout separately from an HTTP refusal, release the tab operation queue, and use bounded
backoff/jitter for subsequent delivery. Preserve journal/close outbox entries across the
timeout so a retry does not silently turn an ambiguous commit into a drop.

**Confidence:** HIGH for the missing deadline and queue pinning; MEDIUM for the exact Chrome
service-worker lifetime effect because a real frozen loopback server was not run.

### F4 — MEDIUM/HIGH — pair/unpair has a generation race and local state writes are not serialized

**Status:** SOURCE. The in-memory reconnect race is deterministic; out-of-order persistence is
an additional platform-dependent risk.

**Evidence:**

- `persist()` writes the whole `{port, token, disconnected}` snapshot directly with no write
  queue (`background.js:169-171`). It is called concurrently from discovery (`530-536`),
  401 recovery (`573-576`), pairing (`625-629`) and unpair (`918-924`).
- `provision()` single-flights only other pair requests (`background.js:600-608`); it does not
  serialize against `unpair()`.
- A successful `pairOnce()` unconditionally sets `token` and `disconnected = false`
  (`background.js:611-629`), while `unpair()` sets `token = null` and `disconnected = true`
  (`background.js:918-925`).

**Repro ordering:** delay `/pair` after `status()` or a stale-token 401 has started
`provision()`. Send `unpair()` before `/pair` completes. `unpair()` records the user's
disconnect, then the late pair response restores a token and clears `disconnected`, so the
next poll is connected again without a new user connect action. Concurrent direct
`storage.local.set` calls also have no version/serialization guard; if the browser commits a
stale snapshot last, a service-worker restart can restore the wrong token/disconnect state.

**Impact:** “Disconnect this browser” can be undone by an already-running request; token
rotation/re-provision can oscillate under 401 or app-restart races; restart behavior can differ
from the visible in-memory state. This is particularly harmful because all future content polls
trust the persisted `disconnected` flag.

**Fix direction:** use one serialized connection-state transaction for pair, unpair, port
discovery and 401 recovery. Give pair attempts a generation; unpair invalidates older attempts
and a late response may not mutate state. Serialize/version `storage.local` snapshots and only
publish the newest generation.

**Confidence:** HIGH for the pair/unpair ordering; MEDIUM for Chrome's exact cross-call write
ordering, which should be verified with a real extension probe.

### F5 — MEDIUM/HIGH — Fiber repair and worker-start recovery retry forever without a circuit breaker

**Status:** SOURCE, current; primarily a performance/resource issue.

**Evidence:**

- A failed `askFiber()` starts `repair_fiber` at most once every five seconds
  (`content.js:1860-1875`), but there is no failure count, terminal state or exponential
  backoff. A failed/unsupported helper is simply marked absent at `1881-1885`, so the next
  five-second window starts another repair.
- `pullActivity()` calls `refreshFiber()` on every activity poll, including idle chats
  (`content.js:3516-3524`, `3642-3645`), and the poll runs every two seconds
  (`content.js:5005`). `repair_fiber` executes `fiber.js` in the page on each attempt
  (`background.js:1022-1035`).
- Worker module evaluation calls `restoreOpenChatgptTabs()` unconditionally
  (`background.js:1224-1228`), and the `runtime.onInstalled` callback calls it again
  (`background.js:1220-1222`). A healthy tab ping still injects MAIN-world Fiber
  (`background.js:1188-1195`), so ordinary cold-worker starts fan out one ping/injection per
  open ChatGPT tab; install/update can start two scans concurrently.

**Repro ordering:** keep a conversation open with `content.js` alive but remove/block the
Fiber listener (or make the page shape unsupported). Each activity poll times out after
1.5 seconds, and every five seconds another `repair_fiber` injection is attempted forever.
With N tabs, this is N independent retry loops. A service-worker restart additionally scans
all tabs; an install/update can overlap the module-start and `onInstalled` scans.

**Impact:** persistent script injection, MAIN/isolated-world message churn, CPU and page
thread work, and repeated worker wakeups during a permanent incompatibility. On a large tab
set this can amplify a single ChatGPT markup/Fiber failure into sustained browser load. It can
also interleave with a live scan, making the observed Fiber health less stable.

**Fix direction:** track repair failures per document/protocol, use exponential backoff with a
bounded circuit breaker, and retry on a concrete navigation or explicit user recovery rather
than forever. Make startup recovery singleflight and run it only for installation/update or an
explicit health failure; target the current `documentId` where Chrome supports it.

**Confidence:** HIGH for the unbounded retry and duplicate startup invocations from source;
the exact CPU cost is scale-dependent.

## Prior findings: accepted, resolved, or narrowed

- **A2 (content health ping did not validate Fiber):** the exact current path is fixed/narrowed.
  `restoreOpenChatgptTabs()` now injects MAIN-world `fiber.js` even after a healthy recorder
  ping (`background.js:1188-1195`), and content can request `repair_fiber` (`1022-1035`).
  F5 above is the remaining retry/backoff gap, not a re-report of A2.
- **A3 (sticky `fiberPresent` disabled DOM completion fallback):** the current repair failure
  path clears `fiberPresent` and its caches (`content.js:1881-1885`); not promoted as still
  live.
- **A7 (provisional observations rebound from one fresh chat to a later tab reuse):** the
  current document-scoped key and terminal purge prevent the tested cross-chat rebind. The
  silent-loss residual is recorded under F1.
- **A8 (external navigation/delayed old-document IPC resurrected ownership):** the current
  terminal lease, retired document list and per-tab serialization address the documented
  old-document ordering. F2 identifies the unaddressed same-document SPA epoch ordering.
- **A9/A10 (duplicate lifecycle replay and page-queue loss):** current recorder lifecycle
  dedupe and explicit page/service-worker gap markers are present; neither was re-promoted.

## Rejected or not promoted

- The removed `opened`/`chrome.alarms` command-poll path is not a current bug. The manifest has
  no alarm permission and command delivery is intentionally app-opened plus marker-based.
- A recursive worker restart loop from `restoreOpenChatgptTabs()` was not found: reinjection
  does not itself fire `onInstalled`. The concern is duplicate/fan-out work on worker starts,
  covered by F5.
- A full live Chrome `tabs.onUpdated`/`webNavigation` ordering repro was not available, so
  claims about which event Chrome emits first are not stated as confirmed. The missing
  same-document epoch is source-proven independently of that platform ordering.

## Unverified live-platform risks to verify separately

- Whether a real Chrome `storage.session` quota failure is reached first by the 4 MiB journal
  or by the unbounded `tabDocuments`, `retiredDocuments` and `terminalDocuments` maps
  (`background.js:109-114`, `175-189`). Those maps are never pruned for closed tabs; a long
  browser session can eventually make `persistLive()` fail, after which in-memory ownership
  and restored ownership diverge.
- `pagehide` calls `void flush()` (`content.js:4863-4874`) without a browser keepalive. A
  mutation immediately before document teardown may still be lost despite the normal
  one-second flush; this needs a live reload/navigation probe, not a source-only claim.

