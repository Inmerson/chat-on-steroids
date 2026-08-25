# v2 Antigravity Goal Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the custom v2 line where ChatGPT Prime can use a bounded Antigravity Fast Investigator and where every normal manual user message becomes a durable unattended goal continued by Antigravity Gemini 3.7 Flash Low until `NO_REPLY`, an explicit stop command, or the 32-auto-turn guard.

**Architecture:** Keep upstream v2.0.0 as the authority for sessions, Compact & Resume, browser settle detection, workers, unified exec, desktop safety, privacy and packaging. Add one shared bounded `agy` runtime, a read-only investigator surface, and a session-scoped goal controller that replaces OpenRouter while preserving the existing one-draft/one-browser ownership protocol. Goal identity is the durable session id plus revision; browser provenance marks manual, goal-generated and bootstrap user messages explicitly so asynchronous results can be fenced without guessing from text.

**Tech Stack:** Electron, TypeScript, Node.js child processes, Chrome MV3 extension JavaScript, Zod, Vitest, Google Antigravity `agy` CLI 1.1.x, PowerShell/Windows process-tree semantics.

**Spec:** `docs/superpowers/specs/2026-08-25-v2-antigravity-goal-design.md`

## Global Constraints

- Base is upstream Chat On Steroids v2.0.0/current `origin/main`; do not merge or rebase the rewritten v1 custom history.
- Use the already-authenticated Antigravity CLI session only; no Gemini API key, OpenRouter request, paid fallback, or Hermes.
- Fixed initial model is exactly `gemini-3.7-flash-low` with low effort.
- Fast Investigator is read-only advisory; ChatGPT Prime still owns mutation, tests, security conclusions, release and deploy decisions.
- Goal Driver receives only manual user-authored messages, final assistant answers and the active-goal instruction; never tool calls/results, file contents, local paths, environment values, browser evidence or secrets.
- Goal Driver runs from app-owned scratch space, never a project workspace.
- Goal never runs in worker chats.
- Existing configured automatic-compaction threshold is authoritative; no second context threshold is added.
- Compact & Resume wins over ordinary Goal continuation and retains the same durable session + goal revision.
- A normal manual message creates/replaces the active goal; `goalı durdur`, `goal durdur`, `stop goal`, and `otomatik devamı kapat` stop it deterministically without invoking Antigravity.
- Maximum 32 consecutive generated user messages per goal revision; reaching the cap pauses until another manual message creates a new revision.
- Every asynchronous Goal result is fenced by session id, goal revision, conversation/navigation ownership and draft token before it can be typed.
- `npm run verify:privacy` is mandatory before every commit and push; never bypass hooks.
- Preserve the upstream dirty-tree rule: never reset, clean, overwrite or reformat unrelated work.

---

## File Structure

**New focused modules**

- `src/main/antigravity/runtime.ts` — locate `agy`, build a scrubbed child environment, launch/kill bounded stream-json runs, parse actual tool events, sanitize paths, and expose one test runner seam.
- `src/main/antigravity/investigator.ts` — investigator-only prompt, project registration/reuse, hard tool-call budget and advisory evidence projection.
- `src/main/antigravity/goal-driver.ts` — scratch-cwd Goal prompt and strict `message | no-reply` output contract; rejects any tool call.
- `src/main/delegation-router.ts` — pure deterministic decision for `agents action=investigate`.
- `src/main/goal-state.ts` — durable session-scoped active goal/revision/status/runaway state, deterministic stop recognizer, revision fences and restore/snapshot API.

**Existing modules changed**

