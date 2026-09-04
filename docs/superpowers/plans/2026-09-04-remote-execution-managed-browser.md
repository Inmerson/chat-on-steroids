# Remote Execution and Managed Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated phone/remote ChatGPT conversation durably start, inspect, pause, resume, and stop an autonomous desktop execution, while routing main executions and worker chats into separate managed Chrome windows and closing worker tabs only at safe lifecycle boundaries.

**Architecture:** Core owns a durable `executionRunId` and approved plan. To preserve the Core connector's seven-tool ceiling, execution control becomes first-class actions on the existing `session` tool rather than an eighth MCP schema. The bridge stores only execution command specs and resolves the full plan at redeem time; command-marker URLs carry correlation ids only. The extension routes proven command-owned tabs into session-scoped Execution/Agent windows. Worker cleanup is driven by durable app-side sleep/terminal evidence surfaced to the worker content document, then re-proved against the extension's owned lease before close.

**Tech Stack:** TypeScript, Zod, MCP SDK registration, app durable JSON store, bridge HTTP command queue, Chrome MV3 extension APIs, Vitest/jsdom/VM harnesses.

**Spec:** `docs/superpowers/specs/2026-09-04-remote-autonomous-execution-design.md`

## Global Constraints

- The Core model-facing surface must stay at seven tools maximum when recording and multi-agent are both enabled.
- The full approved plan must be durable in Core before any browser open side effect.
- Browser command ids are Core-generated correlations, never model-provided credentials.
- A remote caller never supplies tab ids, document ids, conversation ids, or bridge tokens.
- Phone/control disconnect after durable acceptance must not stop a desktop execution.
- Main execution tabs and worker tabs use separate managed Chrome windows in the same profile; ordinary user tabs are never moved by URL heuristic.
- Worker tab close is presentation cleanup, not evidence that the server-side model turn stopped.
- Worker tabs do not close merely because bootstrap text was accepted; safe sleep/terminal evidence is required.
- All newly authored first-party text is English.
- Plan 1 (`2026-09-04-recovery-state-isolation.md`) must be green before this plan begins.

## File Map

- Create `src/main/execution.ts`: durable execution run model, state transitions, prompt contract, snapshot/restore, browser-command lifecycle hooks.
- Modify `src/main/mcp/session-tool.ts`: add `execution_start`, `execution_status`, `execution_pause`, `execution_resume`, `execution_stop` actions while retaining `search`/`read`.
- Modify `src/main/mcp/tools-core.ts`: register `session` unconditionally so execution control exists even when recording is disabled; keep search/read feature-gated internally.
- Modify `src/main/bridge.ts`: add execution command specs/wire payload, queue/redeem/ACK integration, activity projection, resume/stop retirement.
- Modify `src/main/index.ts`: restore execution snapshot and wire execution persistence/browser command publication during startup.
- Modify `extension/background.js`: managed Execution/Agent windows and command-owned tab routing.
- Modify `extension/content.js`: execution bootstrap state binding, activity-driven pause/resume, worker safe-close request.
- Modify `extension/agent-tab-lifecycle.js`: separate bootstrap durability from safe-close eligibility.
- Modify `test/mcp.test.ts`, `test/bridge.test.ts`, `test/extension.test.ts`, `test/content-script.test.ts`, `test/agent-tab-lifecycle.test.ts`.

---

### Task 1: Add the durable execution-run model

**Files:**
- Create: `src/main/execution.ts`
- Create: `test/execution.test.ts`

**Interfaces:**
- Produces:

