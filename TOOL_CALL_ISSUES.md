# Tool Call / Harness Issues

Current unresolved issues only. Resolved/fixed findings are intentionally removed from this working file; git history keeps the forensic record.
Live findings from the v1.7.0 smoke on 2026-08-16. This file tracks tool-call reliability, ergonomics, attribution, and the local event stream. The hard release gate is: one ChatGPT conversation must reconstruct into one local session with every user message, every visible assistant/commentary update, and every tool call exactly once, in chronological order, with no false attribution and no `Unattributed activity` for calls that belong to that live conversation.

## P0 â€” Same live conversation splits into `Unattributed activity`

**Confirmed live.** The active ChatGPT conversation is stored as session `2026-08-16-f04ab0f6` with conversation id `6a8207f1-755c-83eb-9f42-3ae0d821fd71`, while `2026-08-16-2ce13b31` simultaneously receives calls as `Unattributed activity`.

This is not cosmetic. It destroys session reconstruction and makes the desktop log cease to be an authoritative transcript.

Observed pattern:
- Calls made while a stable current ChatGPT turn is known can land correctly in the real session.
- Calls made during browser/content-script startup gaps, focus/UI failures, or before the app has correlated the generation are persisted immediately as `attribution:"inferred"` with no `turnId` / `conversationId` into `Unattributed activity`.
- Those calls are not later reconciled/moved when the current browser conversation becomes known.

Required direction:
- Do not permanently commit an ambiguous call to a separate session immediately when there is a plausible live browser conversation that may become identifiable milliseconds/seconds later.
- Maintain a pending/unresolved attribution pool keyed by call id + timestamps + transport/browser/generation evidence.
- Reconcile pending calls once a stable conversation/generation binding appears.
- If exactly one connected live ChatGPT generation is eligible, that should be strong attribution evidence; per-call DOM/Fiber evidence should confirm/reconcile rather than being the only gate.
- Only preserve truly unattributed calls when multiple candidates remain genuinely ambiguous or there is no live ChatGPT source.

## P0 â€” Turn/generation identity leaks across turns

**Confirmed live.** `page_tool` and progress records from later user turns are repeatedly stamped with the old `request-...-0` identity. Progress ids such as `request-...-0#p0` are reused while the actual turn id is `request-...-3`, `-4`, etc.

This breaks chronology, attribution and any attempt to merge tool rows with assistant updates.

Required direction:
- Create a local generation identity at the generating falseâ†’true transition, before a reliable ChatGPT DOM turn id exists.
- Bind that local generation key to the real page/Fiber turn once it mounts.
- Never reuse the previous settled assistant turn merely because it is still the newest DOM section for a moment.
- All commentary, assistant updates, page-native tools, and connector tool evidence for one generation must share the same generation key before any renderer mapping happens.

## P0 â€” Visible assistant/commentary capture is corrupt before rendering

**Confirmed on disk, not only visually.** Progress events themselves already contain duplicated/concatenated text. The same `progressId` grows by re-reading a container whose `textContent` already contains prior copies / reparented content. Examples in the current session include repeated `Yep bro, that screenshot basically confirms...` prefixes and malformed encoding fragments.

Therefore the renderer cannot fix this downstream. The local source event is already wrong.

Required direction:
- Capture first-class visible assistant/commentary items by stable semantic message/update identity, preferably from the page/Fiber message model or a tightly scoped authored subtree â€” not aggregate container `textContent`.
- Treat updates as snapshots/upserts for one stable item identity rather than appending guessed diffs from mutable React containers.
- Never ingest CLF-owned synthetic rows back into the recorder.
- Preserve only user-visible assistant/commentary output; do not capture hidden reasoning.

## P0 â€” Tool calls are the critical product surface

The tool-call path must be treated as a first-class reliability target, not UI decoration. For every local call we need:
- stable call id,
- actual tool name,
- start/end timing,
- outcome (`ok`, `failed`, `rejected`, etc.),
- correct generation/conversation identity,
- exactly-once persistence,
- chronological placement relative to assistant/user updates,
- a renderer-independent authoritative local record.

The ChatGPT extension should render from this authoritative local stream after the local stream itself passes the gate.

## P1 — Multi-agent identity leaks into every tool call and survives past useful agent lifetime

**Confirmed in source and live in this resumed prime chat.** The current stateless-connector fallback makes the model repeat `agent_key` on ordinary `read`, `exec_command`, `session`, `observe`, `computer`, etc. calls whenever multi-agent has been exposed. This is noisy in every call, wastes model/output tokens, complicates recorder redaction, and makes ordinary non-agent tool use carry swarm state it should not need.

Concrete source behavior:
- `src/main/agents.ts::mintKey()` uses `randomBytes(24).toString('base64url')`, so the actual generated credential is 32 characters. The tool schema permits 8–200 characters.
- `src/main/mcp/kernel.ts::withAgentKey()` extends every object-shaped tool schema with `agent_key` whenever `agentToolsExposed && agentKeyNeeded`.
- `src/main/mcp/server.ts` makes `exposedAgentTools = exposedAgentTools || agentTools`, so after multi-agent is exposed once on an endpoint the `agent_key` field remains in every schema until a reconnect/restart even after the setting is turned OFF.
- A normally finished worker is **not** credential-retired in `finishAgent()`: unlike `failAgent()`, it leaves `secretHash` / `bySecret` intact. `agentForCaller()` also does not exclude terminal workers, so a finished worker key can still identify later ordinary tool calls.

**RESOLVED 2026-08-18 by removal, not by fixing (in source; not yet live-verified).** There is no per-call credential left to leak or to outlive anything. An agent is the ChatGPT conversation it runs in, so ordinary calls are attributed after the fact from page evidence and carry nothing. Deleted outright: `mintKey`, `Agent.secretHash`/`codeHash`, `bySecret`/`byCode`, `Caller.secret`, `CallCaller.secret`, `withAgentKey`/`agentKeyArg`/`agentKeyOf`/`agentKeyNeeded`, `AGENT_KEY_PREFIX`/`scrubAgentKeyLines`, and the `exposedAgentTools` stickiness that kept the field in the schema after the setting was turned off. The retirement half of the bug cannot recur: a finished worker has nothing to identify a later call *with*, and `bindConversation` refuses an agent that has ended. `test/mcp.test.ts` now asserts no key field on any tool on either surface while multi-agent is fully on, and none anywhere after it is switched off; `test/agents.test.ts` asserts the same over the wire. The one surviving key is `agents`' own `join_key`, which is recovery, minted for the user, and spent on use. See TODO.md → "P0 — agent identity and bootstrap rebuild".
- The prime also receives a secret and is instructed to repeat it on every tool call even though the prime is the one coordinator and the app/extension already tracks the prime conversation during spawn/resume.

Required redesign:
- **Prime is a logical role bound to the current main ChatGPT conversation, not a per-call secret.** Ordinary prime `read`, `exec_command`, `session`, `observe`, `computer`, etc. calls must never carry `agent_key`.
- **Compact / summarize / resume preserves the same logical prime and swarm.** The extension/bridge already knows that the fresh chat came from the resume command, so that expected handover should rebind `PRIME_ID` to the new conversation without exposing a reusable prime credential to the model. Worker chats and their live credentials survive this expected handover.
- **A genuinely new prime replaces the old run and kills the old swarm immediately.** Distinguish an expected resume handover from a new unrelated prime/takeover. On real replacement, invalidate every old worker credential, cancel queued worker bootstraps, stop/interrupt old worker tabs where the extension can, and end the old run before the new prime becomes authoritative. No old worker may keep sending after prime replacement.
- Only genuinely live workers need an explicit fallback credential while the MCP transport itself supplies no caller identity. `agent_key` may remain an **optional worker-only field in the static schema while Multi-Agent is enabled**, because ChatGPT caches the schema and cannot receive a different schema per role. Prime instructions must explicitly say to omit it.
- **If Multi-Agent is OFF at connector/tool-snapshot creation, expose neither `agents` nor `agent_key` anywhere.** The user accepts one connector/plugin reload after toggling the feature. Therefore do not fight ChatGPT's one-snapshot behavior with dynamic schema churn: show "reload connector to apply" in the app, and after that clean reload the MCP schemas must contain zero sub-agent fields/tools.
- Retire a worker's active credential immediately when it reaches `finished`/`failed`, but keep a **revivable tombstone for 1 hour**: same worker id/friendly name, task/result/history, conversation id, finished timestamp, and revive eligibility. The old credential is dead immediately.
- **Revive should target the same worker ChatGPT conversation first.** Within the 1-hour window, use the extension to open/focus that stored conversation and type a continuation message such as the new prime instruction/task. This is different from merely flipping broker state: the extension is what makes the finished chat generate again. If the original conversation truly cannot be reopened/sent to, only then fall back to a fresh worker chat carrying a compact continuation brief and the same logical worker identity.
- Every revival mints a fresh rotated live-worker credential. The previous credential never becomes valid again. After 1 hour, purge revive eligibility/name reservation from active swarm state while keeping normal historical session records.
- Keep finish-result retry separate from revival. A narrow terminal retry tombstone may answer an identical lost `finish` result, but a terminal worker credential must not authenticate ordinary tool calls.
- **Make the worker-facing key extremely short.** User preference is roughly 3 characters, rotated and reused only after retirement/expiry. Because 3 URL-safe characters are only about 262k combinations, treat this as a scoped local worker routing code rather than a general security bearer token: rate-limit invalid guesses, bind/validate it against the live worker slot/conversation evidence wherever possible, never let it authorize prime/takeover operations, and rotate on join/revive. If security review concludes 3 is indefensible, use the shortest defensible code and document why, but do not keep the current 32-character `randomBytes(24)` model-visible token.
- Add lifecycle tests: feature OFF + fresh connector => no `agents` tool and no `agent_key` in any Core/Desktop schema; enabled => key field optional; prime ordinary calls omit it; resume handover keeps same run/workers without prime key; unrelated new prime ends old run/workers; worker finish kills old credential but stays revivable for 1h; same-chat revive sends a new message and rotates key; >1h revive refused/purged; disabling mode invalidates all credentials and after one reload schemas are clean.