- `src/shared/session.ts` — add explicit user-message provenance (`manual | goal | bootstrap`) to the recorded user-message event/observation contract.
- `src/main/session/recorder.ts` — carry validated provenance into stored `user_message` events; no inference from text.
- `src/main/bridge.ts` — validate provenance, update goal state after `/events`, remove Goal API-key gate, fence drafts against active goal + continuation ownership, expose provider/model/status in `/activity`.
- `src/main/goal.ts` — retain one-draft-per-turn/client ownership and ACK tombstones, but replace OpenRouter transport with `goal-driver.ts`; attach `sessionId` + `revision` to drafts and filter transcript to manual-authored user rows + final assistant rows.
- `src/main/mcp/tools-core.ts`, `src/main/mcp/instructions.ts`, `docs/tool-surface.md` — add `agents action=investigate` without altering upstream spawn/message/status/finish semantics.
- `src/main/index.ts` — restore goal-state snapshot after durable store initialization.
- `src/shared/types.ts`, `src/main/config.ts`, `src/main/secrets.ts` — reduce Goal config to the master enable switch; remove Goal-only OpenRouter model/reasoning/key requirements.
- `extension/content.js` — mark generated/bootstrap provenance, recognize the Goal state returned by the app, preserve the settle barrier, enforce last-moment stale/compaction checks and auto-send exactly once.
- `extension/background.js` — forward provenance and existing `clientId` ownership unchanged; retain journal-before-draft ordering.
- `extension/chatgpt-dom.js` — return the accepted generated user message identity when available so provenance can bind to the actual page message rather than text.
- `extension/overlay.css`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/styles.css` — remove OpenRouter picker/key copy and show `Antigravity · Gemini 3.7 Flash Low` plus goal status.

---

### Task 1: Shared bounded Antigravity CLI runtime

**Files:**
- Create: `src/main/antigravity/runtime.ts`
- Create: `test/antigravity-runtime.test.ts`
- Reference only: previous custom `src/main/antigravity-worker.ts` from commit `9ff7294`; copy behavior deliberately, not history.

**Interfaces:**
- Produces:
  ```ts
  export const ANTIGRAVITY_MODEL = 'gemini-3.7-flash-low';
  export interface AntigravityRunRequest {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    hardToolCalls: number;
    allowPartial: boolean;
    projectId?: string | null;
    newProject?: boolean;
  }
  export interface AntigravityRunResult {
    finalText: string;
    observedFiles: string[];
    toolErrors: string[];
    toolCalls: number;
    conversationId: string | null;
    durationSeconds: number | null;
    totalTokens: number | null;
    partial: boolean;
    budgetExceeded: boolean;
  }
  export async function runAntigravity(request: AntigravityRunRequest): Promise<AntigravityRunResult>;
  export function setAntigravityProcessRunnerForTests(
    runner: ((request: AntigravityRunRequest) => Promise<AntigravityRunResult>) | null
  ): void;
  ```

- [ ] **Step 1: Write failing runtime contract tests**

Create tests that assert fixed args, timeout termination, stream parsing, bounded output and no paid provider environment injection. The core assertions must include:

```ts
expect(args).toContain('--model');
expect(args).toContain('gemini-3.7-flash-low');
expect(args).toContain('--effort');
expect(args).toContain('low');
expect(args).toContain('--mode');
expect(args).toContain('plan');
expect(args).toContain('--sandbox');
expect(args).toContain('--output-format');
expect(args).toContain('stream-json');
expect(args).not.toContain('--dangerously-skip-permissions');
expect(childEnv.GEMINI_API_KEY).toBeUndefined();
expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
```

Also model a stream with nine tool-start events under `hardToolCalls: 8` and assert `budgetExceeded === true`, `partial === true`, and the process tree is terminated before a ninth tool can complete.

- [ ] **Step 2: Run the new test file and confirm RED**

Run:

```powershell
npx vitest run test/antigravity-runtime.test.ts
```

Expected: FAIL because `src/main/antigravity/runtime.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared runner**

Implement the command line with this fixed base:

```ts
const args = [
  '-p', request.prompt,
  '--model', ANTIGRAVITY_MODEL,
  '--effort', 'low',
  '--mode', 'plan',
  '--sandbox',
  '--output-format', 'stream-json',
  '--print-timeout', `${Math.ceil(request.timeoutMs / 1000)}s`
];
```

Add `--project <id>` when supplied, otherwise `--new-project` only when requested. Locate `agy.exe` from the known per-user install layout and PATH with a bounded candidate list. Prepend Git `usr\bin` only when its `grep.exe` exists. Strip provider API-key variables from the explicit child environment; do not modify the user's global environment. Bound stdout/stderr to 64 KiB each and returned final text to 16 KiB. Count real stream-json tool-start events, sanitize absolute host paths in model-facing errors/evidence, and kill the process tree on timeout/budget overflow.

- [ ] **Step 4: Run runtime tests until GREEN**

Run:

