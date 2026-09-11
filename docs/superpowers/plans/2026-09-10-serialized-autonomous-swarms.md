# Serialized Autonomous Swarms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a single accepted ChatGPT objective to finish its whole verified task graph automatically, using at most two app-originated active ChatGPT turns, six total owned worker chats, and two owned workers per prime conversation.

**Architecture:** Extend the existing durable orchestration journal and `agents.ts` ownership broker; do not add a second task graph or a generic browser-send API. A new serialized autonomous-swarm scheduler owns global permits, fair per-prime queueing, and restart-safe dispatch leases. `bridge.ts` and the Chrome extension remain delivery/observation layers, while exact worker/conversation identity and local tool permissions stay authoritative in Core.

**Tech Stack:** Electron main-process TypeScript, existing durable JSON/event journal, Chrome MV3 extension JavaScript, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-10-serialized-autonomous-swarms-design.md`

## Global Constraints

- Preserve unrelated dirty work; do not reset, clean, checkout, reformat broadly, commit, push, or deploy without separate user authorization.
- Do not automate rate-limit evasion or create account/tab/request fallbacks to bypass provider limits.
- Exactly two app-originated ChatGPT turns may await browser-settled evidence globally; manual user messages remain outside this scheduler.
- Exactly six app-owned worker conversations globally and two per prime conversation; workers cannot self-spawn or cross-prime reuse.
- An accepted standard goal has no app-level total-token cutoff, but every request, output, durable record, retry, and no-progress detector remains bounded.
- Browser observation is never capability authority; MCP/kernel permission, sandbox, read-only, and exact request-to-conversation correlation rules remain unchanged.
- A task's completion prose is not evidence: only its defined tool/test/review evidence may unlock dependencies or close the parent goal.

---

## File and responsibility map

| File | Responsibility after this work |
| --- | --- |
| `src/shared/types.ts`, `src/shared/session.ts` | Exact settings and wire projections for global swarm capacity and queue state. |
| `src/main/agents.ts` | Multi-prime ownership registry; preserves exact prime/worker identity and stages worker changes without direct browser sends. |
| `src/main/orchestration/types.ts`, `reducer.ts`, `store.ts`, `recovery.ts` | Versioned durable swarm-run/dispatch-lease events, state validation, replay, and restart repair. |
| `src/main/orchestration/autonomous-scheduler.ts` (new) | Fair round-robin queue, two global permits, per-prime worker caps, backoff/no-progress policy. |
| `src/main/orchestration/scheduler.ts` | Delegates one eligible task assignment to the autonomous scheduler rather than assuming one active prime. |
| `src/main/bridge.ts`, `extension/agent-tab-lifecycle.js` | Binds browser command receipts and settled-turn evidence to a lease; maintains six system-owned tab leases without touching user tabs. |
| `src/main/goal.ts`, `src/main/execution.ts`, `src/main/mcp/session-tool.ts` | Starts/continues an autonomous task graph from one approved goal; preserves ordinary Goal Mode and existing single execution behavior. |
| `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/chat.ts`, `src/renderer/index.html` | Narrow read/control IPC and queue/status UI; no renderer escape hatch. |
| `test/*` | Deterministic capacity, ordering, restart, backoff, negative-security, and UI regression coverage. |

## Task 1: Freeze existing behavior and introduce fixed capacity contract

**Files:**
- Modify: `src/shared/types.ts`, `src/main/config.ts`, `src/renderer/chat.ts`, `src/renderer/index.html`
- Modify: `test/config.test.ts`, `test/renderer-state.test.ts`

**Interfaces:**
- Produces `AUTONOMOUS_SWARM_LIMITS = { activeTurns: 2, totalWorkerChats: 6, workersPerPrime: 2 } as const` from a shared module.
- Produces a read-only `AutonomousSwarmCapacity` projection: `{ activeTurns, activeTurnLimit, ownedWorkerChats, workerChatLimit, ownerWorkerLimit, queuedTasks, cooldownUntil }`.
- Existing `MultiAgentSettings.maxWorkers` remains readable for legacy runs; it must not silently expand old settings.

- [ ] **Step 1: Add failing config tests for the immutable capacity constants and legacy migration.**

```ts
expect(autonomousSwarmLimits()).toEqual({ activeTurns: 2, totalWorkerChats: 6, workersPerPrime: 2 });
expect((await loadConfig()).multiAgent.maxWorkers).toBe(existingValue);
```

- [ ] **Step 2: Run the focused test before implementation.**

Run: `npm test -- --run test/config.test.ts`

Expected: FAIL because the shared capacity export and projection do not exist.

- [ ] **Step 3: Add the shared fixed-capacity declaration and use it in validation/UI copy.**

```ts
export const AUTONOMOUS_SWARM_LIMITS = Object.freeze({
  activeTurns: 2,
  totalWorkerChats: 6,
  workersPerPrime: 2
});
```

Keep legacy `maxWorkers` migration-compatible. Replace the lone worker-count UI wording with a non-editable explanation of the three caps; do not imply the user can raise them beyond the approved values.

- [ ] **Step 4: Add a renderer-state regression asserting that applying config never overwrites an unsaved field and renders the fixed caps.**

```ts
expect(screen.getByText('2 active ChatGPT turns')).toBeTruthy();
expect(screen.getByText('6 total worker chats')).toBeTruthy();
```

- [ ] **Step 5: Run focused checks.**

Run: `npm test -- --run test/config.test.ts test/renderer-state.test.ts`

Expected: PASS.

## Task 2: Make worker ownership multi-prime without loosening identity rules

**Files:**
- Modify: `src/main/agents.ts`, `src/shared/session.ts`
- Modify: `test/agents.test.ts`, `test/swarm.test.ts`

**Interfaces:**
- Replaces the single executing-run assumption with `activeRunsByPrime: Map<string, Run>` plus an exact `workerConversation -> { primeConversationId, workerId, runId }` ownership index.
- Produces `workerCountsForPrime(primeConversationId)` and `totalOwnedWorkerChats()`.
- Preserves `stageSpawn`, `stageMessages`, durable acceptance barriers, `persistCriticalSwarmNow`, and exact `bindConversation` semantics.

- [ ] **Step 1: Write failing ownership tests before changing the broker.**

```ts
spawnFor(PRIME_A, 2);
spawnFor(PRIME_B, 2);
spawnFor(PRIME_C, 2);
expect(totalOwnedWorkerChats()).toBe(6);
expect(() => spawnFor(PRIME_A, 1)).toThrow(/workersPerPrime|2/);
expect(resolve({ conversationId: workerOf(PRIME_B) })?.primeConversationId).toBe(PRIME_B);
```

Include the negative cases: a worker cannot spawn, a stranger cannot inspect another prime, and a reused sleeping worker cannot be reassigned across primes.

- [ ] **Step 2: Run the focused broker tests.**

Run: `npm test -- --run test/agents.test.ts test/swarm.test.ts`

Expected: FAIL because one active run currently blocks the second prime.

- [ ] **Step 3: Refactor the broker storage atomically.**

Move only active-run lookup/serialization from a singleton to maps keyed by the exact prime conversation. Keep all worker-facing function signatures either owner-explicit or resolved through the existing correlation proof; never derive an owner from tab recency. Enforce `AUTONOMOUS_SWARM_LIMITS.workersPerPrime` in the staging path before any mutation and enforce the global six only through the scheduler reservation added in Task 4.

- [ ] **Step 4: Version and test durable swarm restoration.**

Write an upgrade reader that accepts the legacy single-run snapshot and restores it as one map entry. Reject duplicate worker conversation ids and conflicting prime ownership during restoration. Persist only after validation; a corrupt record must fail closed to dormant/recovery state rather than guessing ownership.

- [ ] **Step 5: Run focused checks.**

Run: `npm test -- --run test/agents.test.ts test/swarm.test.ts`

Expected: PASS, including restart and cross-prime negative cases.

## Task 3: Add durable autonomous-swarm events and replayable dispatch leases

**Files:**
- Modify: `src/main/orchestration/types.ts`, `src/main/orchestration/reducer.ts`, `src/main/orchestration/store.ts`, `src/main/orchestration/recovery.ts`
- Create: `src/main/orchestration/autonomous-swarm.ts`
- Modify: `test/orchestration-store.test.ts`, `test/orchestration-recovery.test.ts`, `test/orchestration-task-state.test.ts`

**Interfaces:**
- Produces `AutonomousSwarmRun`, `DispatchLease`, and event types `SWARM_RUN_STARTED`, `DISPATCH_QUEUED`, `DISPATCH_LEASED`, `DISPATCH_BROWSER_COMMITTED`, `DISPATCH_SETTLED`, `DISPATCH_BACKOFF`, `DISPATCH_BLOCKED`, `SWARM_RUN_COMPLETED`, `SWARM_RUN_PAUSED`, `SWARM_RUN_STOPPED`.
- `DispatchLease` includes `{ leaseId, goalRunId, taskId, primeConversationId, workerId, conversationId, commandId, browserEpoch, turnId, createdAt }`; nullable fields become non-null only in the event that proves them.
- Produces `recoverAutonomousSwarmState()` which restores queue order and repairs only leases whose command/worker evidence still matches exactly.

- [ ] **Step 1: Write reducer tests for legal event order and illegal order rejection.**

```ts
expect(reduce(eventsForQueuedThenLeased())).toMatchObject({ activeLeases: ['lease-1'] });
expect(() => reduce([settledWithoutLease])).toThrow(/DISPATCH_SETTLED.*lease/i);
expect(() => reduce([leaseForWrongPrimeWorker])).toThrow(/ownership/i);
```

- [ ] **Step 2: Run the new focused tests.**

Run: `npm test -- --run test/orchestration-store.test.ts test/orchestration-recovery.test.ts test/orchestration-task-state.test.ts`

Expected: FAIL because autonomous-swarm state is absent.

- [ ] **Step 3: Add event-sourced state with bounded fields and idempotent event ids.**

Use the existing append-only orchestration journal and snapshot compaction, not a second state directory. Bound reason text, task continuation text, retry metadata, and evidence references. Make every reducer transition verify the task, prime, worker, and command identity before changing state.

- [ ] **Step 4: Add crash-window replay tests.**

Test journal recovery after: lease persisted before bridge command publication; browser command committed before `DISPATCH_BROWSER_COMMITTED`; and stale persisted lease after worker/prime ownership changed. Assert one exact command is republished only when all identities match; otherwise leave the task queued/blocked with a typed reason.

- [ ] **Step 5: Run focused checks.**

Run: `npm test -- --run test/orchestration-store.test.ts test/orchestration-recovery.test.ts test/orchestration-task-state.test.ts`

Expected: PASS.

## Task 4: Implement fair two-permit scheduling and six-chat allocation

**Files:**
- Create: `src/main/orchestration/autonomous-scheduler.ts`
- Modify: `src/main/orchestration/scheduler.ts`, `src/main/orchestration/worker-allocation.ts`, `src/main/orchestration/broker-assignment.ts`
- Create: `test/autonomous-scheduler.test.ts`
- Modify: `test/orchestration-scheduler.test.ts`, `test/orchestration-worker-allocation.test.ts`

**Interfaces:**
- Produces `runAutonomousSchedulerCycle()` serialized through one promise tail, returning `{ leased, queued, cooldownUntil, blocked }`.
- Consumes durable ready tasks and `activeRunsByPrime`; calls broker staging only after a global permit and worker-chat reservation are durable.
- Uses `selectNextPrimeRoundRobin(eligiblePrimeIds, lastGrantedPrimeId)` and `selectWorkerAllocationForPrime(...)`.

- [ ] **Step 1: Write deterministic scheduler tests with a fake clock.**

```ts
await enqueueReadyTasks({ A: 2, B: 2, C: 2, D: 2 });
await runAutonomousSchedulerCycle();
expect(ownedWorkersByPrime()).toEqual({ A: 2, B: 2, C: 1, D: 1 });
expect(activeDispatchLeaseCount()).toBeLessThanOrEqual(2);
```

Also assert that another run drains fairly after a settled lease, that a third worker for one prime is refused, and that a sleeping worker is reused only for its owner.

- [ ] **Step 2: Run tests to verify the missing scheduler.**

Run: `npm test -- --run test/autonomous-scheduler.test.ts test/orchestration-scheduler.test.ts test/orchestration-worker-allocation.test.ts`

Expected: FAIL because global permits and round-robin allocation do not exist.

- [ ] **Step 3: Implement reservation-before-action scheduling.**

Persist `DISPATCH_LEASED` before calling `stageSpawn`/`stageMessages`; reserve the selected prime's worker count and one of the two permits in the same serialized cycle. On any pre-publication failure, append a typed abort/backoff transition and release only that exact reservation. Reuse `formatTaskContract()` so every automatic continuation identifies remaining in-scope work, required verification, known failure, and operation id—never a bare `continue`.

- [ ] **Step 4: Integrate with the existing per-runtime scheduler.**

Keep worktree preparation and Manager authority checks in `scheduler.ts`. Replace its implicit "one owner" free-slot assumption with the autonomous scheduler's global reservation result. Do not assign a task if its dependencies lack recorded evidence or if worktree creation has not completed.

- [ ] **Step 5: Run focused checks.**

Run: `npm test -- --run test/autonomous-scheduler.test.ts test/orchestration-scheduler.test.ts test/orchestration-worker-allocation.test.ts test/swarm.test.ts`

Expected: PASS.

## Task 5: Couple browser delivery and settled-turn evidence to leases

**Files:**
- Modify: `src/main/bridge.ts`, `extension/content.js`, `extension/background.js`, `extension/agent-tab-lifecycle.js`
- Modify: `test/bridge.test.ts`, `test/content-script.test.ts`, `test/extension.test.ts`, `test/agent-tab-budget.test.ts`

**Interfaces:**
- Adds a narrow bridge callback `recordDispatchBrowserCommit(leaseId, commandId, conversationId, browserEpoch)` and `recordDispatchSettled(leaseId, conversationId, turnId, outcome)`.
- The extension's system-owned tab budget becomes six; it continues to ignore user tabs and refuses unsafe overflow-tab closure after navigation.
- A lease permit is released only after the existing exact settled-turn evidence, not merely after text insertion or an HTTP acknowledgement.

- [ ] **Step 1: Write failing bridge/content-script ordering tests.**

```ts
await deliverLease('lease-a', workerA);
await expect(deliverLease('lease-b', workerA)).rejects.toThrow(/unsettled|active turn/i);
await settleLease('lease-a', { turnId: 'turn-a' });
await expect(deliverLease('lease-b', workerA)).resolves.toMatchObject({ commandId: expect.any(String) });
```

Add stale A->B->A navigation, duplicate receipt, browser reload, and user-tab non-interference cases. Update the tab-budget assertions from five to six system-owned leases and ensure a seventh is queued.

- [ ] **Step 2: Run focused delivery tests.**

Run: `npm test -- --run test/bridge.test.ts test/content-script.test.ts test/extension.test.ts test/agent-tab-budget.test.ts`

Expected: FAIL for new lease callbacks and the sixth-tab expectation.

- [ ] **Step 3: Implement idempotent bridge coupling.**

Derive all bridge command identity from existing durable command ids. Bind it once to a durable lease only after the command is claimed by the exact document. On settlement, verify command id, conversation id, browser epoch, and turn id before emitting `DISPATCH_SETTLED`; stale/duplicate reports become no-ops with redacted diagnostics.

- [ ] **Step 4: Implement provider backoff without new-tab fallback.**

Classify provider/rate-limit text already detected by the extension as a typed retryable outcome. Persist `DISPATCH_BACKOFF` with capped exponential delay and jitter; repeated global provider failures create one visible cooldown. Assert a retry neither increases active permits nor creates an extra system-owned tab.

- [ ] **Step 5: Run focused delivery tests.**

Run: `npm test -- --run test/bridge.test.ts test/content-script.test.ts test/extension.test.ts test/agent-tab-budget.test.ts`

Expected: PASS.

## Task 6: Start and continue a single autonomous objective to verified completion

**Files:**
- Modify: `src/main/goal.ts`, `src/main/execution.ts`, `src/main/mcp/session-tool.ts`, `src/main/orchestration/workflow.ts`, `src/main/orchestration/manager-surface.ts`
- Modify: `src/shared/goal.ts`
- Modify: `test/goal.test.ts`, `test/execution.test.ts`, `test/orchestration-workflow.test.ts`, `test/bridge.test.ts`

**Interfaces:**
- Adds an explicit `autonomous_swarm` launch mode to the existing durable execution/goal path, returning `goal_run_id` and preserving `execution_id` when present.
- `advanceAutonomousGoal(goalRunId, settledLease)` evaluates graph state and schedules remaining eligible work; it returns `completed`, `scheduled`, `blocked`, or `paused`.
- Ordinary Goal Mode and `execution_start` standard/infinite semantics remain unchanged unless the user explicitly selects autonomous swarm.

- [ ] **Step 1: Write end-to-end state-machine tests for one initial objective.**

```ts
const run = await startAutonomousGoal({ objective: 'fix A and B, then verify both' });
await settleVerifiedLeaf(run, 'A');
expect(nextDispatch(run)).toMatchObject({ taskId: 'B' });
expect(userFacingMessages(run)).not.toContain('continue?');
await settleVerifiedLeaf(run, 'B');
expect(status(run)).toBe('completed');
```

Include a failed test that is safely retried, an external deploy task that blocks for authority, and an independent task that may proceed while another leaf is blocked.

- [ ] **Step 2: Run focused objective tests.**

Run: `npm test -- --run test/goal.test.ts test/execution.test.ts test/orchestration-workflow.test.ts test/bridge.test.ts`

Expected: FAIL because worker chats are currently excluded from Goal continuation.

- [ ] **Step 3: Implement the autonomous continuation policy.**

Keep the existing Goal model's role limited to bounded continuation drafting; it must not decide permissions or completion from prose alone. Build every worker continuation from the durable task contract and verified reducer state. Mark the parent complete only when all required tasks are `VERIFIED`; standard mode must not choose unrelated follow-up work, while explicit infinite mode follows its documented milestone rule.

- [ ] **Step 4: Add no-progress protection without a cumulative token budget.**

Hash the bounded continuation contract and compare it with the last durable task/tool transition. After the configured conservative repeated-no-progress threshold, append `DISPATCH_BLOCKED` with evidence and stop dispatching that task. Do not silently consume unbounded turns, and do not stop independent eligible tasks.

- [ ] **Step 5: Run focused objective tests.**

Run: `npm test -- --run test/goal.test.ts test/execution.test.ts test/orchestration-workflow.test.ts test/bridge.test.ts`

Expected: PASS.

## Task 7: Expose safe status and controls in the desktop UI

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/chat.ts`, `src/renderer/index.html`, `src/renderer/styles.css`
- Modify: `src/shared/types.ts`
- Modify: `test/ipc.test.ts`, `test/renderer-layout.test.ts`, `test/renderer-state.test.ts`

**Interfaces:**
- Adds named preload methods only: `autonomousSwarmStatus()`, `pauseAutonomousGoal(goalRunId)`, `resumeAutonomousGoal(goalRunId)`, `stopAutonomousGoal(goalRunId)`.
- Status is a redacted projection: no native worktree paths, task raw prompts beyond existing session visibility, credentials, or hidden reasoning.

- [ ] **Step 1: Write IPC schema and renderer tests.**

```ts
expect(await api.autonomousSwarmStatus()).toMatchObject({ activeTurns: 0, activeTurnLimit: 2, workerChatLimit: 6 });
expect(Object.keys(preloadApi)).not.toContain('invoke');
expect(renderedQueue()).toContain('Queued');
```

Test pause/resume/stop validation with an unknown id and with a goal owned by another conversation; both must fail closed.

- [ ] **Step 2: Run focused UI tests.**

Run: `npm test -- --run test/ipc.test.ts test/renderer-layout.test.ts test/renderer-state.test.ts`

Expected: FAIL because no autonomous-swarm UI contract exists.

- [ ] **Step 3: Implement narrow IPC and queue panel.**

Validate every goal id in main process, project a generation-scoped status payload, and expose only the named preload methods. Render active permits, global cooldown, each goal's next task, queue position, worker count, and typed pause/block reason. Never replace a focused draft or use a generic IPC dispatcher.

- [ ] **Step 4: Run focused UI tests.**

Run: `npm test -- --run test/ipc.test.ts test/renderer-layout.test.ts test/renderer-state.test.ts`

Expected: PASS.

## Task 8: Add adversarial, observability, and completion gates

**Files:**
- Create: `test/autonomous-swarm-security.test.ts`, `test/autonomous-swarm-observability.test.ts`
- Modify: `src/main/logger.ts`, `src/main/orchestration/autonomous-scheduler.ts`, `docs/superpowers/specs/2026-09-10-serialized-autonomous-swarms-design.md`
- Create: `.inmersion/evidence/ledgers/serialized-autonomous-swarms.json` only after inspecting and approving its exact check commands.

**Interfaces:**
- Emits redacted operational events: `goalRunId`, task id, lease id, typed outcome, retry count, durations, active permit count, and cooldown; never provider keys, raw user content, or chain-of-thought.
- Produces reproducible negative tests for cross-prime ownership, untrusted worker output, stale browser evidence, and provider retry storms.

- [ ] **Step 1: Write security/telemetry tests first.**

```ts
expect(() => settleLeaseForOtherPrime()).toThrow(/ownership/i);
expect(events()).toContainEqual(expect.objectContaining({ kind: 'dispatch_backoff', retry: 1 }));
expect(JSON.stringify(events())).not.toContain(testApiKey);
```

Include a hostile worker result that says to bypass scope or dispatch another chat; assert the reducer treats it as data and no command is emitted.

- [ ] **Step 2: Run the focused tests before implementation.**

Run: `npm test -- --run test/autonomous-swarm-security.test.ts test/autonomous-swarm-observability.test.ts`

Expected: FAIL because the typed events and defensive rejections are absent.

- [ ] **Step 3: Add redacted telemetry and deterministic defenses.**

Log state transitions at scheduler/bridge boundaries only. Keep secrets and user payloads out of logs and durable operational events. Enforce no-progress, ownership, provider backoff, and cross-prime rules in Core reducers/scheduler, not in prompts.

- [ ] **Step 4: Run focused evidence checks.**

Run: `npm test -- --run test/autonomous-swarm-security.test.ts test/autonomous-swarm-observability.test.ts`

Expected: PASS.

- [ ] **Step 5: Define, review, and run the Evidence Engine gates.**

Before executing a gate, inspect its exact argv, expectation, cwd, timeout, platform, and environment fingerprint. Add separate gates for focused autonomy tests, `npm run typecheck`, and the repository verification command. Use `brain gate-approve` for each exact check, then run it with `brain gate-run`; parent re-verifies any delegated implementation evidence.

## Task 9: Final integration and release-quality verification

**Files:**
- Modify only files required by test fixes discovered in Tasks 1–8.
- Inspect: changed source/tests, `package.json`, `electron-builder.yml`, extension packaged paths.

**Interfaces:**
- No new model-visible broad tool or browser route.
- No unrelated changes staged or overwritten.

- [ ] **Step 1: Review the final changed-file diff and run whitespace/secret checks.**

Run: `git diff --check`

Expected: no whitespace errors. Inspect the exact changed paths for credentials and accidental generated files; do not print any secret-like values.

- [ ] **Step 2: Run all direct feature suites.**

Run: `npm test -- --run test/agents.test.ts test/swarm.test.ts test/bridge.test.ts test/content-script.test.ts test/extension.test.ts test/agent-tab-budget.test.ts test/goal.test.ts test/execution.test.ts test/orchestration-store.test.ts test/orchestration-recovery.test.ts test/orchestration-scheduler.test.ts test/orchestration-workflow.test.ts test/ipc.test.ts test/renderer-layout.test.ts test/renderer-state.test.ts test/autonomous-scheduler.test.ts test/autonomous-swarm-security.test.ts test/autonomous-swarm-observability.test.ts`

Expected: PASS.

- [ ] **Step 3: Run typecheck, full repository verification, and build according to approved Evidence gates.**

Run: `npm run typecheck`

Run: `npm run verify`

Run: `npm run build`

Expected: each exits successfully. If an unrelated existing failure remains, report its exact scope and do not present the repository as globally green.

- [ ] **Step 4: Perform an installed/runtime smoke test if packaging-related code changed.**

Verify the packaged extension contains `agent-tab-lifecycle.js`, reports the six-tab budget, and a live paired browser proves exactly two app-originated turns are active while remaining tasks are queued. Do not call this complete based only on source/unit tests.

- [ ] **Step 5: Final Evidence audit and handoff.**

Run `brain gate-final-audit` for the ledger created in Task 8. Report source tests, packaged/runtime proof, skipped checks, external-provider limitations, and every abandoned gate separately. Do not commit, push, deploy, or alter unrelated dirty work without a new explicit request.

## Plan self-review

**Spec coverage:** Tasks 1–2 enforce the 2/6/2 limits and exact multi-prime ownership. Tasks 3–5 implement durable fair permits, browser-settled leases, restart repair, and rate-limit backoff. Task 6 supplies the one-message autonomous completion behavior with no routine continuation question and no cumulative token cutoff. Tasks 7–8 cover visible control, privacy, hostile worker data, observability, and evidence gates. Task 9 requires source, full-suite, build, and installed-browser proof.

**Placeholder scan:** No deferred implementation markers remain. Each implementation task defines concrete source/test files, interfaces, a failing test, command, minimal implementation direction, and passing check.

**Type consistency:** `AutonomousSwarmRun`, `DispatchLease`, `runAutonomousSchedulerCycle`, `recordDispatchBrowserCommit`, `recordDispatchSettled`, and `advanceAutonomousGoal` are defined once here and used consistently by later tasks.