**RESOLVED 2026-08-17 (in source; not yet live-verified).** Implemented as follows:
- Prime is identified by the conversation it is in, proven *per call*. `resolve()` in `agents.ts` accepts three bindings — transport key, short worker code, proven conversation — requiring any two that are present to agree. A worker code can never resolve to the prime, so three characters can never reach `spawn`, takeover or `revive`. (Superseded in the second pass below: ordinary `dispatch()` no longer carries page evidence at all.)
- `createAgents` no longer mints a prime secret; `CreateAgentsResult.primeSecret` is replaced by `becamePrime`. The dead `mintPrimeHandover()` (no callers) is deleted, and `rebindPrime(conversationId)` replaces it. The bridge calls it on the `/commands/ack` for a resume, so a compaction keeps the same logical prime and every worker credential without any prime bearer key existing at any point.
- Worker codes are three characters from a 32-symbol ambiguity-free alphabet, minted at *join* (which makes rotation-on-join and rotation-on-revive fall out of the design), unique among live workers, resolvable only to live workers, and dead the instant the worker goes terminal. Justification is in the `agents.ts` docblock: whoever can reach the MCP endpoint already holds the per-surface path token and can call every tool with no code at all, so guessing a code buys nothing — it decides attribution and inbox routing, not access. That is also why misses are only logged and never throttled (second pass, item 3): a lockout would have cost availability and bought no secrecy. A 3-character value cannot be scrubbed from transcripts by substring search without corrupting them, so redaction is by location instead — `CREDENTIAL_FIELDS` for tool arguments plus `scrubAgentKeyLines()` for the one sentence that hands a live code out (second pass, item 4).
- `finishAgent` retires the credential via `retireCredential(agent, true)`, which moves the hash into a `terminalCodes` map that is dead for everything except recognising an identical repeated finish. `failAgent` retires it outright.
- Revive: `reviveAgent(caller, id, task)` is prime-only, valid for `REVIVE_WINDOW_MS` (1h), folds the previous result into the new task, resets state to `invited`, mints nothing (the new code comes at join), and sets `agent.reopen` to the worker's old conversation. `pruneExpiredTombstones()` deletes the agent entirely past the window, freeing id and name; an explicit revive after that is refused.
- Same-chat revive is real, not simulated: `WorkerSpawn.reopen` reaches the bridge, which queues a `continue` command carrying `conversationId`; `commandUrl` and the extension's `markerUrl` both build `https://chatgpt.com/c/<id>?clf=…`; `content.js` no longer refuses an existing conversation and instead requires `boot.conversationId === CLF_DOM.conversationId()` plus an empty composer before typing. (Extended in the second pass, item 9: the tab already showing that conversation is reused rather than a second one opened, and a busy composer in the right chat acks `working`.)
- Takeover: `endRun` collects live worker conversations into `RetiredChat[]` before clearing, and the bridge's `onSwarmEnd` listener cancels queued worker/continuation commands *and* queues a stop notice into each still-open worker chat.
- Feature OFF: the four exposure latches moved from `startMcpServer`'s closure to module scope, and `forgetExposedSurface()` resets them. `ipc.ts` calls it when `settings:save` turns multi-agent off, and `startMcpServer` calls it on every start, so the reconnect the user accepts produces schemas with no `agents` tool and no `agent_key` anywhere. The renderer says so explicitly on that save.

Acceptance coverage (all in the normal suite; 820 passing after the second pass below):
1. OFF + fresh endpoint => no `agents`, no `agent_key` anywhere — `mcp.test.ts` "removes the agents tool and every agent_key field once multi-agent is switched off" (also covers item 11).
2. ON => `agent_key` optional, prime call valid without it — `mcp.test.ts` "offers agent_key as an optional worker-only field while multi-agent is on".
3. Ordinary prime calls never require a key — every prime call in `agents.test.ts` now passes only `{ conversationId }`.
4. Compact/resume rebinds the same prime, workers survive, no prime key — `agents.test.ts` "rebinds prime after Compact & Resume while workers and their credentials survive".
5. New-prime takeover ends the old run and kills every worker code at once — `agents.test.ts` "ends a live old run the moment a different proven conversation spawns" (rewritten in the second pass, item 2: it no longer ages the clock past the staleness window, because a different proven conversation *is* a new prime).
6. Finish kills the code immediately — `agents.test.ts` "kills a finished worker code immediately rather than letting it keep talking"; the identical repeated finish is still answered.
7. Revive reuses the conversation, rotates the code, keeps identity and context — `agents.test.ts` "reopens the same conversation, rotates the code and keeps the logical identity", plus the worker-cannot-revive and still-live refusals.
8. Past 1h it is purged and refused — `agents.test.ts` "purges the slot after the revive window".
9. Resume in one call / deterministic paging — the two `mcp.test.ts` tests above.
10. Prime join text — `agents.test.ts` "answers a resumed prime with prime instructions, not worker ones".
11. See 1.
Extension side: `content-script.test.ts` "types nothing into an existing conversation the command did not name" and "continues a revived worker inside the conversation the command names".

### Second review pass, 2026-08-17 — 13 findings from co-reading the architecture

A passing suite was not acceptance: several invariants above still contradicted either the spec or this app's own recorder trust model. All 13 are addressed in source; none is live-verified yet.

1. **P0 prime auth (blocker).** `dispatch()` no longer reads page evidence at all. `provenConversation()` is a generic sighting — not scoped to this call's `startedAt`, not to a tool name, possibly minutes old — and the recorder's own rule is that such evidence narrows or refutes, never authorises. Ordinary read/exec/session/computer calls need no prime identity, so removing it costs nothing; a worker still identifies synchronously by its code. Prime control operations pay for identity themselves: `controlCaller(startedAt)` in `tools-core.ts` calls `awaitFreshSighting(startedAt, PRIME_EVIDENCE_MS)` for *that* call and compares with the bound prime conversation, and the prime's inbox is attached on that `agents` result. Regression: `agents.test.ts` › "never lets stale page evidence authorise a prime control call" plants exactly the sighting the old code would have used and shows the spawn refused, then proves a fresh in-call sighting authorises it.
2. **P0 new-prime semantics (blocker).** `createAgents()` no longer distinguishes takeover by staleness. A proven conversation that differs from the bound prime chat *is* a new prime: the old run ends immediately, every worker code dies, queued boots and continuations are cancelled and stop notices go out — with no 15-minute heuristic and no "clear the swarm first". `swarmOwnership()` survives only as the fallback for a caller with no evidence at all, which can still adopt a provably abandoned run but can never end a live one. Regressions: "ends a live old run the moment a different proven conversation spawns" (everything live, no clock movement), "treats the bound prime conversation as the same prime and keeps its workers", "refuses an unproven caller while the run is alive".
3. **Worker-code rate limit.** `workerForCode()` resolves a live code *first* and only counts misses afterwards; the global lockout is gone — it was a self-inflicted outage in which ten bad guesses disabled every stateless worker. Misses are logged, nothing else. Regression: "still identifies a live worker after ten bad codes in a row".
4. **3-character code recording.** No pretence that substring scrubbing covers it. Redaction is by location: `CREDENTIAL_FIELDS` for arguments, and `scrubAgentKeyLines()` for the one sentence this app writes a live code into, whose prefix (`AGENT_KEY_PREFIX`) is shared between `tools-core.ts` and the scrubber so wording and redaction cannot drift. Stale docs in `agent-secrets.ts` and `recorder.ts` — "every credential is registered and scrubbed everywhere", "a published worker key is how a worker becomes the prime" — are corrected: the prime has no credential to publish. Regression: `bridge.test.ts` › "redacts the worker code out of the recorded agents join reply and the activity feed".
5. **1-hour slot release.** `reserveWorkerIds()` prunes expired tombstones first, so a plain spawn frees an expired id and name with no `status` call in between. Regression: "frees an expired slot for a plain spawn, with no status call in between".
6. **Stale model-facing text.** Every "a finished worker cannot be reopened" is gone from `tools-core.ts` and `instructions.ts`, replaced by the actual rule: `action=revive` works for an hour, after which the slot is released.
7. **Feature-off ordering.** `settings:save` ends the run *before* stopping the bridge; stopping first dropped the bridge's swarm-end listener and the stop notices with it. Regression: `test/ipc.test.ts` › "tells a live worker chat to stop before the bridge goes away", driven through the real IPC channel.
8. **Bridge listener leak.** `startBridge()` keeps the `onSwarmEnd` disposer in a module-level `dropSwarmEndListener` and calls it on both start and stop. Regression: `bridge.test.ts` › "drops its swarm-end listener on stop, however often it has been restarted" — verified to fail when the disposer is removed.
9. **Same-chat revive UX.** The background worker now navigates the tab that already holds the conversation (`tabShowing()` / `openMarked()`, both reading the same `tabConversations` map `/closed` trusts) and only opens a tab when none is showing it; the app skips its own targeted open for a `continue` whose conversation is live, so the two paths cannot both produce a tab. A busy composer in the exact target chat acks `working` (and only `failed` on the last attempt) rather than returning silently. Regressions: `extension.test.ts` › "reuses the tab already showing a conversation instead of opening a second one" and its negative twin.
10. **Live old-worker stop.** A stop notice now carries `interrupt: true`, and the content script presses ChatGPT's Stop control before typing it — only for that command. The boundary is stated rather than papered over: work already in flight inside the app cannot be recalled from a tab, but the worker stops generating and its credential is already dead, so no later authenticated call from it succeeds. Regressions: "stops a generating chat before typing a notice that ends the run" and "never touches the Stop control for an ordinary continuation".
11. **Schema/migration.** `agentKeyArg` is `z.string().length(WORKER_CODE_CHARS)`, sourced from the minter so schema and mint cannot drift. Because only a hash of a credential is persisted, a pre-upgrade run's 32-character codes are unrecoverable, so `SwarmSnapshot.version` is bumped to 2 and a version 1 snapshot is discarded explicitly, with a log line saying why, instead of being restored into agents that would fail every call.
12. **Cost/simplification.** `history(call_id)` expansion has its own `MAX_HISTORY_CALL_CHARS` (24 KiB) rather than inheriting the enlarged 128 KiB resume envelope. The prime branch inside `joinAgent()` is deleted: `mintWorkerJoinKey()` refuses any non-worker role, so no prime handover key can exist; a prime chat that calls `join` anyway is still answered, through the bound-conversation path, which is why the prime-role join text stays.
13. **Minor real bug.** The unreachable block after `return releaseTab(...)` in `background.js` `HANDLERS.closed` is removed (`releaseTab` already drains and posts `/closed`, and only when the last tab on the conversation is gone).