```powershell
npx vitest run test/antigravity-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run privacy gate and commit Task 1**

```powershell
npm run verify:privacy
git diff --check
git add src/main/antigravity/runtime.ts test/antigravity-runtime.test.ts
git commit -m "feat(antigravity): add bounded CLI runtime"
```

---

### Task 2: Fast Investigator and deterministic Delegation Router

**Files:**
- Create: `src/main/antigravity/investigator.ts`
- Create: `src/main/delegation-router.ts`
- Create: `test/antigravity-investigator.test.ts`
- Create: `test/delegation-router.test.ts`
- Modify: `src/main/mcp/tools-core.ts:873-1140`
- Modify: `src/main/mcp/instructions.ts`
- Modify: `test/mcp.test.ts`
- Modify: `test/agents.test.ts`
- Modify: `docs/tool-surface.md`

**Interfaces:**
- Consumes: `runAntigravity()` and `ANTIGRAVITY_MODEL` from Task 1.
- Produces:
  ```ts
  export interface DelegationDecision {
    delegated: boolean;
    score: number;
    reasons: string[];
    hardBlocked: boolean;
  }
  export function routeAntigravityInvestigation(task: string): DelegationDecision;

  export interface AntigravityInvestigation {
    report: string;
    observedFiles: string[];
    toolErrors: string[];
    toolCalls: number;
    conversationId: string | null;
    durationSeconds: number | null;
    totalTokens: number | null;
    partial: boolean;
    budgetExceeded: boolean;
  }
  export async function investigateWithAntigravity(input: { task: string; cwd: string }): Promise<AntigravityInvestigation>;
  export function setAntigravityInvestigatorForTests(
    investigator: ((input: { task: string; cwd: string }) => Promise<AntigravityInvestigation>) | null
  ): void;
  ```

- [ ] **Step 1: Add RED router unit tests**

The five mandatory cases are:

```ts
expect(routeAntigravityInvestigation('Trace why MCP state becomes stale across multiple files.').delegated).toBe(true);
expect(routeAntigravityInvestigation('Read the npm package name from package.json.').delegated).toBe(false);
expect(routeAntigravityInvestigation('Implement the fix across src/main.').hardBlocked).toBe(true);
expect(routeAntigravityInvestigation('Investigate why the release build fails across the execution path.').delegated).toBe(true);
expect(routeAntigravityInvestigation('Run final verification and deploy it.').hardBlocked).toBe(true);
```

Use the approved v1 scoring design: threshold 3, mutation/final-gate hard block, trivial exact lookup penalty, and noun-only `release build` must not be misclassified as a release action.

- [ ] **Step 2: Add RED MCP integration tests**

Extend the existing `agents` schema to expect `investigate`, `task?: string`, and `workdir?: string`. Add three tests: broad root-cause delegates, trivial lookup returns `delegated:false` with zero fake-investigator calls, mutation/final verification returns `delegated:false` with zero fake-investigator calls.

- [ ] **Step 3: Run focused tests and confirm RED**

```powershell
npx vitest run test/delegation-router.test.ts test/antigravity-investigator.test.ts test/mcp.test.ts test/agents.test.ts
```

Expected: router modules/action missing.

- [ ] **Step 4: Implement router and investigator**

Investigator calls:

```ts
await runAntigravity({
  prompt: investigatorPrompt(task),
  cwd,
  timeoutMs: 45_000,
  hardToolCalls: 8,
  allowPartial: true,
  projectId: await findAntigravityProjectId(cwd),
  newProject: !(await findAntigravityProjectId(cwd))
});
```

Keep the soft prompt target at six tool calls. Derive observed files only from actual tool event params. The result heading must state that it is advisory and Prime must independently verify.

In `registerAgentsTool`, add `investigate` without changing existing branches. Route before workspace resolution or child-process launch. Non-delegated requests return normal MCP success with:

```ts
structuredContent: {
  action: 'investigate',
  provider: 'antigravity',
  delegated: false,
  router_score: decision.score,
  router_reasons: decision.reasons
}
```

Delegated results include the same router fields plus model/workdir/duration/tokens/files/errors/tool_calls/report.

- [ ] **Step 5: Update instructions/tool-surface documentation**

Document that `investigate` is for broad read-only root-cause/cross-file reconnaissance, is deterministically declined for trivial/mutation/final-verification work, and is never a final verification gate.

- [ ] **Step 6: Run focused tests until GREEN, then commit**

```powershell
npx vitest run test/delegation-router.test.ts test/antigravity-investigator.test.ts test/mcp.test.ts test/agents.test.ts
npm run verify:privacy
git diff --check
git add src/main/antigravity/investigator.ts src/main/delegation-router.ts src/main/mcp/tools-core.ts src/main/mcp/instructions.ts docs/tool-surface.md test/antigravity-investigator.test.ts test/delegation-router.test.ts test/mcp.test.ts test/agents.test.ts
git commit -m "feat(agents): add Antigravity fast investigator"
```

---

### Task 3: Durable session goal state and explicit message provenance

**Files:**
- Create: `src/main/goal-state.ts`
- Create: `test/goal-state.test.ts`
- Modify: `src/shared/session.ts`
- Modify: `src/main/session/recorder.ts:1273-1300,1374+`
- Modify: `src/main/bridge.ts` observation validation and `/events` handlers
- Modify: `src/main/index.ts`
- Modify: `test/session.test.ts`
- Modify: `test/bridge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GoalStatus = 'active' | 'stopped' | 'complete' | 'failed';
  export type UserMessageProvenance = 'manual' | 'goal' | 'bootstrap';
  export interface ActiveGoalState {
    sessionId: string;
    revision: number;
    status: GoalStatus;
    text: string;
    sourceMessageId: string;
    updatedAt: number;
    consecutiveAutoTurns: number;
  }
  export const GOALS_STATE = 'goals';
  export function isGoalStopCommand(text: string): boolean;
  export function goalForSession(sessionId: string): ActiveGoalState | null;
  export function noteManualGoal(sessionId: string, text: string, messageId: string): ActiveGoalState;
  export function noteGoalStop(sessionId: string, messageId: string): ActiveGoalState | null;
  export function markGoalComplete(sessionId: string, revision: number): boolean;
  export function markGoalFailed(sessionId: string, revision: number): boolean;
  export function noteGoalAutoTurn(sessionId: string, revision: number): ActiveGoalState | null;
  export function goalRevisionMatches(sessionId: string, revision: number): boolean;
  export function snapshotGoalStates(): { version: 1; goals: ActiveGoalState[] };
  export function restoreGoalStates(snapshot: unknown): void;
  export function resetGoalStatesForTests(): void;
  ```

- [ ] **Step 1: Add RED state-machine tests**

Cover all of these transitions explicitly:

```ts
const one = noteManualGoal('s1', 'build it', 'm1');
expect(one).toMatchObject({ revision: 1, status: 'active', text: 'build it', consecutiveAutoTurns: 0 });
const two = noteManualGoal('s1', 'also run tests', 'm2');
expect(two.revision).toBe(2);
expect(isGoalStopCommand('goalı durdur')).toBe(true);
expect(isGoalStopCommand('otomatik devamı kapat')).toBe(true);
expect(isGoalStopCommand('investigate why goal stopped')).toBe(false);
```

Assert generated/bootstrap provenance never calls `noteManualGoal`, stop does not invoke a provider seam, a manual message after stop produces `revision + 1` and `active`, 32 `noteGoalAutoTurn` calls cause `status:'stopped'`, and restore never restores draft/send authority because only `ActiveGoalState` is serialized.

- [ ] **Step 2: Add RED provenance tests to bridge/recorder**

A valid user observation is now:

```ts
{
  kind: 'user_message',
  time: Date.now(),
  text: 'do the work',
  messageId: 'm-1',
  provenance: 'manual'
}
```

Reject unknown provenance values at the bridge. After `recordChatObservations` returns its durable `sessionId`, process only newly stored `user_message` observations with `provenance:'manual'`: stop command stops; otherwise update goal. `goal` and `bootstrap` provenance are recorded but do not update goal.

- [ ] **Step 3: Run focused tests and confirm RED**

```powershell
npx vitest run test/goal-state.test.ts test/bridge.test.ts test/session.test.ts
```

- [ ] **Step 4: Implement state persistence**

Use the existing durable store:

```ts
writeDurableSoon(GOALS_STATE, snapshotGoalStates());
```

Bound the snapshot to at most 256 session rows, preserving all active rows first and then newest inactive rows. Restore only rows that pass exact shape/length/status/revision validation. Do not serialize drafts, browser client ids or ACK tokens.

In startup, after `initDurableStore(...)`, restore with:

```ts
restoreGoalStates(await readDurable(GOALS_STATE));
```

- [ ] **Step 5: Carry provenance through the session event type**

Add to the stored `user_message` event and `ChatObservation`:

```ts
provenance?: 'manual' | 'goal' | 'bootstrap';
```

For new extension events the field is mandatory at bridge validation. Legacy stored rows may omit it so old recordings still load; Goal transcript logic later treats omitted provenance as legacy context only, never as authority to create/update active goal state.

- [ ] **Step 6: Run tests until GREEN, privacy gate and commit**

```powershell
npx vitest run test/goal-state.test.ts test/bridge.test.ts test/session.test.ts
npm run verify:privacy
git diff --check
git add src/main/goal-state.ts src/shared/session.ts src/main/session/recorder.ts src/main/bridge.ts src/main/index.ts test/goal-state.test.ts test/bridge.test.ts test/session.test.ts
git commit -m "feat(goal): add durable session goal state"
```

---

### Task 4: Replace OpenRouter with the Antigravity Goal Driver

**Files:**
- Create: `src/main/antigravity/goal-driver.ts`
- Create: `test/antigravity-goal-driver.test.ts`
- Modify: `src/main/goal.ts`
- Modify: `test/goal.test.ts`

**Interfaces:**
- Consumes: `runAntigravity`, `ANTIGRAVITY_MODEL`, and goal-state APIs.
- Produces:
  ```ts
  export type GoalDriverResult =
    | { kind: 'no-reply'; raw: 'NO_REPLY' }
    | { kind: 'message'; text: string };

  export async function draftGoalWithAntigravity(input: {
    goal: string;
    messages: readonly { role: 'user' | 'assistant'; content: string }[];
  }): Promise<GoalDriverResult>;

  export function setGoalDriverForTests(
    driver: ((input: { goal: string; messages: readonly { role: 'user' | 'assistant'; content: string }[] }) => Promise<GoalDriverResult>) | null
  ): void;
  ```

- [ ] **Step 1: Add RED Goal Driver tests**

Use a temporary app-owned empty directory and fake runtime. Assert:

```ts
expect(request.cwd).not.toContain('project');
expect(request.hardToolCalls).toBe(0);
expect(request.timeoutMs).toBeLessThan(180_000);
```

Valid outputs are exact `NO_REPLY` or one trimmed message at most 4,000 characters. Reject empty output, >4,000 chars, multiple protocol records, and any runtime result with `toolCalls > 0` or `toolErrors.length > 0`.

The system instruction must include the active goal explicitly and say the output is only the next user message or exact `NO_REPLY`.

- [ ] **Step 2: Rewrite Goal tests from fetch/OpenRouter to driver seam**

Replace fetch mocking with:

```ts
setGoalDriverForTests(async ({ goal, messages }) => {
  expect(goal).toBe('build the parser');
  expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
  return { kind: 'message', text: 'run the parser tests next' };
});
```

Keep the existing one-draft-per-turn, client ownership, spent-token TTL/tombstone and ACK tests.

- [ ] **Step 3: Make transcript filtering RED**

Add a session containing:

```ts
manual user -> final assistant -> goal-generated user -> final assistant -> bootstrap user
```

and assert the Goal Driver receives only the manual user row(s) plus final assistant rows. Tool calls, interim assistant snapshots, goal-generated and bootstrap user rows are absent.

- [ ] **Step 4: Implement `goal-driver.ts` and refactor `goal.ts`**

`GoalDraft` gains:

```ts
revision: number;
```

`StartGoalDraftInput` gains `revision`. Before and after each awaited provider step, require:

```ts
goalRevisionMatches(draft.sessionId, draft.revision)
```

On `no-reply`, call `markGoalComplete(sessionId, revision)` before settling `no-reply`. On provider/protocol failure call `markGoalFailed(sessionId, revision)` and settle `failed`. Do not reintroduce any API key check.

`conversationMessages(sessionId)` must include user rows only when `event.provenance === 'manual'` or when reading a legacy row for context compatibility; legacy rows may inform the model only if the current active goal text is separately supplied and they must never update goal state.

- [ ] **Step 5: Remove dead OpenRouter transport code from `goal.ts`**

Delete provider catalogue, SSE parser, OpenRouter request headers, model cache and API-key lookup from the live Goal path. Keep only the draft lifecycle and bounded transcript projection. `goalSettings()` becomes a static provider projection:

```ts
return {
  enabled: getConfig().goal.enabled,
  provider: 'antigravity',
  model: ANTIGRAVITY_MODEL
};
```

- [ ] **Step 6: Run focused Goal tests, privacy gate and commit**

```powershell
npx vitest run test/antigravity-goal-driver.test.ts test/goal.test.ts
npm run verify:privacy
git diff --check
git add src/main/antigravity/goal-driver.ts src/main/goal.ts test/antigravity-goal-driver.test.ts test/goal.test.ts
git commit -m "feat(goal): drive continuation with Antigravity"
```

---

### Task 5: Browser provenance, automatic goal updates, stop commands, and exactly-once generated sends

**Files:**
- Modify: `extension/chatgpt-dom.js:1282-1363`
- Modify: `extension/content.js:1311-1330,6240-6443`
- Modify: `extension/background.js:1738-1783` and journal event forwarding
- Modify: `test/content-script.test.ts`
- Modify: `test/extension.test.ts`
- Modify: `test/bridge.test.ts`

**Interfaces:**
- `CLF_DOM.send()` changes from `Promise<boolean>` to:
  ```js
  Promise<{ sent: boolean, messageId: string | null }>
  ```
- Goal ACK adds send provenance only after the browser crossed the irreversible send boundary:
  ```js
  { type: 'goal_ack', conversationId, token, sentMessageId }
  ```

- [ ] **Step 1: Add RED DOM-send identity tests**

When a fresh user message node appears after clicking Send, assert:

```js
expect(await CLF_DOM.send()).toEqual({ sent: true, messageId: 'user-msg-42' });
```

If acceptance is proven only by composer/generation transition before a message id appears, return `{ sent: true, messageId: null }`; do not invent an id from text.

- [ ] **Step 2: Add RED provenance tests in content script**

Manual page-authored message:

```js
expect(emittedUser.event.provenance).toBe('manual');
```

A Goal-generated send must bind the observed generated message id to `provenance:'goal'`. A replacement-chat bootstrap identified by existing `openedBy === 'resume'`/app command identity is `provenance:'bootstrap'`. Worker bootstrap is also `bootstrap` for recording but worker exclusion means it cannot start Goal.

No test may infer provenance solely by comparing message text.

- [ ] **Step 3: Preserve the irreversible-boundary ordering**

The send flow becomes:

```js
const sent = await CLF_DOM.send();
if (!sent.sent) {
  await ask({ type: 'goal_ack', conversationId, token: draft.token });
  // expose failure
  return;
}
rememberGoalSpent(conversationId, draft.token);
if (sent.messageId) rememberGoalGeneratedMessage(sent.messageId, epoch);
await flushNow(); // journal the generated user row when it is observable
await ask({ type: 'goal_ack', conversationId, token: draft.token, sentMessageId: sent.messageId });
```

If `messageId` is not immediately available, retain a bounded same-epoch pending generated-send fence. The first *new page user message identity* observed as a direct consequence of this app-owned send receives Goal provenance; expire the fence on navigation/epoch change. Do not match by text.

- [ ] **Step 4: Add stop-command integration test**

Record a manual `goalı durdur` event, then complete a ChatGPT turn. Assert `/goal/draft` returns a stopped/no-active-goal response and the Antigravity Goal Driver fake has zero calls. Record a later manual normal message and assert drafting becomes allowed under a newer revision.

- [ ] **Step 5: Run browser-focused tests until GREEN and commit**

```powershell
npx vitest run test/content-script.test.ts test/extension.test.ts test/bridge.test.ts
npm run verify:privacy
git diff --check
git add extension/chatgpt-dom.js extension/content.js extension/background.js test/content-script.test.ts test/extension.test.ts test/bridge.test.ts
git commit -m "feat(goal): track browser message provenance"
```

---

### Task 6: Revision fences, Compact & Resume ownership, and 32-turn guard

**Files:**
- Modify: `src/main/goal.ts`
- Modify: `src/main/bridge.ts:1439-1496`
- Modify: `src/main/session/continuation.ts` only if a narrower read-only helper is required; prefer existing `continuationForSession(sessionId)`.
- Modify: `extension/content.js:6269-6443`
- Modify: `test/goal.test.ts`
- Modify: `test/bridge.test.ts`
- Modify: `test/continuation.test.ts`
- Modify: `test/content-script.test.ts`

**Interfaces:**
- `/goal/draft` resolves the current session goal first and passes its exact revision:
  ```ts
  const active = goalForSession(sessionId);
  if (!active || active.status !== 'active') return json(res, 409, { error: 'goal_inactive' }, origin);
  if (continuationForSession(sessionId)) return json(res, 409, { error: 'compaction_active' }, origin);
  const draft = startGoalDraft({ sessionId, conversationId: id, turnId, clientId, revision: active.revision });
  ```

- [ ] **Step 1: Add RED stale-revision race test**

Start draft for revision N with a deferred fake Goal Driver. Before resolving it, call `noteManualGoal` to create N+1. Resolve N and assert `goalViewFor` never exposes a ready reply and no auto-turn count increments.

- [ ] **Step 2: Add RED compaction-wins race test**

Start a draft, make it ready, then open/arm a continuation for the same session before browser send. Assert the app no longer exposes a sendable reply and content script ACKs/discards rather than typing it.

- [ ] **Step 3: Add RED conversation-rebind test**

Move the same session from conversation A to B through the real continuation helpers. Assert `goalForSession(sessionId)` retains the same `revision`, `text`, `status:'active'`, and `consecutiveAutoTurns`; a stale A draft cannot be typed in B. After B finishes a later turn, `/goal/draft` may start a new draft for the same session/revision.

- [ ] **Step 4: Add RED 32-turn cap test**

For one revision, ACK 32 successfully sent Goal messages. The 32nd transition must leave the state stopped/paused and the 33rd `/goal/draft` must refuse without calling Goal Driver. A manual message creates revision N+1 with count zero.

- [ ] **Step 5: Implement last-moment fences**

Before `goalViewFor` returns a ready reply, require all of:

```ts
goalRevisionMatches(draft.sessionId, draft.revision)
continuationForSession(draft.sessionId) === null
```

Before content script calls `CLF_DOM.insertPrompt`, re-pull activity/goal state if its local snapshot is older than the ready draft poll and reject if the conversation epoch changed, the chat became worker, or compact capture/native job became active.

Increment `consecutiveAutoTurns` only after the browser reports a successful generated send ACK. Lost ACK retry must not increment twice: key the increment to the draft token in the existing spent-draft tombstone path.

- [ ] **Step 6: Run race/boundary tests until GREEN and commit**

```powershell
npx vitest run test/goal.test.ts test/bridge.test.ts test/continuation.test.ts test/content-script.test.ts
npm run verify:privacy
git diff --check
git add src/main/goal.ts src/main/bridge.ts src/main/session/continuation.ts extension/content.js test/goal.test.ts test/bridge.test.ts test/continuation.test.ts test/content-script.test.ts
git commit -m "fix(goal): fence unattended continuation races"
```

If `src/main/session/continuation.ts` did not need a source edit, omit it from `git add`.

---

### Task 7: Remove OpenRouter Goal UI/config and expose Antigravity status

**Files:**
- Modify: `src/shared/types.ts:148-168`
- Modify: `src/main/config.ts:262-286`
- Modify: `src/main/secrets.ts`
- Modify: `src/main/bridge.ts` activity/settings responses
- Modify: `src/preload/index.ts` only if renderer API types carry removed Goal fields
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/styles.css`
- Modify: `extension/content.js` Goal settings panel copy
- Modify: `extension/overlay.css`
- Modify: `test/config.test.ts`
- Modify: `test/renderer-state.test.ts`
- Modify: `test/renderer-layout.test.ts`
- Modify: `test/content-script.test.ts`
- Modify: `test/bridge.test.ts`

