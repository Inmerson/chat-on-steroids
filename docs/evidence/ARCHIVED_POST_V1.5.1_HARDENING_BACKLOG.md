# Post-v1.5.1 hardening backlog

Do not let this file block shipping a working v1.5.1 unless one of these issues appears as an actual failing test/build/smoke regression. Immediate goal: stabilize current code, get tests/typecheck/build green, produce installer, install, smoke-test, record hashes/commit.

## Provenance / attribution

- Provider-specific connector evidence: current collapsed connector row identifies a generic ChatGPT connector, not necessarily ChatGPT Local Files. Live DevTools inspection showed exact provider/tool identity exists in React Fiber in MAIN world. Request message had recipient `api_tool.call_tool` and request path like `/TobisComputer/link_<id>/list_windows`; tool result metadata had `invoked_resource.app_name` and `resource_uri`. Isolated extension world cannot see React expandos, but a MAIN-world `data-*` annotation was empirically readable from the isolated content-script world. Later hardening can add a tiny MAIN-world helper that extracts only sanitized tool name + opaque provider/link fingerprint and annotates the actual row. Never expose args/results/tokens. Fail closed if Fiber shape changes.
- Avoid hardcoding connector display name. The request path already carries exact MCP tool name, and recorder knows `input.tool`. Match row tool name to MCP tool name; establish/cache opaque provider/link fingerprint from unambiguous rows.
- No-arg `join_agent` could use fresh page evidence as a one-time handshake instead of relying on “only one bootstrap candidate”. The calling chat renders the join_agent connector row before receiving the result. Later hardening can wait boundedly for a fresh Local-Files-specific row in the candidate conversation before issuing the key. Keep joinKey as explicit recovery fallback.
- Generic connector rows remain graded evidence only until provider-specific fingerprinting exists. Another connector in the same account is a residual collision source.
- App restart attribution: recorder `conversations` map is volatile. Browser companion can still be present and polling while recorder map is empty. “Could evidence still arrive?” should use injected browser-companion presence rather than only `conversations.size > 0`, so the first post-restart call can wait the short grace for the real page evidence instead of immediately becoming unattributed.
- Contested sighting matching must keep ambiguity persistent. Two overlapping calls + one row must not allow the last contender to steal the row merely because the first timed out. Conservative invalidation/batch matching is safer.
- Mutation observer should detect connector rows both when the direct added node is the row and when a wrapper subtree contains it. Historical/hydrated rows must remain seeded as already seen.

## Recorder / history

- Deferred attribution can append a tool call physically after the assistant/turn_end it logically preceded. Presentation/compaction should use chronological `(time, seq)` ordering while cursors remain monotonic by seq. `summary.updatedAt` must never decrease.
- Fire-and-forget attribution has a bounded crash window: a completed tool call can live only in RAM during the short attribution grace. Decide later whether this is acceptable or whether minimal pending-call journaling is worth it.
- `/closed` should clear bridge liveness immediately instead of leaving `conversationSeen` alive until TTL expiry.
- Recent/active session is not equivalent to a live ChatGPT chat. The unattributed stream should never be labeled as “one live now” solely because it was most recently written.

## Multi-agent lifecycle

- `createAgents` must be transactional: pre-normalize/prevalidate every worker task/label/length before prime creation, worker insertion, secret minting, binding, or spawn side effects. A blank later worker must leave no half-created run.
- `finish_agent` must actually be idempotent. Lost tool result + retry currently risks duplicate final reports and rewritten finishedAt. Keep enough terminal identity to recognize retry, but do not enqueue twice.
- Decide terminal sender semantics: finished/failed agents should probably be rejected from new outbound messages/work while an idempotent finish retry remains recognizable.
- Bridge queue overflow must use the same cleanup as `drop()` rather than raw shifting, so worker/resume state cannot be orphaned.
- `agent_message` events are intentionally recorded but must also survive compaction, count toward token estimate, and render meaningfully. Delivered worker reports in the prime session are especially important for Compact & Resume continuity.
- Agent filter must reset/normalize when changing sessions so a stale worker filter cannot make another session appear empty.
- Clear Swarm should remain usable whenever swarm state exists, even if no worker is currently running. Separate “run exists” from “active work”.
- Resume success semantics: “prompt typed into fresh chat” is weaker than “resume_session actually redeemed handoff”. Later UI/state can distinguish bootstrap sent/opened from continuation established.

## Extension / bridge

- Provisioning should be singleflight. Multiple open tabs can concurrently see no token and all call `/pair`, potentially rotating/invalidation-looping credentials. Use one service-worker provisioning promise; concurrent 401 recovery should share it too.
- Disconnect/unpair semantics: if UI says disconnect/revoke, auto-provision must not instantly reconnect on the next request. Either persist a user-disabled flag until explicit reconnect, or rename the action as a credential reset.
- Polling/rate-limit scalability: if cached-port calls still do `/hello` before every authenticated request, 2-second activity polling roughly doubles bridge request volume. With many tabs, the global 900/min budget can self-rate-limit the companion. Later optimize cached-port reuse, singleton `/commands` polling, cached status, and route-aware/authenticated rate limiting.

## Desktop UI / truthfulness

- Read-only visual state: group counts/is-on should reflect effective enabled capabilities, not merely configured checked capabilities that read-only suppresses. Mixed Desktop group is especially confusing.
- Problems badge can be cumulative while old feed rows are evicted, producing “4 problems” with an empty Problems filter. Count retained rows or label historical total clearly.
- Verify Chat header/action layout in the built release at default window size. Old installed build clipped Compact & Resume/actions; source has moved controls into separate rows and should be smoke-tested.