## P1 — Prime `agents(join)` response gives worker-only instructions and causes a bogus self-message

**Observed live on 2026-08-17.** This resumed conversation joined as `prime`, but the `agents(action="join")` result then said: `You have 3 checkpoints with the prime agent: agents action=message to="prime"` and `You cannot message other workers.` Following that instruction produced the tool error `An agent cannot message itself`.

Required fix:
- Branch the join response by role. A prime must never receive worker checkpoint-budget instructions or the worker-only “cannot message other workers” rule.
- Prime instructions should instead say it may message workers freely, receives worker checkpoints/reports, and should not call `message` to itself.
- Add a regression for resumed-prime join text and make impossible instructions a test failure.

**Superseded 2026-08-18.** The whole shape of this bug is gone: `join` is recovery only and is never the way in, so no chat — prime or worker — reads join instructions on the normal path, and `join` from the prime's conversation is refused by name (`test/swarm.test.ts` › "refuses the prime"). A worker is bound by the extension before it reads anything, and its bootstrap is its task. The fix below is the previous surface, kept for the record.

**RESOLVED 2026-08-17 (in source; not yet live-verified).** `tools-core.ts` branches the join response on `info.role`. A prime is told the role is bound to this conversation, that it must never send `agent_key`, that its workers were not interrupted, and — the line that fixes the reported error — `Do not message "prime": that is you.` It sees no key, no checkpoint budget and no worker-only rules. Covered by `test/agents.test.ts` › "answers a resumed prime with prime instructions, not worker ones".

## P2 ? Invalid tool arguments dump the whole schema back to the model

**Observed live on 2026-08-17.** An `exec_command` call accidentally used `max_lines: 220` while the schema maximum is 200. ChatGPT correctly blocked the call before execution, but the rejection then echoed the entire JSON schema for `exec_command` into the result. The useful information was only: `220 is greater than the maximum of 200`.

Impact:
- A tiny argument mistake can inject hundreds/thousands of unnecessary schema tokens into the conversation.
- The schema is already known to the harness, so repeating it is pure context waste and makes recovery noisier.

Required fix / harness recommendation:
- Validation errors should return only field path, bad value, violated constraint and one corrected example. Never dump the full schema unless explicitly requested for debugging.
- Local Files cannot fully control a ChatGPT-side pre-execution validator, so keep this documented as a harness issue; where Local Files does its own validation, use the compact format consistently.

**STILL OPEN (harness-side), documented 2026-08-17.** The validator that produced this is ChatGPT's own pre-execution check and cannot be changed from here. Everything Local Files validates itself already returns the compact form — field, what was wrong, and what to pass instead, e.g. `agents action=revive requires agent and task.` — and no local refusal echoes a schema. Re-audited on 2026-08-17: no local validator emits schema text.

**Reproduced again during the 1.7.4 Overwrite continuation:** `exec_command` was accidentally
called with `max_lines: 300` against the published maximum 200. The useful correction was one
range error, but the pre-execution response again embedded the complete `exec_command` schema.
This confirms the harness-side behavior remains current; the connector itself was never called.

## P2 — `apply_patch` cannot mention one target file twice in a single atomic patch

**Live reproduced 2026-08-17.** An atomic multi-file patch contained two separate
`*** Update File: extension/content.js` blocks because two unrelated hunks for that file were
assembled in different parts of the patch. `apply_patch` refused the entire request before any
mutation. The exact validator error string was not preserved in the session record, so this
finding intentionally records behavior rather than inventing wording.

Impact:
- Logically independent hunks cannot be composed naively into one atomic patch if a path occurs twice.
- The model has to merge repeated-path blocks itself or spend another tool call splitting them.
- Generated/aggregated patches need a normalization pass that ordinary unified-diff tooling does not require.

**RESOLVED 2026-08-17.** Root cause was a flat `touched` Set in `applyResolvedPatch`
(`src/main/patch-files.ts`): it claimed a path on first mention and refused every later
mention of it, without ever asking what the two operations were. Repeated blocks are now
coalesced during preflight, which is the behaviour this finding asked for.

How it works: preflight builds a staged per-path view of the filesystem and resolves each
block against *that* rather than re-reading the disk, so a second `*** Update File:` block
for one path sees the first block's text — the same semantics two hunks inside one block
already had. The path is committed once, with aggregate `hunks` and `delta`, so the response
still carries one row per file and the existing shape is unchanged. `originalBytes` keeps the
real starting file, so the commit's optimistic conflict check and the rollback are untouched:
the repeated blocks land together or not at all.

The guard was made state-aware rather than removed. Still refused, each naming the conflict:
delete-then-update, update-then-delete, updating a path already moved away, two moves onto one
destination, adding onto a reserved move destination, adding a path twice, and updating a path
the same patch is creating.

Evidence: 13 regressions in `test/patch-files.test.ts`, including a second block that matches
text the first block wrote, a failure in the second block leaving the file untouched, and a
commit failure on a later file rolling the repeated file back whole. Negative check — forcing
the old blanket refusal back fails 6 of them.

## P1 — `session resume` artificially paginates ordinary handoffs at only 12,000 characters

**Confirmed in source.** `src/main/mcp/kernel.ts` defines `MAX_RESUME_CHARS = 12_000`, and `session(action="resume")` chunks every handoff against it. The current handoff therefore required five sequential tool calls even though the Core `read` surface already supports up to 512 KiB of output in one call.

Required fix:
- Return a normal-sized handoff in one `resume` call. Use a substantially larger single-call cap (for example 64–128 KiB, chosen against the real connector/tool-result envelope), and paginate only genuinely huge handoffs.
- Keep explicit part metadata only when pagination is actually necessary.
- Add tests proving a ~50–100k-character handoff resumes in one call and an oversized handoff pages deterministically.

**RESOLVED 2026-08-17 (in source; not yet live-verified).** `MAX_RESUME_CHARS` is now `128 * 1024`, chosen against `read`'s existing 512 KiB envelope. The header only says `part N of M` when there is genuinely more than one part, the continuation line only appears when the brief was actually split, and `noteDetail` is only set then. The tool description now tells the model resume "returns the whole brief in one call" and describes `part` as rarely needed. Covered by two tests in `test/mcp.test.ts` › surface boundaries: a 90,000-character handoff comes back in one call with no part markers, and a brief of `2×MAX_RESUME_CHARS + 500` pages into exactly three deterministic parts whose bodies reassemble to the original length.
## P1 â€” Computer-use focus policy is too brittle and produces avoidable refusals

**Rechecked against the authoritative recorded call in the 2026-08-17 compaction review.** `Desktop.observe(what:"window", window:329406)` returned the requested Terminal's UIA controls correctly. Its screenshot showed the foreground Chrome window covering the same rectangle, but the result explicitly warned: `this window did not come to the front, so the picture may show something covering it`. Therefore this is **not** a false-success/correctness bug in the current build. The remaining improvement is optional off-screen HWND capture (PrintWindow/DWM or equivalent) so a model can also see a covered background window without focusing it.
Repeated live failures:
- `get_window_state(window=...)` â†’ `FOCUS_FAILED` if another window is foreground.
- `screenshot(window=...)` â†’ `FOCUS_FAILED` for the same reason.
- `computer([{type:"focus",...}])` itself can return `FOCUS_FAILED`, so the obvious recovery action can fail under the same guard.
- `captureAfter` targeting a window can fail after otherwise valid actions if foreground changed.

Impact:
- A model trying to inspect two windows spends many extra calls bouncing through `list_windows` / focus / screenshot and still fails due to race conditions.
- This made bringing Claude Code to foreground much harder than necessary.

Suggested redesign:
- Separate **capture a window** from **steal user focus**. Window capture should use PrintWindow/DWM or equivalent when possible and should not require foreground focus.
- `get_window_state(window=...)` should query UIA for the specified HWND without demanding foreground unless an actual input action needs it.
- A `focus` action should report success/failure as its own action result and not make the entire multi-action batch unusable where safe.
- Add a single ergonomic primitive like `activate_window(window)` that reliably restores/foregrounds a normal window, with explicit reasons when Windows focus-stealing policy blocks it.
- For `captureAfter`, optionally capture the requested HWND without asserting it stayed foreground.

## P1 â€” Managed process/background CLI UX is confusing