```ts
export const EXECUTION_STATE = 'execution-runs';
export const MAX_EXECUTION_PLAN_CHARS = 120_000;

export type ExecutionLoopMode = 'standard' | 'infinite';
export type ExecutionRunStatus = 'starting' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed';

export interface ExecutionRun {
  id: string;
  title: string | null;
  plan: string;
  mode: ExecutionLoopMode;
  status: ExecutionRunStatus;
  conversationId: string | null;
  commandId: string | null;
  createdAt: number;
  updatedAt: number;
  stoppedAt: number | null;
  lastError: string | null;
}

export interface ExecutionSnapshot {
  version: 1;
  runs: ExecutionRun[];
}

export function snapshotExecutions(): ExecutionSnapshot;
export function restoreExecutions(snapshot: ExecutionSnapshot | null): void;
export function executionRun(id: string): ExecutionRun | null;
export function executionForConversation(conversationId: string): ExecutionRun | null;
export async function createExecution(input: { plan: string; title?: string; mode: ExecutionLoopMode }): Promise<ExecutionRun>;
export async function noteExecutionCommand(id: string, commandId: string): Promise<ExecutionRun>;
export async function bindExecutionConversation(id: string, conversationId: string): Promise<ExecutionRun>;
export async function setExecutionStatus(id: string, status: ExecutionRunStatus, error?: string | null): Promise<ExecutionRun>;
export function executionBootstrapText(id: string): string;
export function resetExecutionsForTests(): void;
```

- Consumes: `writeDurableNow(EXECUTION_STATE, snapshotExecutions())` and `randomUUID()`.

- [ ] **Step 1: Write failing model tests**

Cover bounded plan validation, durable write-before-return, snapshot/restore, idempotent pause/stop, conversation binding uniqueness, and English execution framing.

```ts
it('persists the full approved plan before returning a starting run', async () => {
  const run = await createExecution({ plan: 'Implement the approved recovery plan.', mode: 'standard' });
  const stored = await readDurable<ExecutionSnapshot>(EXECUTION_STATE);
  expect(stored?.runs.find((row) => row.id === run.id)?.plan).toBe('Implement the approved recovery plan.');
  expect(run.status).toBe('starting');
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/execution.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement the bounded state machine**

Every mutation clones the selected run, updates `updatedAt`, replaces it in the in-memory map, then awaits `writeDurableNow` before returning. On durable write failure, restore the previous in-memory value before throwing.

- [ ] **Step 4: Implement the app-owned prompt contract**

`executionBootstrapText(id)` returns bounded English framing followed by the exact approved plan:

```text
@Chat On Steroids Core

Execute only the approved plan below autonomously. Preserve unrelated working-tree changes. Make routine technical decisions yourself when safe. Use Chat On Steroids Core tools as needed. Verify the implementation before declaring completion. Stop and surface a blocker only for a real authorization, destructive, privacy, or unresolved ambiguity boundary.

APPROVED PLAN
<plan>
```

Infinite mode adds one sentence allowing a new improvement only after the current milestone is verified complete; standard mode explicitly forbids unrelated feature expansion.

- [ ] **Step 5: Run GREEN**

```bash
npx vitest run test/execution.test.ts
```

- [ ] **Step 6: Commit only task-owned hunks**

Stage the new files and verify the cached diff contains only this task before committing:

```bash
git add src/main/execution.ts test/execution.test.ts
git diff --cached -- src/main/execution.ts test/execution.test.ts
git commit -m "feat(core): add durable autonomous execution runs"
```

---

### Task 2: Extend the existing `session` tool without exceeding seven Core tools

**Files:**
- Modify: `src/main/mcp/session-tool.ts`
- Modify: `src/main/mcp/tools-core.ts`
- Modify: `test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 1 execution functions plus Task 3 `queueExecutionBootstrap`, `queueExecutionResume`, and `cancelExecutionCommands`.
- Produces the exact schema actions:

```ts
type SessionAction =
  | 'search'
  | 'read'
  | 'execution_start'
  | 'execution_status'
  | 'execution_pause'
  | 'execution_resume'
  | 'execution_stop';
```

New fields:

```ts
plan?: string;         // execution_start only, 1..120000 chars
title?: string;        // execution_start only, max 160 chars
mode?: 'standard' | 'infinite'; // execution_start only, default standard
execution_id?: string; // status/pause/resume/stop only
```

- [ ] **Step 1: Add failing MCP discovery test for the seven-tool ceiling**

With recording + agents enabled, assert `tools/list` still has at most seven Core tools and contains exactly one `session` schema, not a new `execution` schema.

- [ ] **Step 2: Add failing schema/action tests**