**Interfaces:**
- `GoalSettings` becomes:
  ```ts
  export interface GoalSettings {
    enabled: boolean;
  }
  ```
- Activity projection becomes:
  ```ts
  goal: {
    enabled: boolean;
    provider: 'antigravity';
    model: 'gemini-3.7-flash-low';
    state: ActiveGoalState | null;
    draft: GoalDraftView | null;
  }
  ```

- [ ] **Step 1: Add RED config migration tests**

A v2 config containing old OpenRouter fields still loads roots/permissions and preserves `goal.enabled`, while `model`/`reasoning` are ignored on save. Fresh custom config has Goal enabled for this deployment if that is the intended local default; otherwise explicitly set the user's installed config during deployment rather than widening generic upstream defaults. The test must make that choice explicit, not accidental.

- [ ] **Step 2: Add RED UI tests**

Assert no renderer/extension copy references `OpenRouter`, `API key`, model catalogue, reasoning picker, or `Load 20 more`. Assert visible copy includes `Antigravity` and `Gemini 3.7 Flash Low`, and the master Goal switch remains.

- [ ] **Step 3: Remove dead Goal-only OpenRouter code**

Remove Goal model/reasoning controls and key requirement from renderer, content-script settings sheet and bridge settings response. If `openRouterApiKey` is not used by any other live feature after Task 4, remove its secret UI/actions and secret-store key definition; retain migration tolerance so an old encrypted value can remain harmlessly unread until userData cleanup rather than breaking startup.