Bringing Claude Code into/out of the background took far too much manual work. Problems observed across the workflow:
- Hidden ConPTY sessions are not naturally visible as a desktop terminal window.
- A hidden CLI and a visible resumed CLI can easily be confused as two workers unless session identity is tracked carefully.
- Launching a visible shell failed through one path because `powershell.exe` could not be resolved.
- Window-focus races then made inspecting/controlling the visible Claude terminal unreliable.

Desired architecture:
- One first-class process object with explicit `visibility: hidden|window`, `tty`, pid, session id, title and state.
- Ability to promote/attach a managed hidden TTY into a visible terminal window if supported, or an explicit `open_visible_terminal_for_process` workflow.
- Do not require the model to manually interrupt a hidden Claude session just to make it visible unless the process cannot technically be reattached.
- Expose whether a process is the same Claude session/resume id in status.

## P2 â€” Path UX is inconsistent

A live `run_command` call using `cwd:"C:\\Users\\totec\\chatgpt-local-files"` was refused with `Path contains ":", which is not allowed`, while other tool contexts and Claude naturally use Windows paths. The MCP virtual root uses `/totec/...`.

Suggested direction:
- Accept both approved Windows absolute paths and virtual `/totec/...` paths when they resolve inside an approved root, normalizing internally.
- If only virtual paths are allowed for a given parameter, error should say exactly: `Use /totec/chatgpt-local-files, not C:\\Users\\totec\\chatgpt-local-files`.

## P2 â€” Long waits inside `computer` are a bad fit

Observed:
- batches containing multiple 10s `wait` actions timed out the desktop helper around 30s;
- a wait followed by capture could then fail because the target lost foreground.

Suggested direction:
- Keep `computer.wait` for short UI settling only.
- Use `wait_for_window`/process status for longer waits.
- Reject or warn on batches whose total wait approaches helper timeout.

## P2 â€” Multi-agent refusal/recovery is technically safe but cumbersome

Observed refusals:
- `create_agents` rejected because an earlier swarm still looked alive and required manually clearing it.
- `join_agent` rejected because no agent chat was waiting.

Safety is correct, but recovery could be easier:
- Return the current swarm id/state and which agents are blocking the action.
- Offer a non-destructive `inspect_swarm`/status action and, when safe, an explicit stale-run cleanup path.
- Avoid making the model guess whether to retry after a browser-open race.

**Largely answered 2026-08-18, one part deliberately not.** There is no browser-open race left to guess about: the app opens the chat inside the same transaction that creates the command, one press gives one chat, and a worker never has to join. `status` is the non-destructive inspection this asked for, and the refusals now differ by cause — an identified stranger gets `AGENTS_BUSY` and learns nothing about the run, while a call that cannot be placed at all gets `WORKER_IDENTITY_LOST` plus the recovery route. What is deliberately *not* offered is telling the refused caller the swarm id and which agents are blocking it: a chat that is not part of the run learns nothing about the run, which is the point of `AGENTS_BUSY`. Stale-run cleanup stays a user action in the desktop window rather than a tool a stranger can call.

## Test/acceptance checklist for tool-call reliability

Before calling the tool layer solid:
1. Start one fresh ChatGPT chat and perform 30+ mixed calls (`read_file`, `read_files`, `search_files`, edits, process, computer, page-native tools).
2. Intentionally cause several failures/refusals.
3. Keep another ChatGPT tab open to test ambiguity.
4. Navigate/reload the main chat once during a turn boundary.
5. Verify one authoritative local session contains every call exactly once with correct outcome and chronology.
6. Verify no same-chat call appears in `Unattributed activity`.
7. Verify no call from the other chat is stolen into the main session.
8. Verify assistant/commentary updates around the calls are complete and not duplicated.
9. Only then render that authoritative stream back into ChatGPT.

## P2 â€” Cleanup/mutation API is incomplete for ordinary repo hygiene

The direct file surface has `delete_file` for exactly one file, but no `delete_path` for directories and no batch-delete operation. Cleaning generated temp/build folders or a stack of obsolete installers therefore pushes the model back to PowerShell even when the intent is simple file hygiene.

Suggested direction:
- Add `delete_path` with explicit `recursive` + approved-root safety.
- Add batch delete/move support with preflight + rollback where possible.
- Return a dry-run list/count/bytes so destructive cleanup is inspectable before commit.

## LIVE FORENSIC ADDENDUM â€” 21:11â€“21:13 on the active smoke chat

This is decisive disk evidence from the current live conversation (`2026-08-16-f04ab0f6`, conversation `6a8207f1-755c-83eb-9f42-3ae0d821fd71`) while the desktop simultaneously showed a live `Unattributed activity` session (`2026-08-16-2ce13b31`).

### A. Recorder knows the current turn, but connector calls still go Unattributed

Main session:
- seq 126: `turn_start` request `...-9`
- seq 127: current user message
- seq 135: one `list_windows` call correctly attributed to turn `...-9`
- seq 136: turn ends `unknown`
- seq 137: `turn_start` request `...-10`
- seq 138: current user interruption (`and also tell it recommendations...`)
- seq 139/140: progress is explicitly stored under turn `...-10`

At the same time, `Unattributed activity` lines 57â€“65 stores the actual same-chat PC inspection calls (`screenshot`, `computer` scroll/click, `list_windows`, `WIN+TAB`, `get_window_state`) as `attribution:"inferred"` with no turn id.

So the app **already has a live conversation and current generation identity** while `pickTarget()` still refuses to use that as fallback evidence and commits calls into a permanent unrelated session. This directly falsifies the assumption in `recorder.ts` comments that browser liveness/generation are never useful attribution evidence.

Recommendation: when exactly one live connected conversation is generating (or has a very recent open generation around `startedAt`) and no competing conversation is eligible, bind otherwise-unclaimed calls to that generation with a distinct attribution grade such as `live_generation`. Keep DOM/Fiber named evidence as higher-confidence confirmation, but do not throw same-chat calls into Unattributed just because page evidence raced or failed to render.

### B. Old turn `...-6` continues generating `page_tool` records during turns `...-9` and `...-10`

Main session lines 128, 130, 131, 133, 134, 141, 143â€“149 all carry `turnId=request-...-6` even though current turns are `...-9` / `...-10`.

Examples:
- seq 128: `Documented tool call and harness issues` â†’ old turn `...-6`
- seq 134: `Inspecting PC and Reporting Issues to Claude` â†’ old turn `...-6`
- seq 141: `Inspecting CLF Application Issues` â†’ old turn `...-6`
- seq 143â€“145: `Waiting/Waited for reliable evidence` â†’ old turn `...-6`
- seq 146â€“149: new labels + `Thinking` â†’ old turn `...-6`

This is not just display ordering. The stored event identity itself is wrong. Fix generation/turn binding before renderer work.

### C. Stable IDs are not actually stable: the same semantic page-tool label gets new IDs/indexes and is stored repeatedly

Examples:
- `Documented tool call and harness issues` appears as seq 128, 131, 133 with different synthetic `page-tool:<turn>:<index>:<hash>` ids.
- `Waited for reliable evidence` appears twice (seq 144/145) with the same label hash but different indexes.
- `Inspected CLF application, windows, preview, and selected session state` appears three times (seq 146/147/148) with different indexes.

The current identity formula includes the block index, but React reorder/reparenting changes indexes. Therefore dedupe by `messageId` cannot work.

Recommendation: derive page-native tool identity from a true message/request/result id in Fiber where available. If no semantic id exists, use a generation-local occurrence identity created once when first observed and track the actual DOM/Fiber node across reorders; do not rebuild identity from array index every scan.

### D. Progress identity is also leaking from old turn `...-6`

Current turn progress seq 129/132 (`turnId ...-9`) and seq 139/140 (`turnId ...-10`) reuse `progressId=request-...-6#p0`. The text snapshots already contain duplicated concatenation (`...smallYep bro...`, repeated full sentence).

Recommendation: progress/commentary identity must be scoped to the local generation key, not a DOM item id inherited from an earlier settled turn. A new generation must never reuse another generation's progress ids.

### E. Desktop timeline exposes synthetic/page-tool captions as `ChatGPT:` commentary and makes the transcript look fabricated

The CLF desktop showed rows such as:
- `ChatGPT: Documented tool call and harness issues` (twice)
- `ChatGPT: Inspecting PC and Reporting Issues to Claude`
- `ChatGPT: Waiting for reliable evidence` (multiple times)

These are page-tool labels / derived UI captions, not necessarily authored assistant prose. Rendering them with a `ChatGPT:` speaker prefix conflates tool activity with assistant speech.

Recommendation: keep event classes visually and semantically distinct in the authoritative log: `assistant/commentary`, `connector tool call`, `page-native tool`, `system/error`. Never label a page-tool caption as if ChatGPT authored that sentence.

### F. Local connector calls are being misclassified as `page_tool`

`extension/content.js::reportPageTools()` currently does:
`CLF_DOM.toolBlocks(turn).filter((block) => !CLF_DOM.isConnectorBlock(block))`.
But `CLF_DOM.isConnectorBlock()` only recognizes a connector row if the block currently contains/is inside `[aria-label="Open tool call list" i]`.

The live session proves this classification is unstable: local actions such as `Documented tool call and harness issues`, `Inspecting PC and Reporting Issues to Claude`, etc. are emitted as `page_tool` while the same connector activity also exists as MCP `tool_call` records elsewhere. After React replacement / CLF relabeling / collapsed-row state, the connector control can disappear from the visible block, causing a TobisComputer row to be treated as a ChatGPT-native tool.

Recommendation:
- Never decide local-vs-page-native tool identity from the current DOM shape after relabeling.
- Use Fiber request/result metadata (`/TobisComputer/...`, `invoked_resource.app_name === TobisComputer`) as the authoritative classification where available.
- Once a block/message is identified as local, persist that identity for its lifetime even if React changes the DOM/control.
- `page_tool` should mean *provably non-TobisComputer*, not merely â€œconnector marker not visible right now.â€