Test `execution_start` validation rejects missing plan, oversized plan, execution-only fields on search/read, and read/search-only fields on execution actions.

- [ ] **Step 3: Add failing end-to-end action tests**

Stub the browser publication seam introduced in Task 3. Assert:

- `execution_start` creates durable run first, then asks browser publication,
- browser publication failure returns an MCP error and leaves the durable run `failed`, not falsely `running`,
- status is read-only/id scoped,
- pause/resume/stop are idempotent,
- caller disconnect is irrelevant because run state is local Core state after the call returns.

- [ ] **Step 4: Register `session` unconditionally**

Change `registerCoreTools` from conditional registration to:

```ts
registerSessionSearchReadTool(reg);
```

Inside `session-tool.ts`, keep `search`/`read` guarded by `reg.sessionToolsLive`; execution actions are available whenever the Core surface itself is running.

- [ ] **Step 5: Implement `execution_start` ordering**

```ts
const run = await createExecution({ plan: input.plan!, title: input.title, mode: input.mode ?? 'standard' });
try {
  const commandId = await queueExecutionBootstrap(run.id);
  await noteExecutionCommand(run.id, commandId);
  return executionResult(executionRun(run.id)!);
} catch (error) {
  await setExecutionStatus(run.id, 'failed', friendlyError(error));
  return fail(`Desktop execution was not started: ${friendlyError(error)}`);
}
```

The result text must not say “started” until browser publication has been accepted.

- [ ] **Step 6: Implement status/pause/resume/stop**

- pause: set durable `paused`, then cancel only future autonomous sends/queued resume commands; do not close the conversation.
- resume: if already running return current state; otherwise set `starting`, queue exact-conversation resume when `conversationId` exists, then return accepted state.
- stop: persist `stopped`, retire pending execution commands, and prevent later bridge/activity state from rearming Loop.

- [ ] **Step 7: Run the MCP tests**

```bash
npx vitest run test/mcp.test.ts test/execution.test.ts
```

- [ ] **Step 8: Commit with hunk staging because `tools-core.ts` is shared WIP**

```bash
git add -p src/main/mcp/session-tool.ts src/main/mcp/tools-core.ts test/mcp.test.ts
git diff --cached -- src/main/mcp/session-tool.ts src/main/mcp/tools-core.ts test/mcp.test.ts
git commit -m "feat(core): control desktop execution through session tool"
```

---

### Task 3: Add execution commands to the durable browser bridge

**Files:**
- Modify: `src/main/bridge.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/version.ts`
- Modify: `test/bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 execution store.
- Produces:

```ts
// additions to CommandSpec
| { type: 'execution'; executionRunId: string }
| { type: 'execution-resume'; executionRunId: string; conversationId: string }
| { type: 'execution-rollover'; executionRunId: string; fromConversationId: string; reason: string };

// additions to BridgeCommand
executionRunId: string | null;
loopMode: 'standard' | 'infinite' | null;
```

Exports:

```ts
export async function queueExecutionBootstrap(executionRunId: string): Promise<string>;
export async function queueExecutionResume(executionRunId: string, conversationId: string): Promise<string>;
export async function queueExecutionRollover(executionRunId: string, fromConversationId: string, reason: string): Promise<string>;
export async function cancelExecutionCommands(executionRunId: string): Promise<void>;
```

- [ ] **Step 1: Add failing bridge tests for marker-only URL and redeem-time plan retrieval**

Assert `queueExecutionBootstrap` opens `https://chatgpt.com/?clf=<id>` with no plan fragment, and `/commands/redeem` returns the full `executionBootstrapText(runId)` only after authenticated redemption.

- [ ] **Step 2: Add failing ACK/binding test**

For a sent execution command with `conversationId='c-exec'`, assert the run becomes `running` and binds `c-exec` only after the durable command ACK path commits.

- [ ] **Step 3: Add failing resume/stop tests**

`execution-resume` targets `/c/<conversationId>?clf=<command-id>` and returns no duplicate plan text; it tells the content script to rearm the run. `cancelExecutionCommands` retires queued/leased execution commands idempotently and prevents stale ACK from rearming a stopped run.