- [ ] **Step 4: Render session-local state**

Show compact status such as:

```text
Antigravity · Gemini 3.7 Flash Low
Goal active · <short goal text>
Goal stopped
Goal complete
Goal failed · <bounded error>
```

Do not expose full historical transcript or provider diagnostics in the composer panel.

- [ ] **Step 5: Run UI/config tests until GREEN and commit**

```powershell
npx vitest run test/config.test.ts test/renderer-state.test.ts test/renderer-layout.test.ts test/content-script.test.ts test/bridge.test.ts
npm run verify:privacy
git diff --check
git add src/shared/types.ts src/main/config.ts src/main/secrets.ts src/main/bridge.ts src/preload/index.ts src/renderer/index.html src/renderer/main.ts src/renderer/styles.css extension/content.js extension/overlay.css test/config.test.ts test/renderer-state.test.ts test/renderer-layout.test.ts test/content-script.test.ts test/bridge.test.ts
git commit -m "refactor(goal): remove OpenRouter dependency"
```

Omit files from `git add` when inspection proves no source edit was needed.

---

### Task 8: Full integration, packaging, install, and live smoke

**Files:**
- Modify as required by failing verification only; no opportunistic refactors.
- Update: `docs/superpowers/specs/2026-08-25-v2-antigravity-goal-design.md` status to implemented after all gates pass.
- Update: `CHANGELOG.md` or custom release notes only if this branch is being prepared for a tagged release in the same task.