### G. `foldProgress()` can collapse commentary across different turns

`src/shared/session.ts::foldProgress()` keys the anchor only by `progressId`. The live page is currently reusing `request-...-6#p0` during turns `...-9` and `...-10`. Therefore the fold can replace an old turn's earliest commentary with text from a later turn and delete the later event entirely.

Recommendation: progress identity must be scoped by a local generation identity. At minimum the fold key must include turn/generation (`generationKey + progressId`), but the real fix is making `progressId` generation-local so cross-turn reuse is impossible.

### H. Tool chronology cannot be perfect while a completed tool call is appended only after it returns

`ToolCallRecord` is appended when the tool result is available, but its `time` is backdated to `startedAt`. `BaseEvent.seq` is documented as the sole ordering authority (`Ordering never relies on time`). A slow tool can therefore be sequenced *after* commentary/page events that visibly happened after invocation, even though its timestamp is earlier.

For a faithful ChatGPT stream the tool row belongs at invocation time and later gains its result/status.

Recommendation:
- Create a `tool_call_start` / pending tool event at invocation with stable `callId` and anchor seq.
- On completion append a result/update referencing that anchor, or support a superseding snapshot model like progress.
- Readers render one tool row at the start anchor with latest outcome/result.
- Do not rely on sorting completed events by timestamp to reconstruct invocation chronology; that creates other clock/reload problems.

### I. 2026-08-17 current-chat reproducer separates "missing from plugin" from truly Unattributed

Session `2026-08-17-7463fb07` shows both failure classes in one ordinary chat, which is useful
because the screenshots make them look like one problem.

**Class 1: correct conversation session, missing turn id.** The extension records
`turn_start` seq 3 for `g-1q3xmfmf85xkw-1-1`, then `turn_end: unknown` seq 6 at 19:00:37.
The first Core call starts later at 19:00:40. Calls seq 7-11 are successfully recorded in the
conversation's own session with `attribution:"turn"`, but no `turnId`. They therefore vanish
from the synthetic page stream because `streamTurnGroups()` only joins events that name a
known durable turn. The tool did not fail and the app did not lose it; **the plugin hid a
record it already had**.

**Class 2: separate Unattributed session.** Once the page has closed the generation entirely,
later calls from this continuing chat appear in `2026-08-17-eceb1519` as
`attribution:"inferred"`, no turn id. Those calls also completed successfully. The failure is
caller attribution, not Core execution.

The timing strongly points to the page lifecycle as the trigger: ChatGPT appears to remove or
replace the stop/generation control around connector-tool phases, and the extension interprets
that as a real end. After the premature `turn_end`, the recorder has lost its strongest live
generation evidence. MCP connector calls do not carry a ChatGPT conversation id, so the
recorder then has to choose between guessing and Unattributed; it correctly refuses to guess.

**Current release decision:** do not change recorder semantics in the extension UI pass. Make
the page renderer tolerant of same-conversation `tool_call` events whose `turnId` is null, keep
the raw recording untouched, and leave the lifecycle/attribution repair for the Opus pass in
TODO T-127. Any later recorder change must preserve cross-device ambiguity refusal.

### J. Tool invocation failures from this pass, classified by layer

These are worth keeping because "a tool call failed" is otherwise too broad to debug:

- `apply_patch`: `PATCH_INVALID: Update File TODO.md: empty hunk` — caller supplied an invalid
  patch. Validation worked and no partial edit landed. **Not MCP fault.**
- `apply_patch`: expected context in `test/extension.test.ts` not found — stale/wrong patch
  context. Atomic validation worked and no partial edit landed. **Not MCP fault.**
- `apply_patch`: a later two-file edit omitted the second `*** Update File:` header, so a
  `test/content-script.test.ts` assertion was searched for in `extension/content.js` and the
  entire patch was rejected. Atomic validation again worked. **Not MCP fault.**
- `read`: line range supplied with two paths — schema violation, rejected before file access.
  **Not MCP fault.**
- `exec_command`: one `rg` search process produced no output and remained live until killed
  after ~22.5 s. Process continuation and force-kill both worked. **Unclear**, but nothing yet
  implicates MCP transport; reproduce the shell command itself first.
- `exec_command`: the first targeted `vitest` run exited 1 with 11 real test failures caused by
  the in-progress extension redesign (old glyph expectations, timestamp signature invalidation,
  and the new null-turn rendering rule). The command surface reported them correctly; after
  code/test fixes the same run passed 192/192. **Not MCP fault.**
- `exec_command`: a PowerShell `rg` command had mismatched quotes and failed with
  `The string is missing the terminator: ".` **Caller shell error, not MCP fault.**
- `apply_patch`: one combined update contained an empty `extension/content.js` hunk and was
  rejected with `PATCH_INVALID`. Atomicity again prevented partial changes. **Not MCP fault.**
- `exec_command`: a test retry used `max_lines: 220` although the schema maximum is 200. It was
  correctly rejected before execution. **Caller argument error.** The oversized full-schema
  validation dump is still a harness ergonomics problem, but not a Core execution failure.
- `exec_command`: a compound `git diff ... | Select-Object -First 260` inspection returned exit
  1 after already producing the requested diff text; a plain `git status --short` immediately
  succeeded. Likely broken-pipe/truncation behavior in the shell pipeline, not an MCP or Git
  repository failure. Reproduce without the downstream truncation before escalating Core.

Reliability reports should therefore use separate buckets for tool execution errors, client
schema/argument errors, managed-process hangs, attribution failures, and extension rendering
omissions. Collapsing those into one "tool failed" count hides where the fix belongs.

### K. Green duration metrics can be false as completion claims for live `exec_command`

The extension sometimes shows numbers like `✓ 655ms` or `✓ 10.0s`. The raw number can be
correct while the *meaning users infer from it is wrong*. `exec_command` waits only until its
configured yield deadline. If the child is still running it returns a `session_id` and says
`Still running`, but `tools-core.ts` still passes that partial `result.durationMs` into
`noteExec()`. `summarize.ts` formats any successful exec evidence as `✓ <duration>`.

Therefore `✓ 10.0s` may mean "the initial MCP call waited 10 seconds before handing back a live
process", not "npm run verify finished in 10 seconds". This is **not an MCP transport failure**;
it is an activity-summary semantics bug spanning managed-process state and the human-readable
metric. The raw event should retain its evidence for debugging.

For the current extension pass, only presentation changes: success-duration metrics for
`kind:"run"` are suppressed in the ChatGPT page, while concrete failure metrics, file deltas
and counts remain. The deeper fix is TODO T-129 for Opus: model pending/running explicitly and
decide whether a final `write_stdin` completion updates the original command's duration/status.

### Fresh refusal: benign Markdown patch blocked by safety layer

While appending a recorder-dedupe finding to `CLAUDE_LIVE_FINDINGS.md`, `apply_patch` was refused with: `blocked by OpenAI because we couldn't determine the safety status of the request`. The requested mutation was only a Markdown documentation append inside the already-approved project; a shorter rephrasing of the same finding succeeded immediately afterward.

Recommendation: refusals should expose a stable machine-readable reason category and, when the target is a plain documentation file under an approved root, avoid ambiguous safety failures on ordinary engineering prose. At minimum the tool result should distinguish policy refusal from path/sandbox validation so the model knows whether retrying a smaller patch is appropriate.

### Fresh edit hazard: escape sequence became a literal NUL byte in TypeScript source

The new recorder occurrence helper was intended to separate message id and fingerprint with a NUL-style escape. After the structured Claude Edit, byte inspection found a **literal `0x00` byte** inside `src/main/session/recorder.ts` at the template string. Grep then classified the TypeScript file as binary (`binary file matches (found "\\0" byte...)`), hiding ordinary symbol search results and potentially breaking parsers/tooling.

This is an API ergonomics trap: source-edit payload strings are decoded before being written, so a model spelling an escape sequence in the tool argument can accidentally materialize a control character instead of the textual JavaScript escape it intended. Recommendation: structured source-edit tools should reject embedded NUL/control bytes for normal text files (as command tools already reject hidden control characters), or clearly distinguish raw bytes from source text. Tool results should warn when an edit makes a previously-text file contain NUL bytes. Models should use a printable separator or explicitly double-escape source-level escapes and verify the resulting bytes.

The failure reproduced during the attempted repair itself. Claude first removed all raw NULs from three files, then used structured `Edit` calls whose visible diffs showed source-level `\u0000`. Immediate byte inspection after those edits found raw NULs again: `compact.ts=2`, `src/shared/session.ts=2`, `extension/content.js=1`. The rendered structured patch therefore does not tell the model whether the resulting file contains six printable characters (`\\u0000`) or byte `0x00`. A text-source edit API should make that distinction impossible to confuse.

### Fresh search inconsistency: Claude Grep returned false negatives on a normal text file

During the post-compact recorder review, Claude's built-in `Grep` twice searched the absolute path `C:\\Users\\totec\\chatgpt-local-files\\src\\shared\\session.ts` for `StoredText` and then for `chars|truncated|assetId`, returning **`No matches found`**. The file is normal UTF-8 text (`binary: false`, 638 lines). CLF `search_files` against that exact file immediately found **9 `StoredText` matches**, including `export interface StoredText` at line 45.

This is a dangerous failure mode because it looks like authoritative absence rather than a tool error and can make the model redesign code around a symbol that actually exists. Recommendation: search tools should report the resolved file count/path and distinguish `0 matches in 1 scanned file` from `target was not scanned/resolved`. For exact-file searches, verify the target was opened/scanned and surface an explicit resolution/encoding error instead of returning an unqualified empty result. Models should fall back to direct `Read`/CLF `search_files` when an exact known symbol unexpectedly returns zero.

