# Worker identity adversarial analysis (current dirty tree)

Date: 2026-08-20. Scope: Prime `agents spawn` through bridge command delivery, fresh-chat redemption/ACK, worker binding, first MCP request, request correlation, recorder/session attribution, inbox delivery, finish, restart and late repair. This report is read-only analysis; the only file changed is this report.

## Ranked findings

### 1. HIGH — runtime Fiber disappearance still has no self-repair path

**Current refs:** `extension/content.js:1735-1783` (`askFiber`), `1790-1810` (`refreshFiber`); `extension/background.js:978-1018` (`restoreOpenChatgptTabs`).

**Evidence/repro:** `refreshFiber()` returns immediately when the MAIN-world helper does not answer (`content.js:1804`). The content script does not clear/recover Fiber, send a repair request to the service worker, or reinject `fiber.js`. The only current reinjection is startup/extension-reload recovery in `background.js`; the healthy-content ping path now explicitly reinjects Fiber (`background.js:992-997`), so the old A2 health-blind-spot is fixed for startup/reload. A helper that is removed, loses its listener, or becomes stale after startup therefore remains absent for the whole document.

**Earliest wrong transition:** `askFiber()` timeout is treated as a normal degraded scan rather than a recoverable capability loss. The next request's `metadata.request_id` is never emitted; `src/main/session/correlation.ts` consequently has no exact entry, and `recorder.ts:984-996` eventually files the MCP call in Unattributed after its grace. `tools-core.ts:1107-1124` then refuses the worker's `agents` call as identity lost (or the ordinary call continues without worker identity/inbox).

**Status:** Not fixed in the dirty tree. The startup/reload repair change is present and test coverage at `test/extension.test.ts:648-658` covers it, but no runtime-loss test or repair exists.

**Missing negative case:** Fiber answers once, then its listener is removed or the MAIN-world script is replaced; a subsequent worker call must trigger repair and correlate to the bound worker, while a genuinely navigated/closed tab must not be reinjected or resurrected.

**Minimal fix:** On a bounded `askFiber()` timeout, mark Fiber unavailable and request a tab-scoped background repair (or use a content-side `chrome.runtime.sendMessage` repair command). Background must reinject only if the sender's current document is still the same ChatGPT tab/epoch; retry with backoff and keep exact request evidence fail-closed until a successful reply. Add a VM regression for timeout → repair → exact request evidence.

### 2. HIGH/MEDIUM — `fiberPresent` is sticky and can convert later worker turns into false stalls

**Current refs:** `extension/content.js:715-725` resets `fiberPresent` only on conversation reset; `1735-1810` sets it true after a successful answer; `889-905` gates DOM completion on `!fiberPresent`; `1208-1230` continuously calls `refreshFiber` during generation.

**Evidence/repro:** Once any Fiber answer succeeds, `fiberPresent = true`. A later timeout leaves it true because the `answer === null` branch returns without clearing it. `endOutcome()` then refuses the DOM completion fallback even when final prose is visible. The generation can remain open until the ten-minute stall path at `content.js:1228-1230`, emitting a false no-progress error. This reproduces the same amplification seen in the retained worker-5 incident: the worker can be actively issuing MCP calls, but absent Fiber page evidence means no `/activity` tool liveness reaches its bound conversation.

**Earliest wrong transition:** a historical capability bit (“Fiber answered once”) is used as a current capability bit after an unanswered round.

**Status:** Not fixed. The dirty tree added comments and a new-message fallback (`content.js:1121-1127`), but does not downgrade `fiberPresent` on timeout.

**Missing negative case:** Fiber success → helper loss → visible final assistant answer must end `completed` through degraded DOM fallback; a true still-generating turn must remain open/stall only after the normal bound.

**Minimal fix:** Track `fiberHealthy` separately from `fiberEverWorked`; set false on timeout/protocol failure, true only after a validated reply, and use `fiberHealthy` for completion/fiber-derived rendering gates. Preserve `fiberEverWorked` only for diagnostics.

### 3. HIGH — first worker MCP call can execute before exact correlation and split control-plane identity from session attribution

**Current refs:** `src/main/mcp/kernel.ts:350-438`, `src/main/mcp/tools-core.ts:1107-1138`, `src/main/session/recorder.ts:978-1012`.

**Evidence/repro:** Worker binding itself is early and correct: `/commands/ack` calls `bindConversation(agent, conversation)` before `ackCommand` (`src/main/bridge.ts:1078-1140`), and `agents.ts:1165-1228` makes binding+activation atomic. However, the first worker MCP call still needs Fiber to report the exact request id. `callerNow()` waits up to `IDENTITY_EVIDENCE_MS` only inside the `agents` tool; ordinary calls use the nonblocking dispatcher identity and can be recorded Unattributed while their later exact evidence is still pending. If Fiber is missing, the worker's first `agents` call returns identity lost even though the broker already knows the worker conversation. The retained worker-5 evidence is this exact split: bound worker lifecycle, stable HTTP request id, 67 calls in Unattributed, no correlation entry.