**Interfaces:**
- End-to-end chain:
  ```text
  manual goal
    -> durable session goal revision
    -> ChatGPT Prime
    -> optional agents/investigate -> Antigravity Fast Investigator
    -> final assistant answer settles
    -> /goal/draft(session, revision, turn, client)
    -> Antigravity Goal Driver
    -> ready message | NO_REPLY
    -> browser exactly-once auto-send + ACK
    -> repeat
    -> Compact & Resume keeps same session/revision when threshold fires
  ```

- [ ] **Step 1: Run the complete source gate**

```powershell
npm run verify
npm run build
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
git diff --check
npm run verify:privacy
```

Expected: zero failing tests, zero TypeScript errors, successful production build, no high/critical audit issue, no whitespace errors, privacy gate green.

- [ ] **Step 2: Verify public MCP schema and docs stay synchronized**

Run the exact MCP/surface tests and inspect `docs/tool-surface.md`. Expected Core `agents` action enum includes `investigate`; Core/Desktop surface count remains bounded and no new permanent top-level tool was added for Goal.

- [ ] **Step 3: Build x64 candidate and run packaged runtime smoke**

Use the repository's current v2 packaging command from `package.json`/`electron-builder.yml`, then:

```powershell
node scripts/smoke-packaged-runtime.mjs release\win-unpacked
```