### Fresh harness issue: trivial schema mistakes dump the entire tool schema into the conversation

During this resumed smoke, `computer` was called with a single `wait` action using `ms: 12000`. In the 2026-08-17 compaction-monitor run, `exec_command` reproduced the same client-side failure with only `max_lines: 240` instead of the published maximum 200; the response again expanded into the full schema before the MCP server was invoked. The only real problem was that the documented maximum is 10000 ms, but the refusal returned a very large JSON-schema validation dump containing every `computer` action variant and most of the complete tool schema.

The Minecraft worker independently reproduced the same class of problem with `observe(max_elements=120)`. The only useful correction was `max_elements <= 100`, but the tool response again dumped the complete `observe` schema. This confirms the problem is in generic argument-validation/error rendering, not one specific action schema.

That is disproportionate for a one-field range error and is actively harmful in an agent harness: it burns context, floods the visible activity log, obscures the useful correction, and makes repeated validation mistakes much more expensive than they need to be.

Recommendation: validation failures should return a compact structured error such as `INVALID_ARGUMENT`, the exact field path (`actions[0].ms`), received value, allowed range, and one corrected example. Keep the full schema available only through explicit tool discovery/debug mode rather than embedding it into ordinary runtime refusals.

### Fresh focus race: foreground validation can disagree with `list_windows` immediately afterward

While monitoring the same Claude terminal, `computer(... captureWindow=657010)` refused with `FOCUS_FAILED`, claiming foreground window `67232`. An immediate `list_windows` call then reported **657010 itself as foreground**. The same class of mismatch occurred around earlier focus/capture attempts in this run.

Some foreground races are unavoidable on Windows, but the current contract turns a transient or stale foreground sample into a hard failure for otherwise read-only capture/wait workflows. It also gives the model two contradictory authoritative-looking answers from the same harness.

Recommendation: use one shared foreground/window-state source for focus validation and window listing, include the sampled timestamp/generation in failures, and retry/revalidate once before refusing a read-only capture. More importantly, keep read-only HWND capture/UIA inspection independent of foreground state wherever Windows permits it; reserve strict focus ownership for actual input actions.

## 2026-08-17 Minecraft stress test â€” connector/tool issues to fix next

This section comes from a deliberate browser-game stress test using one spawned worker plus the prime agent. The temporary app itself was only a harness target. These are the reusable MCP/connector findings that matter for the next ChatGPT Local Files build.

### P1 â€” Animated pages make `frameId` coordinate actions unusably brittle

On the continuously-rendering WebGL page, prime used coordinates from a freshly observed frame 23. The next action immediately failed with:

`STALE_FRAME: these coordinates are for frame 23, but the current screen frame is 24.`

Worker independently hit the same behavior. The page itself advancing/capturing can invalidate coordinates before the model can act.

Fix:
- Keep strict frame anchoring available for static screenshots.
- Add window-client coordinate mode anchored to an HWND/client rectangle rather than a globally frozen frame.
- For continuously animated surfaces, allow a bounded tolerance or a relative-to-window coordinate primitive that is not invalidated by unrelated repaint/frame advancement.

### P1 â€” Pointer-lock needs relative mouse input, not absolute desktop coordinates

Absolute `move` / click semantics are a bad fit for FPS/WebGL pointer lock. Prime observed camera rotation from ordinary mouse moves, but behavior was not deterministic. After one scroll action the tool even reported pointer image coordinates outside the captured window (`-678,695`).

Fix:
- Add `mouse_delta(dx, dy)` / relative pointer movement for pointer-lock apps.
- Expose pointer-lock state in window/page metadata when detectable.
- Do not pretend absolute desktop coordinates are equivalent to raw mouse deltas.

### P1 â€” `computer` synthetic pointer-lock click can duplicate/continue input

Prime aimed straight down at spawn and issued one Desktop `computer` LMB click. The player eventually fell from `y=2.5` to `y=0.5`, implying two vertical blocks were removed.

Worker then instrumented the page and replayed one exact Chrome DevTools Protocol press+release. Exact result:
- world size `8014 -> 8013`
- break counter `0 -> 1`
- exact sole edit `{ action: "break", x: 0, y: 2, z: 7, type: "grass" }`
- player settled at `y=1.5`

So the game logic removed one block correctly; the extra removal was specific to the Desktop synthetic-input path.

Fix:
- Audit `computer` mouse down/up emission under pointer lock.
- Ensure every `click` is exactly one down/up pair, with no lingering pressed state and no duplicated Win32 injection.
- Add an integration test against a page that counts `mousedown`, `mouseup`, `click`, and Pointer Lock events.

### P1 â€” `click_ref` can return failure after the click actually succeeded

A batched `click_ref` on the `PLAY WORLD` button returned:

`UI_ELEMENT_GONE: the referenced UI element is no longer present`

But the click had already succeeded, pointer lock was entered, and the button disappeared because the successful action itself hid the menu.

This is a dangerous partial-success shape because an agent may retry a destructive action after seeing an error.

Fix:
- Track per-action success before post-action re-resolution/capture.
- Distinguish `ACTION_SUCCEEDED_TARGET_DISAPPEARED` from pre-action `UI_ELEMENT_GONE`.
- Never collapse a successful input followed by an expected DOM disappearance into a generic failed call.

### P1 â€” Desktop lacks `key_down` / `key_up` / hold primitives

`computer` exposes instantaneous `keypress` only. Continuous-input apps need actual held state across animation frames for WASD, sprint, charging, drag modifiers, gaming controls, etc.

Prime had to experiment with PowerShell/Win32 as a workaround. That workaround is unreliable because invoking shell tooling can steal/alter focus and pointer lock.

Worker used CDP to prove the app worked: a deterministic 900 ms `KeyW` hold moved the player, and Space produced a normal jump arc.

Fix:
- Add explicit `key_down`, `key_up`, and optionally `hold_key(key, ms)` actions.
- Guarantee cleanup of any held key if a batch fails/cancels.
- Return currently-held synthetic keys in debug state to avoid stuck modifiers.

### P1 â€” Browser/WebGL testing needs a DOM/CDP/page-console primitive

UIA can see buttons/text, but it cannot inspect WebGL canvas state, JavaScript variables, console exceptions, or deterministic game state. For this run the worker had to create custom CDP smoke scripts and expose `window.__voxelcraft` diagnostics to prove one-break/one-place behavior.

Fix:
- Add an optional browser/page tool for connected Chrome: evaluate JS, read console errors, inspect DOM, dispatch exact keyboard/mouse events, and query page URL/title.
- Keep it clearly separate from generic desktop control so security boundaries remain explicit.
- This would massively improve testing of local web apps without forcing each target app to add ad hoc hooks.

### P1 â€” Webpage UIA refs depend on Chrome renderer accessibility state

Worker found that a fresh Chrome profile exposed no useful webpage UIA refs until launched with `--force-renderer-accessibility`.

Fix:
- Detect when Chrome renderer accessibility is unavailable and say so explicitly.
- If safe/appropriate, support launching a test Chrome instance with renderer accessibility enabled.
- Do not silently present `click_ref` as generally available when browser content is not exposing accessible nodes.

### P1 â€” High-DPI image/desktop coordinate semantics are still confusing

On this 2x-DPI desktop, one unframed worker coordinate click intended for image `(600,674)` was reported/resolved around desktop `(1200,1348)` and missed the intended control.

Fix:
- Every coordinate-bearing response/action should explicitly label coordinate space: `frame_px`, `window_client_px`, `logical_desktop_px`, or `physical_desktop_px`.
- Prefer client-area coordinates or refs over implicit scaling.
- Include scale factor/DPI and window-client origin in screenshot metadata.

### P2 â€” Virtual MCP paths vs native Windows paths are not self-explanatory

The MCP virtual cwd `/totec` resolves natively to `C:\Users\totec`, not `C:\totec`. `read` correctly used `/totec/...`; PowerShell naturally showed `C:\Users\totec\...`. This led to an initially wrong README launch path during the test.

Fix:
- When a command starts, return both virtual cwd and resolved native cwd in metadata.
- Document the mapping once in tool discovery and keep it visible enough that agents do not invent `C:\totec`.

### P2 â€” Cross-tool focus side effects make shell input injection a poor fallback

Prime tried a PowerShell Win32 key-hold workaround while Chrome was pointer-locked. After switching through tool calls, the browser ended back at the pause menu. Even when the key injection itself succeeds, cross-tool focus/pointer-lock side effects make this unsuitable as a replacement for first-class Desktop hold actions.

Fix:
- Implement the missing hold primitives in Desktop instead of relying on shell injection.
- Avoid focus changes for unrelated `exec_command` calls where possible.

### Acceptance test to add

Create one automated local browser stress page that:
1. renders continuously at 60+ FPS;
2. offers normal DOM controls plus a WebGL/canvas region;
3. enters Pointer Lock;
4. counts exact keyboard down/up and mouse down/up/click events;
5. exposes a tiny deterministic JS state object;
6. runs at Windows scaling 200%.

The connector must prove:
- refs remain useful or fail explicitly;
- coordinate actions do not become immediately unusable because of animation;
- one click always produces exactly one down/up sequence;
- relative mouse movement works under pointer lock;
- held keys remain down for the requested duration and always release;
- action success is not mislabeled as failure when the target disappears because the action succeeded;
- screenshot/action coordinates are unambiguous at high DPI;
- a page/DOM/CDP path can inspect deterministic browser state without target-specific hacks.

## 2026-08-17 full tool stress pass â€” new live failures

### P0 â€” `exec_command` PowerShell stdout corrupts Unicode even though file/env data is intact