## Release discipline for v1.5.1

1. Freeze feature scope.
2. Typecheck + full tests green.
3. Build app + extension + installer.
4. Install over current version.
5. Smoke test: connect, file read, desktop/computer call, recorded tool/session labeling, Compact, Resume if safe, and one create/join/message/finish worker path if multi-agent is release scope.
6. Verify config/secrets survive reinstall.
7. Verify app and extension versions/protocol agree.
8. Record installer SHA-256 + git commit and leave tree clean except intentionally tracked backlog.

Only promote a backlog item into the current release if it becomes a concrete failing build/test/smoke blocker.
### Test harness cleanup: MutationObserver after JSDOM close
Independent `npm run verify` on the scope-frozen tree exited 0 with 459 passed / 1 skipped, but `test/content-script.test.ts` prints repeated asynchronous JSDOM stderr after some tests: `TypeError: Cannot read properties of null (reading '_location')` from the MutationObserver callback reading `location` after the harness/window has already been torn down. This is not currently a failing test or production blocker, but later clean up the harness/observer lifecycle (disconnect observers on teardown, guard closed document/window, or wait for queued mutation callbacks before closing) so a green suite is also stderr-clean and real async failures are not hidden in noise.

### Recorder grace can consume a block that belongs to the next call
Surfaced while writing the #30 join regression, not introduced by it. A tool call that
found no evidence is still inside its `SIGHTING_GRACE_MS` window when the *next* call's
conversation renders its connector row. The earlier call's `awaitSighting` is woken first
(it was queued first), `claiming.size` is 1 because the next call's recorder has not
started yet, so `claimConversation` awards and consumes that block — filing the earlier,
possibly foreign, call into the chat that rendered it and starving the call the block
actually belonged to. The test works around it with `flushRecorder()` between the two
phases. Fixes worth weighing later: require the sighting to postdate the claiming call's
`startedAt` rather than `startedAt - SIGHTING_LEAD_MS` for calls that have already
observed the conversation as quiet, or have `join_agent`'s non-consuming handshake
reserve its evidence in `CallContext` so a pending unrelated call cannot spend it.

### Live worker join attribution / bootstrap recovery

- Live 2026-08-16 smoke reproduced a worker whose bootstrap was sent and whose exact ChatGPT `conversationId` was stored, while every no-arg `join_agent` call still landed in **Unattributed activity** and left the worker `invited`. Root cause in the extension evidence path: connector evidence was counted through relabelling-oriented `toolBlocks()` heuristics, and the first `/` -> `/c/<id>` transition of a fresh chat was treated like navigation/history, banking the worker's first connector row instead of reporting it. The working-tree fix counts raw structurally verified connector controls per turn section and treats that first id assignment as the same chat. Keep a browser-level smoke/regression for this path because a ChatGPT DOM change can otherwise silently turn every browser call into unattributed activity.
- `join_agent` now has a bounded last-resort fallback: after fresh page evidence times out, a single extension-authenticated bootstrap that already has one exact conversation id may be joined, while fresh evidence naming a different chat still refuses. This prevents one correctly opened worker from being stranded forever by a renderer regression, but it is deliberately logged as **unproven**. Later hardening should replace this narrow fallback with provider-specific/fresh page identity so an unrelated chat or another device cannot theoretically claim the sole waiting slot during the timeout window.
- Live smoke also exposed a duplicate-tab failure mode: after the extension has already sent a worker bootstrap and acknowledged a concrete `conversationId`, keeping the worker command leased until `join_agent` succeeds can re-offer/open fresh worker tabs when join attribution fails. In the bad run this cascaded into many duplicate worker chats. Recovery should prefer the already acknowledged/bound conversation and must not open another tab merely because the join lease expired; only a proven dead/closed original tab should permit a replacement. Add a regression that a sent bootstrap with a known live conversation never spawns a second worker tab.

### Self-update / installer handoff from the running MCP host

- Live 2026-08-16 release smoke showed that invoking the NSIS installer synchronously through the running ChatGPT Local Files MCP process is not reliable: the installer closes/restarts the very process carrying the tool call, the call returns `UNKNOWN`, and in one attempt the installed `app.asar` remained the previous build even though the app came back. The built `release/win-unpacked/resources/app.asar` contained the new join fallback while the installed `%LOCALAPPDATA%/Programs/ChatGPT Local Files/resources/app.asar` did not. A normal interactive installer run subsequently replaced it correctly. Future self-update/reinstall flows should always detach the installer before terminating the app, persist a post-install verification marker/hash, and only report success after the restarted app verifies installed ASAR/extension hashes against the staged build.

### Live final smoke: worker can become active without receiving its agent key
After the final one-worker smoke, the prime-side broker reported `worker-1 active`, while the worker chat itself showed two `join_agent()` failures and explicitly said it never received an `agent_key`. This is an end-to-end correctness bug even if broker state says active: a join may mutate the slot to `active` while the tool result/key is lost, refused, or never reaches the worker model. Result: an "active zombie" worker that cannot make authenticated follow-up calls, cannot `send_agent_message`, cannot `finish_agent`, and can accumulate pending messages forever. Treat `active` as insufficient proof of a healthy worker until the worker makes at least one keyed follow-up call (or ACKs a prime ping). Fix should make join result delivery idempotently recoverable: retry from the same bound conversation must return a usable agent key again, or keep/recover a one-time terminal join credential long enough to resend the key after result loss without reopening the slot to another chat. Add a regression where state changes to active but the first tool result is dropped, then the same conversation retries and receives a valid key.