**Earliest wrong transition:** page-model request evidence is unavailable after the command ACK, but the system continues ordinary MCP execution instead of exposing a run-level “bound conversation” recovery for that exact sender.

**Status:** Partially mitigated, not fixed. Dirty changes add 15-second exact-ID waiting, late deterministic repair, and `adoptAgent()` preservation (`kernel.ts:412-416`), but those still require Fiber evidence; there is no bridge-issued proof attached to the MCP transport.

**Missing negative case:** A worker bound by the app sends its first MCP call before Fiber has answered. The call must either be held/repaired by exact request id or be durably marked pending for later deterministic attribution; `agents` must not strand the worker's inbox while ordinary calls continue.

**Minimal fix:** Keep the current exact request-id security rule, but add a bounded worker bootstrap/attribution state: after ACK binding, let the first request wait for the exact page evidence and surface a recoverable `IDENTITY_EVIDENCE_PENDING` result, or persist a per-document proof token that the bridge generated and the content script can attach only to that command-owned document. Do not infer from active tab or timing.

### 4. MEDIUM — stale ACK after command retirement fails closed but can strand a real worker without a visible recovery path

**Current refs:** `src/main/bridge.ts:1696-1705` (`expire`), `1807-1825` (`tidyCommands`), `1880-1935` (`ackCommand`); `extension/content.js:4717-4725`.

**Evidence/repro:** The page sends `status:'sent'` after typing even if it never observed a conversation id (`content.js:4725`). If the command deadline expires first, `expire()` sees the worker still `invited` and calls `drop()`, which fails the worker. The later ACK gets no command (`ackCommand` returns at line 1882), so it cannot bind the conversation. This is safe against stale takeover, but the already-running fresh tab becomes a stranger; it can only recover via the manually minted join key, which is never surfaced to the ordinary page.

**Earliest wrong transition:** command expiry terminalises the invited slot before a delayed `/c/<id>`/ACK can complete the app-owned binding.

**Status:** Intentional fail-closed behavior, but operationally incomplete. Lease renewal on redeem and command-owner checks are current dirty-tree fixes; no delayed-ACK recovery test exists.

**Missing negative case:** send succeeds, `/c/id` appears just after the deadline, ACK is delayed/retried, and the worker must receive one explicit recoverable outcome rather than silently becoming an unrelated chat.

**Minimal fix:** Preserve the no-rebind rule, but retain a short post-expiry tombstone keyed by command id/document owner. Accept only the same owner’s late ACK during that grace, bind once, and otherwise return a deterministic “worker slot failed; use recovery key” response. Add bridge/content integration coverage for late `/c/id` and stale-owner ACK.

## Paths verified as currently sound or materially fixed

- Prime spawn is atomic and refuses an unproven caller (`src/main/agents.ts:434-528`; `tools-core.ts:987-1008`). No workers are created when the prime request has no exact identity.
- Worker binding is app-owned and one-shot; arbitrary `agent` fields in `/events` are recovery-only and require a claimed command (`src/main/bridge.ts:620-648`).
- Redeem is command-id + per-document-owner gated; stale/second tabs cannot claim an active command (`bridge.ts:1032-1076`). ACK rejects owner changes (`bridge.ts:1088-1108`).
- `/c/id` is polled after send and ACK binds before retiring the worker command (`content.js:4717-4725`; `bridge.ts:1110-1140`).
- Restart wiring replays invited worker spawns after bridge registration (`agents.ts:1350-1366`; `bridge.ts:1296-1338`), and active worker origins are reconstructed before the first post-restart observation (`bridge.ts:630-665`).
- Correlation restore now reconciles durable history even with a nonempty but stale snapshot (`src/main/session/correlation.ts:143-193`), and late exact evidence can repair old Unattributed calls (`src/main/session/recorder.ts:648-763`).
- The old consolidated A2 startup/reload blind spot is addressed by explicit `fiber.js` reinjection even when `content.js` answers healthy (`extension/background.js:987-1000`).

## Overall conclusion

The broker/bridge spawn → redeem → ACK → bind path is substantially stronger in the current dirty tree, and the old stale-correlation/restart findings are no longer accurate as current findings. The remaining root is runtime page-evidence availability: binding a worker proves which conversation was opened, but exact MCP ownership still depends on Fiber exposing that request’s `metadata.request_id`. When Fiber disappears after startup, the extension neither repairs it nor downgrades its sticky health bit. That is sufficient to recreate the worker-5 failure mode: an active bound worker executes, while `agents`, inbox delivery, recorder placement, liveness and eventual finish become disconnected or Unattributed.

## Verification note

I attempted to run the retained Fiber/correlation probes with the repository's probe Vitest config. The probe launcher failed before test collection because esbuild could not resolve/read the config through the current sandbox (`Cannot read directory "..": Access is denied`); no production code was changed by that attempt. The conclusions above are source-traced against the current dirty tree and the retained durable incident evidence, not presented as a fresh green probe run.