**Live reproduced.** `exec_command(shell:"powershell")` with `Write-Output 'Ã¤â†’â€”â€¦'` returned control/mangled text (`\u001a-.`) instead of the Unicode characters. A second probe passed `TOOL_AUDIT=hello-Ã¤â†’` via the tool's `env` object; `Write-Output $env:TOOL_AUDIT` rendered as `hello-ï¿½\u001a`. This is not environment corruption: a Node child wrote the same env value to UTF-8 on disk and `read` returned exactly `hello-Ã¤â†’`. It is the PowerShell stdout decoding/encoding boundary.

Impact: diagnostics, filenames, German text, arrows, smart punctuation and test output can be silently altered in ordinary `exec_command` results. The TTY path did **not** reproduce it: a Node REPL round-tripped `'Ã¤â†’'` correctly through `write_stdin`, narrowing the bug to the non-TTY PowerShell capture path.

Fix direction: make the PowerShell child stdout/stderr encoding explicit end-to-end and test the actual managed `exec_command` surface with `Ã¤Ã¶Ã¼ÃŸ`, `â†’`, `â€”`, `â€¦`, curly quotes and emoji. Do not only test helper stdin or file decoding.

**Root cause isolated live:** inside the managed non-TTY PowerShell process, `[Console]::OutputEncoding.WebName` is `IBM437` and `$OutputEncoding.WebName` is `us-ascii`. Prepending
`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false);`
makes the exact `Write-Output 'Ã¤â†’â€”â€¦'` probe round-trip correctly. This is therefore a concrete bootstrap fix, not a guessed decoder heuristic.

**RESOLVED, VERIFIED 2026-08-17.** Shipped as `CONSOLE_UTF8` in `src/main/exec.ts`, prepended
to the script on both the `runPowerShell` and `prepareShellCommand` paths, BOM-less on both
variables (a byte-order mark at the head of every captured stdout is its own small
corruption). Verified at the real managed surface by round-tripping the full repertoire this
finding asked for — `äöüß → — … “quotes” 😀` — through stdout and, separately, stderr, which
is decoded on its own path and cleaned of CLIXML error records. Negative check: blanking
`CONSOLE_UTF8` fails both tests and reproduces the reported corruption exactly —
`����  - . "quotes" ??`. Worth recording that the curly quotes came back as straight ASCII
quotes and the emoji as `??`: not every symptom looks like mojibake, so some of this was
silently *plausible* wrong output, which is why the assertion compares the whole string
rather than only looking for a replacement character.

### P0 â€” `exec_command(shell:"cmd")` can silently skip quoted child commands and still report exit 0

**Live reproduced.** `shell:"cmd", cmd:"node -e \"console.log(123)\""` returned `exited 0` with no output. More decisively, `node -e "require('fs').writeFileSync('cmd-node-e.txt','ran')"` also returned `exited 0`, but the file did not exist afterward. `echo world` and `node -p 123` work, so the failure is specifically around command strings containing quotes. Running the equivalent `cmd.exe /d /s /c 'node -e "console.log(123)"'` through PowerShell printed `123`, so the child command itself is valid.

This is dangerous because the result is a false success, not a parse error. A model can believe a test/build/script ran when the quoted payload never executed.

Likely direction: audit Windows argument quoting for the `cmd.exe /d /s /c <script>` spawn path. Add integration cases with quoted `node -e`, paths containing spaces, nested quotes, `&`, redirection and `%VAR%`, and require both side effects and output, not exit code alone.

**Root cause isolated live:** a standalone Node probe reproduced the exact `spawn(cmd.exe, ['/d','/s','/c', script])` path. With normal Node Windows argument quoting, `node -e "console.log(123)"` returns status 0 and empty stdout. Adding `{ windowsVerbatimArguments: true }` to that spawn returns status 0 and `123\n`. The failure is therefore the Node/libuv quoting layer around the command string consumed by `cmd.exe /c`; the verbatim spawn mode fixes the exact live case and should be regression-tested before shipping.

The TTY branch is independently affected because it uses `node-pty`, where `windowsVerbatimArguments` is not a spawn option. A live `exec_command(shell:"cmd", tty:true, cmd:'node -e "console.log(123)"')` also exited 0 with no output. Direct `node-pty` probing showed its documented Windows *string* argument form is the working equivalent: array args reproduced the failure, while `pty.spawn(cmd, '/d /s /c node -e "console.log(123)"', options)` returned `123`. Fix/test both pipe and PTY paths; otherwise `tty:true` remains a false-success hole after the normal spawn is repaired.

**RESOLVED, VERIFIED 2026-08-17.** Both paths are fixed. Pipe: `prepareShellCommand`
(`src/main/exec.ts`) emits `['/d','/s','/c', '"<script>"']` with
`windowsVerbatimArguments: true` — verbatim and the wrapping quote pair are one decision,
since without the outer pair there is nothing for `/s` to strip and a script containing `&`
would be split by cmd's own parser. PTY: `src/main/process-manager.ts:490` passes the joined
command line as node-pty's single-string argument form when that flag is set, and the argument
list otherwise.

Regressions in `test/process-manager.test.ts` are side-effect based on **both** paths — write
a file through `node -e`, then read it back — because the failure mode is empty output behind
a clean exit, which an output-only assertion can miss. Metacharacter cases (`echo one| findstr
one`, `echo %OS%`) confirm the wrapping did not quietly demote cmd to a program launcher.
Negative check: reverting the PTY path to the argument list fails all three console tests with
`The system cannot find the path specified.`

### P1 â€” native Windows paths are still a poor model-facing error

**Live reproduced.** `read({paths:["C:\\Users\\totec\\chatgpt-local-files\\package.json"]})` returns only `Path contains ":", which is not allowed`. The model-facing tool uses virtual `/totec/...` paths, but the error does not say that or show the corrected spelling. This is especially easy to hit because `exec_command` prints native `C:\Users\...` paths in command output while file tools expect virtual paths.

Fix direction: when a path looks like a Windows absolute path that maps into an approved root, either normalize it safely or return `Use /totec/chatgpt-local-files/package.json, not C:\Users\totec\chatgpt-local-files\package.json`. Keep rejecting paths outside approved roots.

**RESOLVED, VERIFIED 2026-08-17.** `rejectNativePath` in `src/main/sandbox.ts` takes the
second option — the correction, not the normalization. A native path that maps into an
approved root is still refused, because nothing resolving from a native path is what makes the
containment checks in that file mean anything, but the refusal now names the exact virtual
path to write instead. A native path *outside* every root says so and lists the approved
roots, inventing no correction for a path that has no correct form. Covered by 5 tests in
`test/sandbox.test.ts`, including a virtual path that merely resembles a drive path
(`/project/...` — a root name is not a drive letter) and a UNC share. Sandbox roots unchanged.


### Repro: pre-execution Desktop validator dumps full schema for one bad scalar

During the live 2026-08-17 co-review, `ChatGPT_Local_Files_Desktop.computer` was accidentally called with a single action `{ type: "wait", ms: 12000 }` while the schema caps `wait.ms` at 10000. The useful error is only ?`wait.ms` must be <= 10000?, but pre-execution validation returned the entire `computer` JSON schema (all action union branches plus every top-level field, including the cached multi-agent `agent_key` definition). The call never reached the connector. This is a second concrete reproduction of the harness/schema-dump token-waste issue, now on Desktop rather than Core. Local validators should continue to emit compact field/value/constraint/example errors; this particular pre-execution dump is upstream of the connector and cannot be fixed by a handler.

**EXTERNAL — OPEN, confirmed 2026-08-17 (T-122).** Re-confirmed during the tooling pass and
deliberately left unfixed: the dump is emitted before the request reaches this process, so
there is no local seam to intercept it. No local workaround was attempted, because anything
this side could do would be cosmetic and would misrepresent where the problem lives. Recorded
so it is not re-investigated.


## P2 ? `read.max_bytes` is a low-value model-facing budget knob

**Observed repeatedly in normal use.** `read` exposes an optional `max_bytes` on every call (`1..512 KiB`, default 64 KiB per file). Models then routinely manufacture values such as `30000`, `40000`, `60000` even when a line range or the server default already bounds the read. This adds schema surface and argument tokens, makes the model reason in UTF-8 bytes rather than the lines/tokens it is actually trying to inspect, and can truncate a requested range for a reason unrelated to the semantic request.

The output safety requirement is valid; the question is why the model has to own it. Prefer a server-managed whole-result/per-file cap with an explicit `truncated; continue from line N` cursor. The model already has `start_line`/`end_line` when it wants a precise text slice and can split a multi-file request when the server reports the whole-result cap. If an advanced override is retained, consider a human/model-native unit (`max_lines` or an explicit pagination/cursor control) rather than an arbitrary byte number on routine reads. Do not remove the hard internal byte cap.


## RESOLVED — path repetition (the largest single source of wasted call volume)

A coding session spent its whole life inside one project and wrote the same prefix on every
call: `/totec/chatgpt-local-files/src/main/patch.ts` where `src/main/patch.ts` would do. That
is tokens on every call, and it is the part most likely to be got subtly wrong.

A chat's working folder is now *learned* from the absolute paths it already uses, and later
relative paths resolve against it. Nothing is declared, there is no workspace id, and no tool
exists to set one — the folder is a consequence of working. `apply_patch`'s `cwd` and
`exec_command`'s `cwd` both default to it, so a command with no `cwd` runs where the chat has
been working rather than in the first approved root.

Taught once, in the server instructions rather than per tool: *"Once you use a full path,
this chat remembers that project, and later paths may be relative to it … Use a full path
again to move to another project."* Repeating that in five tool descriptions would have cost
more context than the shorthand saves.

Absolute virtual paths mean exactly what they always meant, and every root, containment,
`..` and symlink check still runs on every path.


## RESOLVED — `apply_patch` could land a relative path outside the folder it was given