- [ ] **Step 4: Add a failing Core-owned rollover test**

Add an authenticated bridge request:

```http
POST /execution/rollover
{
  "executionRunId": "<run>",
  "conversationId": "<current bound conversation>",
  "reason": "same-chat recovery ceiling reached"
}
```

Assert the bridge rejects a run/conversation mismatch, never accepts plan text from the browser, and queues one `execution-rollover` command for a new chat. Its wire text must be built from the durable Core plan plus a bounded last recorded assistant/progress excerpt from the run's currently bound recorded session when available.

- [ ] **Step 5: Extend `CommandSpec`, snapshot parsing, wire construction, and retirement**

When building a wire command:

- `execution`: `text = executionBootstrapText(executionRunId)`, `conversationId = null`, include run id + loop mode.
- `execution-resume`: `text = ''`, `conversationId` exact, include run id + loop mode.
- `execution-rollover`: `conversationId = null`; build English continuation framing from the durable approved plan and the app-recorded latest assistant progress excerpt. The browser never supplies the continuation prompt.

Do not persist the expanded plan in `bridge-commands`; persist only the execution run id.

- [ ] **Step 6: Implement authenticated `/execution/rollover` admission**

The route must require normal extension origin/auth/protocol checks, parse only `{ executionRunId, conversationId, reason }`, and verify the durable run is neither stopped nor failed and is currently bound to that exact conversation. It calls `queueExecutionRollover` and returns `{ ok: true, commandId }`. No request body field can replace or append to the stored approved plan.

- [ ] **Step 7: Bump bridge protocol because the wire shape changes**

Increment `BRIDGE_PROTOCOL` from 9 to 10 in `src/main/version.ts` and `extension/background.js`, update the release metadata tests, and add a version comment describing execution fields/managed routing.

- [ ] **Step 8: Restore execution runs before bridge delivery at app startup**

In `src/main/index.ts`, after `initDurableStore`/config load and before starting bridge delivery:

```ts
const savedExecutions = await readDurable<ExecutionSnapshot>(EXECUTION_STATE);
restoreExecutions(savedExecutions);
```

Do not auto-open every restored running run on startup in this task; only explicit pending bridge commands restore their existing delivery semantics.

- [ ] **Step 9: Run bridge tests**

```bash
npx vitest run test/bridge.test.ts test/execution.test.ts test/extension.test.ts
```

- [ ] **Step 10: Commit only new bridge/run hunks**

```bash
git add -p src/main/bridge.ts src/main/index.ts src/main/version.ts extension/background.js test/bridge.test.ts test/extension.test.ts
git diff --cached
git commit -m "feat(bridge): deliver autonomous execution commands"
```

---

### Task 4: Route owned tabs into managed Execution and Agent windows

**Files:**
- Modify: `extension/background.js`
- Modify: `test/extension.test.ts`

**Interfaces:**
- Produces session-scoped state:

```js
managedWindows = {
  execution: null, // Chrome window id
  agent: null      // Chrome window id
};
```

Helpers:

```js
async function routeOwnedCommandTab(tabId, commandId, commandType) {}
async function ensureManagedWindow(kind, ownedTabId) {}
```

- [ ] **Step 1: Extend the fake Chrome harness with `chrome.windows` and `chrome.tabs.move`**

Track window ids, tab membership, created windows, moves, and removal. Add failing assertions that ordinary unmarked ChatGPT tabs never move.

- [ ] **Step 2: Add failing routing tests**

- `execution`, `execution-resume`, and managed clean-rollover command tabs -> Execution Window.
- `worker` and `revive` command tabs -> Agent Window.
- first owned command creates/adopts a dedicated window from that owned tab.
- later commands move into the recorded managed window.
- stale window ids are cleared/recreated after simulated browser/window removal.

- [ ] **Step 3: Persist only browser-session window ids**

Load/store `managedWindows` in `chrome.storage.session`, never `storage.local`.

- [ ] **Step 4: Route after command ownership is proven**

In the successful command redeem path, after marker/source ownership and command identity are established but before returning the payload to the page, call:

```js
await routeOwnedCommandTab(source.tab, command.id, command.type);
```