Expected: packaged Electron/native runtime smoke passes and shipped extension/app versions match.

- [ ] **Step 4: Install candidate and verify installed resources**

Install with the existing hidden updater flow; do not show a window unless user interaction is required. Verify installed `app.asar`, extension folder, tunnel binary, ripgrep resource and node-pty runtime. Hash release and installed `app.asar` and require equality.

- [ ] **Step 5: Live Fast Investigator smoke**

Against installed local MCP, run:

1. `Read the npm package name from package.json.` -> `delegated:false`, zero `agy` launch.
2. A broad root-cause/cross-file task -> `delegated:true`, model `gemini-3.7-flash-low`, advisory evidence returned within bounds.

Never print connector bearer tokens.

- [ ] **Step 6: Live Goal smoke**

In a new normal ChatGPT conversation with the current extension:

1. Send one manual task.
2. Let Prime finish.
3. Confirm settle barrier -> Antigravity Goal Driver -> one automatic next message.
4. Confirm that generated message did not replace the active goal revision.
5. Send `goalı durdur`; confirm no next automatic message is generated.
6. Send a new manual message; confirm it becomes a newer active revision and automatic continuation resumes.
7. Exercise `NO_REPLY`; confirm no composer send.

- [ ] **Step 7: Live Compact & Resume smoke**

Use a safe temporary low auto-compaction threshold supported by config tests or a controlled test fixture. Confirm the same durable session id + goal revision moves to the replacement conversation and Goal resumes there without treating the bootstrap as a new goal. Restore the user's actual threshold after the smoke.

- [ ] **Step 8: Mark spec implemented, final privacy gate, commit**

```powershell
npm run verify:privacy
git diff --check
git add docs/superpowers/specs/2026-08-25-v2-antigravity-goal-design.md
git commit -m "docs: mark v2 Antigravity goal complete"
```

Only after all gates are green should the branch be pushed. Do not merge to upstream `origin/main` automatically; push to the authorized custom remote/branch and report the exact commit/hash and any remaining unrelated work separately.