Separate from the workspace work and worth stating on its own. `apply_patch` joined its base
onto each patch path and ran `posix.normalize` on the result before the sandbox saw it. With
cwd `/workspace/nested`, a patch path of `../escaped.txt` normalised to
`/workspace/escaped.txt` — a perfectly resolvable path inside an approved root — so the write
landed a folder above the one the caller named and nothing reported it. Patch paths now go to
the resolver verbatim with the base passed alongside, which is what makes `..` still meet the
segment check. Regression in `test/mcp.test.ts`; negative-checked by restoring the normalise,
which lets the write through.

## 2026-08-17 ultrathink repair pass — source fixes, exact failures, no install

This pass was deliberately **source-only**. The user explicitly asked not to assemble, package,
install or reload anything, so any live rows produced by the currently running app still describe
the older installed implementation. The source was changed and regression-tested; live smoke is
separate work for a later installed build.

### RESOLVED IN SOURCE — unexplained STOP dropouts no longer manufacture `turn_end: unknown`

The decisive reproducer remains session `2026-08-17-7463fb07`: one local generation was ended
as `unknown`, then its own Core calls arrived seconds later first with `turnId:null` in the right
conversation and later in `Unattributed activity`. The repair keeps two facts separate:

- a **durable open generation**, which may survive a temporary missing STOP control; and
- **direct generation visibility**, which is the only state weak generation/workspace fallback
  may use before a call has stronger page evidence.

`extension/content.js` now emits an ephemeral `turn_state` observation when the direct STOP
signal disappears/returns. `src/main/bridge.ts` validates it, and
`src/main/session/recorder.ts` updates `generationVisible` without writing another transcript
event. `claimGeneration()` and `soleGeneratingConversation()` require that direct flag, so an
uncertain open turn cannot steal a call or a relative workspace from another device. Strong
named Fiber/page evidence can still place work on the durable turn.

An unexplained dropout therefore stays open rather than being converted to `unknown` after an
arbitrary timeout. A final answer, error, explicit user stop or stall still closes normally. A
new authored user message is a hard boundary, including the race where the old STOP disappears
and the new generation's STOP appears between two observer ticks. The first observation after a
reload is exempt from that rule because its in-memory seen set is new and historical user
messages are being rediscovered, not newly submitted.

The ordinary browser lifecycle also stopped consulting app-global `pendingTools`. That number
can describe another chat and therefore cannot prove this page is still waiting on a tool. It
remains available to compaction's process-settling workflow. While the local generation remains
open, progress/page-tool/connector-row scanning continues even if STOP is absent.

### RESOLVED IN SOURCE — Fiber page ids cannot become durable recorder turn ids

The first implementation of stronger named-call retention exposed a subtle identity hazard:
Fiber reports ChatGPT's page `data-turn-id`, while the recorder intentionally uses a local
`g-...` generation id because the page id is reused. Storing the Fiber id directly would have
reintroduced the exact cross-turn identity leak the local generation namespace fixed.

`refreshFiber()` now finds the **newest** Fiber turn matching the assistant section of the
currently bound local generation. Only that occurrence inherits the local `g-...` id. Older
turns with the same recycled page id still prove which conversation issued a call, but their
evidence carries no durable turn id. A regression supplies two Fiber turns with the exact same
page id and proves that the old one is unbound, the live one gets the local generation id, and
the raw page id is never emitted as a recorder turn id.

### RESOLVED IN SOURCE — false `~+2818 −2809` sparse patch metrics

Root cause was `src/main/diffstat.ts::lineDelta()`, not CRLF conversion. After trimming a common
prefix and suffix, it skipped exact LCS whenever either remaining block exceeded 1500 lines and
reported the entire residual size as an approximate replacement. Two one-line edits far apart in
a large file therefore counted thousands of unchanged middle lines.

The large-block path now uses a bounded Myers shortest-edit-distance pass with
`MYERS_EDIT_LIMIT = 512`. Sparse edits have small D and remain exact even in 3,000–4,000 line
files; a real giant rewrite reaches the bound and deliberately retains the approximate fallback.
`applyTextPatch()` also counts hunk add/delete markers directly, so its own result is exact by
construction rather than trying to rediscover what a patch it just applied did.

Repeated `*** Update File:` blocks had a second metric bug: intermediate deltas were summed.
`one -> two -> three` therefore said +2/−2 although disk-original -> final is +1/−1, and
`one -> two -> one` could claim a change when the committed text was identical. A staged path now
keeps `originalText` and recalculates one original -> final delta. Direct MCP patch output also
prefixes a genuinely approximate result with `~` instead of hiding that fact.

Regressions cover distant sparse LF changes, CRLF preservation, repeated update blocks, a total
undo, and an intentionally huge rewrite that remains bounded/approximate.

### RESOLVED IN SOURCE — live managed processes no longer look completed

`CallEvidence` now has explicit `running` and `processSessionId` fields. Managed-process lifetime
is evidence about the child; `ToolCallRecord.durationMs` is always the MCP call's request/response
wall time. `exec_command` records process state, and `write_stdin` records the state returned by
poll, interrupt and kill operations.

A live child is summarized neutrally as `Started <command>` with metric `running`. A clean
completed process may use `Ran <command>` with a green duration, while non-zero/timeout behavior
remains error-colored and explicit. This fixes the misleading `✓ 10.0s` completion claim without
pretending the MCP call itself failed. Folding a later `write_stdin` exit back into the original
exec row is a possible future presentation improvement, not required for correctness of the new
record.

### RESOLVED IN SOURCE — prime/worker broker communication could start in an unreachable state

The worker broker itself worked in the live audit: both workers joined, sent checkpoints, and
eventually persisted final results to `state/swarm.json`. The failed link was the prime. Repeated
`agents status` from the creating chat said:

`This conversation is not registered as an agent, so this is the run as an observer sees it.`

Attempting to answer worker-1 then returned:

`Workers may only message the prime agent. Send it there and let the prime decide.`

So the initial spawn had created a prime and workers before the creating conversation was bound.
Worker-to-broker delivery succeeded, but the real user chat could neither consume nor answer its
checkpoints.

Prime control now uses `awaitFreshCallOrigin('agents', ...)`: exact Fiber request evidence for
the `agents` tool wins, with the old fresh generic connector-row handshake only as a bounded
fallback. More importantly, the **first** `agents spawn` refuses before any swarm mutation if it
cannot prove a conversation or transport identity. It creates zero workers instead of an
unreachable prime. A regression exercises the full path: exact Fiber evidence binds prime,
worker joins with its capability, worker sends a checkpoint, prime proves a later status call,
and that result contains the checkpoint.

The live run that exposed this remains broken in memory because this source pass was not
installed. Its worker results were recovered directly from durable `swarm.json`; no result was
lost.

### RESOLVED IN SOURCE — historical worker rows falsely showed the current worker as `joined`

The desktop screenshot showed several old `worker-2` sessions all wearing `joined`. The renderer
matched a session to live swarm state by the reusable slot id (`worker-1`, `worker-2`) alone.
Those ids repeat every run. `sessionBadges()` now requires both the same agent id and the exact
same ChatGPT `conversationId` before borrowing a live state chip. A renderer regression pins that
two-key rule.

### RESOLVED IN SOURCE — text patches now reject literal NUL corruption

The earlier audit recorded a model edit that accidentally materialized a literal `0x00` in
TypeScript while intending to spell a source escape. `apply_patch` now refuses a patch containing
a literal NUL before parsing/mutation. This prevents an ordinary text/source patch from turning a
file into something later read/search paths correctly treat as binary. A parser regression covers
the refusal.

### Tool-call failures during this repair pass, classified exactly

- **Product/identity failure, reproduced live:** the observer chat could read worker state but
  `agents action=message` was refused as non-prime. This was the unbound-prime bug above, and is
  fixed in source.
- **Caller schema error:** one `write_stdin` call requested `max_lines: 240` although the schema
  maximum is 200. The request never reached Core. The client again dumped the full schema, which
  independently reproduces external T-122.
- **Caller/stale patch errors:** several multi-file `apply_patch` attempts contained an empty
  hunk or stale expected context. Each was rejected atomically; no partial mutation landed.
- **Test expectation errors after intentional semantics changes:** the first lifecycle-focused
  run had 3 failures because fixtures still expected `pendingTools==0` to close an unknown turn,
  expected silent turns to be manufactured as `unknown`, or omitted a final answer from a
  completed-turn fixture. Tests were updated to the new contract.
- **New-test flush mistake:** one Fiber-id regression initially saw zero events because
  `refreshFiber()` queues evidence and the test inspected the fake service worker before the
  normal observer flush. Adding the real observer tick made the isolated regression pass.
- **Implementation/test compile errors:** one typecheck found a literal `CallEvidence` fixture
  missing the two new process-state fields and a test reading `turnId` from the wrong return
  type. Both were corrected; the next typecheck was clean.
- **Caller shell/platform error:** `rg ... test/*.test.ts` used a wildcard form Windows passed
  literally to ripgrep, producing a filename syntax error. This says nothing about MCP search.
- **Expected old-binary display:** patch calls issued during this session can still show giant
  false line counts in the live app because the app serving the connector predates this source
  fix. The user explicitly prohibited build/package/install/reload, so no live result from this
  run can validate or invalidate the new line-count code.

None of the validation/stale-test/shell mistakes above should be counted as MCP execution
failures. They are recorded because the user explicitly wants every failed tool interaction kept
for later harness work, with the layer responsible named rather than collapsed into one error
count.

Final source verification for this repair pass: `npx tsc --noEmit` completed cleanly and the
complete `npx vitest run` suite finished **938 passed / 1 skipped / 0 failed across 26 test
files**. This deliberately excludes packaging/build/install/reload work; none was run.