Do not route based solely on `chatgpt.com` URL, agent-looking text, or conversation id.

- [ ] **Step 5: Keep same-chat recovery in the source execution window**

Plan 1's recovery target creation should pass the source tab's `windowId` when that source belongs to the managed Execution Window; otherwise preserve its current manual user window.

- [ ] **Step 6: Hand managed recovery-ceiling rollover back to Core**

When Plan 1's `recover_conversation_tab` reaches the consecutive-recovery ceiling and `loop.executionRunId` is present, do not create the extension-local clean-chat transfer. Instead:

1. POST `{ executionRunId, conversationId, reason }` to `/execution/rollover` using the authenticated bridge helper.
2. Store `executionRolloverSources[commandId] = { sourceTabId, sourceConversationId, executionRunId, createdAt }` in `chrome.storage.session`.
3. Return `{ ok: true, kind: 'core-rollover', commandId }` to the source document and stop its local Loop timers.
4. When the replacement `execution-rollover` command's `sent` ACK becomes durable, re-prove the old source tab still shows `sourceConversationId`, then close it and retire the source record.
5. If rollover bootstrap fails, times out, or ACK is failed, leave the old source tab open and retire only the pending source record.

This preserves the same close-after-proven-replacement rule used by same-chat recovery while keeping the continuation prompt and approved plan Core-owned.

- [ ] **Step 7: Add extension tests for Core-owned rollover source cleanup**

Assert the fourth consecutive managed stall calls the bridge rollover route, opens no extension-local root transfer, and does not close the source until the new command's durable sent ACK. A failed command leaves the source open.

- [ ] **Step 8: Run extension tests**

```bash
npx vitest run test/extension.test.ts
```

- [ ] **Step 9: Commit hunk-scoped changes**

```bash
git add -p extension/background.js test/extension.test.ts
git diff --cached -- extension/background.js test/extension.test.ts
git commit -m "feat(extension): separate execution and agent windows"
```

---

### Task 5: Bind execution bootstrap and remote pause/resume to the exact content document

**Files:**
- Modify: `extension/content.js`
- Modify: `src/main/bridge.ts`
- Modify: `test/content-script.test.ts`
- Modify: `test/bridge.test.ts`

**Interfaces:**
- `BridgeCommand.executionRunId` and `.loopMode` from Task 3.
- `/activity` adds:

```ts
execution: null | {
  id: string;
  status: 'starting' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed';
  mode: 'standard' | 'infinite';
};
```

- [ ] **Step 1: Add failing bootstrap test**

Redeem an `execution` command, send it once, bind a real conversation id, and assert content semantic state becomes `currentExecutionRunId=<id>`, Loop mode is armed, and no second kickoff prompt is injected on top of the execution plan send.

- [ ] **Step 2: Add failing pause/resume activity tests**

When activity says `paused`, content clears Loop timers/watchdog but retains execution id/mode/turn count. When later activity says `running` for the same run, it reconstructs the watchdog and schedules a continuation only if current page state is safe and idle.

- [ ] **Step 3: Project execution state in `/activity` by exact conversation**

Use `executionForConversation(conversationId)`. A stopped/failed run remains visible long enough for the content script to disarm itself; unrelated conversations receive `execution: null`.

- [ ] **Step 4: Handle `execution-resume` command separately from fresh bootstrap**

Require the exact `boot.conversationId` before doing anything. Do not insert `boot.text` because it is empty. Bind semantic execution state, ACK sent for that exact conversation, then let activity/Loop logic choose a continuation after current generation/composer/tool checks.

- [ ] **Step 5: Run focused tests**

```bash
npx vitest run test/content-script.test.ts test/bridge.test.ts
```

- [ ] **Step 6: Commit only task hunks**

```bash
git add -p extension/content.js src/main/bridge.ts test/content-script.test.ts test/bridge.test.ts
git diff --cached
git commit -m "feat(extension): bind autonomous execution to exact chats"
```

---

### Task 6: Close worker tabs only after safe sleep/terminal evidence

**Files:**
- Modify: `src/main/bridge.ts`
- Modify: `extension/content.js`
- Modify: `extension/agent-tab-lifecycle.js`
- Modify: `test/bridge.test.ts`
- Modify: `test/content-script.test.ts`
- Modify: `test/agent-tab-lifecycle.test.ts`

**Interfaces:**
- `/activity` adds for a bound worker conversation:

```ts
workerLifecycle: null | {
  agent: string;
  state: 'active' | 'sleeping' | 'finished' | 'failed';
  browserViewReleasable: boolean;
};
```

- content -> lifecycle message:

```js
{ type: 'agent_tab_releasable' }
```

- [ ] **Step 1: Reverse the current premature-close tests/behavior**

Add a regression asserting a worker tab remains open after bootstrap `sent` ACK alone. Existing WIP expectations that close immediately on bootstrap ACK must be updated to the safe-boundary contract.

- [ ] **Step 2: Project durable worker lifecycle from the app**

For exact bound worker conversations, set `browserViewReleasable=true` only when broker state is `sleeping`, `finished`, or `failed` after its durable transition. Do not infer from tab hidden state or missing heartbeat.

- [ ] **Step 3: Request close from the content document only on releasable state**

The content script sends `agent_tab_releasable` once per worker activation when activity proves releasable. Remove the direct `close_agent_tab` calls immediately after bootstrap ACK and the unconditional turn-end close path.

- [ ] **Step 4: Make lifecycle ownership the destructive-close fence**

`agent-tab-lifecycle.js` accepts `agent_tab_releasable` only from a tab with an existing lease created from a proven command marker. Immediately before `chrome.tabs.remove`, call `stillOwnsLease(lease)`; if the tab navigated outside ChatGPT or no longer proves the lease, release the lease without closing.

Rename semantic fields so bootstrap durability and close eligibility are not conflated, for example:

```js
lease.bootstrapSent = true;
lease.releasable = true;
```

`commandAckOutbox` may set `bootstrapSent`; it must not set `releasable`.

- [ ] **Step 5: Keep queue/budget drain behavior after safe close**

Successful close deletes the lease, persists telemetry, and drains the queued worker-tab commands. Failed ownership proof releases stale lease and also drains queue without destructive close.

- [ ] **Step 6: Run worker lifecycle cluster**

```bash
npx vitest run test/agent-tab-lifecycle.test.ts test/agent-tab-budget.test.ts test/content-script.test.ts test/bridge.test.ts
```

- [ ] **Step 7: Commit hunk-scoped worker cleanup**

```bash
git add -p src/main/bridge.ts extension/content.js extension/agent-tab-lifecycle.js test/bridge.test.ts test/content-script.test.ts test/agent-tab-lifecycle.test.ts test/agent-tab-budget.test.ts
git diff --cached
git commit -m "fix(agents): close worker tabs at durable sleep boundaries"
```

---

### Task 7: Remote-execution verification gate

**Files:**
- No production files unless a failing test exposes a regression.

**Interfaces:**
- Produces stable execution/window/worker primitives required by Plan 3.

- [ ] **Step 1: Run the execution/bridge/extension cluster**

```bash
npx vitest run test/execution.test.ts test/mcp.test.ts test/bridge.test.ts test/extension.test.ts test/content-script.test.ts test/agent-tab-lifecycle.test.ts test/agent-tab-budget.test.ts
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Verify seven-tool discovery contract**

Run the specific MCP surface/discovery tests and inspect the emitted Core tool names. There must be no eighth execution tool.

- [ ] **Step 4: Patch hygiene**

```bash
git diff --check
```

- [ ] **Step 5: Manual local smoke with a disposable test plan**

From an authenticated non-desktop ChatGPT surface, call `session action=execution_start` with a harmless plan that only reads repository status. Verify: Core persists run, Chrome opens a new managed Execution Window/chat, plan sends once, Loop arms, and the initiating chat can disappear without stopping the desktop run.

- [ ] **Step 6: Manual worker-window smoke**

From the execution chat, spawn workers. Verify worker tabs enter Agent Window, remain present while active, and close after durable sleep/finish while the Execution Window remains untouched.
