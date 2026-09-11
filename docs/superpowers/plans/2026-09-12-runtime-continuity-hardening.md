# Runtime Continuity Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent false loop termination and make long-context rollover continue in one fresh ChatGPT conversation using a durable, clipboard-backed executable handoff.

**Architecture:** Add a small Core-owned completion-evidence evaluator so model `stop` output becomes only a candidate terminal decision. Integrate it into Goal Mode using exact session/conversation evidence and durable execution mode, then strengthen the existing continuation transaction rather than replacing it: the old chat writes one executable handoff, Core stores it, copies the exact bootstrap text to the clipboard, opens one fresh chat, and commits the existing atomic rebind only after exact new-conversation evidence.

**Tech Stack:** TypeScript, Electron main process, Node.js, Vitest, Chrome MV3 extension JavaScript, existing continuation WAL and bridge command queue.

**Spec:** `docs/superpowers/specs/2026-09-12-runtime-continuity-hardening-design.md`

## Global Constraints

- Work only in the authoritative physical repository `C:\Users\exprt\Project Inmersion\Inmersion MCP\Chat On Steroids` on branch `port/upstream-2.0.9`; do not create another repo/worktree.
- Preserve Persistent Core, Agent System 3.0, Control Center, Plugins, Fleet/Devices, durable execution, existing browser/model discovery, permission/security/workspace authority, recorder/session recovery, and the restored 2.0.9-style UI shell.
- A model `stop` / `NO_REPLY` decision is only `candidate_done`; Core evidence decides whether terminal completion is allowed.
- Evidence from another conversation/session must never affect the current loop.
- `mode === "infinite"` must not become terminal merely because one milestone is verified complete.
- Worker chats remain excluded from automatic continuation rollover.
- Existing continuation WAL, one-command idempotency, exact conversation evidence, and atomic rebind remain authoritative; do not wholesale rewrite them.
- The old conversation remains authoritative until the exact fresh conversation is proven and the continuation commit succeeds.
- Clipboard is recovery support only; durable state and exact browser ACK remain authority.
- Keep the persisted `compaction` configuration key for compatibility even if user-facing copy changes to “Continue in New Chat”.
- Use TDD: RED → minimal GREEN → regression gate. Do not write production behavior before observing the matching failing test.
- No public release/tag and no weakening of Windows signing policy.

---

### Task 1: Add a Core-owned completion evidence evaluator

**Files:**
- Create: `src/main/goal-completion.ts`
- Create: `test/goal-completion.test.ts`
- Read/consume: `src/main/session/store.ts`
- Read/consume: `src/main/mcp/call-context.ts`
- Read/consume: `src/main/codex/ownership.ts`
- Read/consume: `src/main/execution.ts`

**Interfaces:**
- Consumes: `readSessionPlan(sessionId)`, `inFlightToolCalls(conversationId)`, `backgroundExecObligations(sessionId)`, `executionForConversation(conversationId)`.
- Produces:

```ts
export type CompletionGateDecision =
  | { action: 'allow_stop'; reason: string }
  | { action: 'continue'; reason: string; reply: string }
  | { action: 'wait'; reason: string };

export interface CompletionGateInput {
  sessionId: string;
  conversationId: string;
  objective: string;
}

export async function evaluateCompletionCandidate(
  input: CompletionGateInput
): Promise<CompletionGateDecision>;
```

- `continue` means Core has concrete durable evidence of unfinished requested work and can safely produce one grounded next user message.
- `wait` means work is still locally active/settling, so Goal must not stop and must not inject a second user turn yet.
- `allow_stop` means no contradictory Core evidence exists; the original model candidate may become terminal for a standard/no-execution chat.

- [ ] **Step 1: Write RED tests for plan-backed false stops**

Create `test/goal-completion.test.ts` with cases that create exact sessions and persist plans through the real store:

```ts
it('continues when the exact session plan has pending work', async () => {
  const session = await createSession({ conversationId: CHAT_A });
  await updateSessionPlan(session.id, CHAT_A, {
    plan: [
      { step: 'implement parser', status: 'completed' },
      { step: 'run integration verification', status: 'pending' }
    ]
  }, 100);

  await expect(evaluateCompletionCandidate({
    sessionId: session.id,
    conversationId: CHAT_A,
    objective: ''
  })).resolves.toMatchObject({
    action: 'continue'
  });
});

it('continues when the exact session plan has in-progress work', async () => {
  // Same shape, with one in_progress item.
});
```

Assert that the returned `reply` names only unfinished plan steps and does not mention completed items.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```text
npx vitest run test/goal-completion.test.ts
```

Expected: FAIL because `src/main/goal-completion.ts` / `evaluateCompletionCandidate` does not exist.

- [ ] **Step 3: Implement minimal plan-aware evaluator**

Create `src/main/goal-completion.ts` with a deterministic first pass:

```ts
import { backgroundExecObligations } from './codex/ownership.js';
import { executionForConversation } from './execution.js';
import { inFlightToolCalls } from './mcp/call-context.js';
import { readSessionPlan } from './session/store.js';

export type CompletionGateDecision =
  | { action: 'allow_stop'; reason: string }
  | { action: 'continue'; reason: string; reply: string }
  | { action: 'wait'; reason: string };

export interface CompletionGateInput {
  sessionId: string;
  conversationId: string;
  objective: string;
}

function planReply(steps: string[]): string {
  const names = steps.map((step) => step.trim()).filter(Boolean).slice(0, 6);
  return names.length === 1
    ? `Continue with the remaining requested work: ${names[0]}. Finish it and verify it before stopping.`
    : `Continue with the remaining requested work: ${names.join('; ')}. Finish these and verify them before stopping.`;
}

export async function evaluateCompletionCandidate(
  input: CompletionGateInput
): Promise<CompletionGateDecision> {
  const plan = await readSessionPlan(input.sessionId);
  const unfinished = plan?.plan.filter((item) => item.status !== 'completed') ?? [];
  if (unfinished.length > 0) {
    return {
      action: 'continue',
      reason: 'durable_plan_unfinished',
      reply: planReply(unfinished.map((item) => item.step))
    };
  }

  if (inFlightToolCalls(input.conversationId) > 0) {
    return { action: 'wait', reason: 'tool_work_in_flight' };
  }

  const exec = backgroundExecObligations(input.sessionId);
  if (exec.running.length > 0 || exec.exitedUnread.length > 0) {
    return { action: 'wait', reason: 'background_exec_unsettled' };
  }

  const execution = executionForConversation(input.conversationId);
  if (execution?.mode === 'infinite') {
    return {
      action: 'continue',
      reason: 'infinite_execution_milestone_only',
      reply: 'The current milestone may be complete, but this execution is in infinite mode. Continue with the next highest-value in-scope milestone and verify it before moving on.'
    };
  }

  return { action: 'allow_stop', reason: 'no_contradictory_core_evidence' };
}
```

If the actual `backgroundExecObligations()` shape differs, use its real exported field names without changing the semantics: running/unread exact-session process work means `wait`.

- [ ] **Step 4: Add RED tests for exact ownership and active work**

Add cases proving:

```ts
it('ignores another session plan when deciding this session', async () => { /* A can stop, B has pending plan */ });
it('waits while the exact conversation still has an in-flight tool call', async () => { /* use call-context test helper / real tracker */ });
it('does not terminate an infinite execution after one milestone', async () => { /* createExecution({mode:'infinite'}), bind to CHAT_A */ });
it('allows a lightweight no-plan chat to stop when Core has no contradictory evidence', async () => { /* expect allow_stop */ });
```

The ownership test must prove session B cannot veto or continue session A.

- [ ] **Step 5: Run RED/GREEN until Task 1 is complete**

Run after each test addition, then the full task test:

```text
npx vitest run test/goal-completion.test.ts
```

Expected final result: all Task 1 cases PASS.

- [ ] **Step 6: Run static checks and commit Task 1**

Run:

```text
npm run typecheck
git diff --check
```

Commit only Task 1 files:

```text
git add src/main/goal-completion.ts test/goal-completion.test.ts
git commit -m "feat(goal): gate completion on core evidence"
```

---

### Task 2: Integrate candidate completion into Goal Mode and durable execution semantics

**Files:**
- Modify: `src/main/goal.ts`
- Modify: `src/main/bridge.ts`
- Modify: `src/shared/goal.ts`
- Modify: `test/goal.test.ts`
- Modify: `test/bridge.test.ts`
- Modify: `extension/content.js`
- Modify: `test/content-script.test.ts`
- Test: `test/goal-completion.test.ts`

**Interfaces:**
- Consumes: `evaluateCompletionCandidate()` from Task 1.
- Produces: Goal provider `action:"stop"` / `NO_REPLY` becomes a candidate and is terminal only after Core returns `allow_stop`.
- `wait` publishes a distinct `deferred` Goal stage: no text is typed and the browser does not mark the loop globally complete. The next genuine browser turn/settlement observation may request a new draft.
- `continue` turns Core evidence into the next Goal reply using the existing draft/ACK path.

- [ ] **Step 1: Write the Goal RED regression for a false stop**

In `test/goal.test.ts`, add a real provider-response case:

```ts
it('does not stop when the provider says stop but the durable plan still has pending work', async () => {
  const session = await createSession({ conversationId: 'c-goal-pending-plan' });
  await append user + final assistant events;
  await updateSessionPlan(session.id, 'c-goal-pending-plan', {
    plan: [
      { step: 'implement feature', status: 'completed' },
      { step: 'run requested verification', status: 'pending' }
    ]
  }, 100);
  mock structured provider response { action: 'stop', reply: '' };

  goal.startGoalDraft({
    sessionId: session.id,
    conversationId: 'c-goal-pending-plan',
    turnId: 'g-plan-stop'
  });

  await waitFor(() => goal.goalViewFor('c-goal-pending-plan')?.stage === 'ready');
  expect(goal.goalViewFor('c-goal-pending-plan')?.reply).toContain('run requested verification');
});
```

Expected pre-change behavior: stage becomes `no-reply`; test FAILS.

- [ ] **Step 2: Run the single RED test**

Run:

```text
npx vitest run test/goal.test.ts -t "provider says stop but the durable plan still has pending work"
```

Expected: FAIL showing the current direct `stop → no-reply` behavior.

- [ ] **Step 3: Integrate the evidence gate into `run(draft)`**

Modify the `decision.action === 'stop'` branch in `src/main/goal.ts`:

```ts
if (decision.action === 'stop') {
  const gate = await evaluateCompletionCandidate({
    sessionId: draft.sessionId,
    conversationId: draft.conversationId,
    objective: draft.objective
  });
  if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;

  if (gate.action === 'wait') {
    logInfo(`goal: completion candidate deferred in ${draft.conversationId} — ${gate.reason}`);
    draft.reply = '';
    return settle(draft, 'deferred', gate.reason);
  }

  if (gate.action === 'continue') {
    draft.reply = humanReply(gate.reply);
    logInfo(`goal: completion candidate vetoed in ${draft.conversationId} — ${gate.reason}`);
    return settle(draft, 'ready');
  }

  logInfo(`goal: ${draft.model} completion candidate verified in ${draft.conversationId}`);
  draft.reply = '';
  return settle(draft, 'no-reply');
}
```

Extend `GoalStage` with `deferred` and document it as “Core still sees local work settling; nothing is typed and this is not verified completion.” Update the content script so `deferred` renders as a waiting/continuation state, never as `goal-done` or `goal-error`, and never spends the draft as a terminal stop.

- [ ] **Step 4: Add Goal RED/GREEN cases for all terminal directions**

Add focused cases:

```ts
it('still stops a no-plan chat when provider stop has no contradictory Core evidence', ...);
it('continues an infinite execution when provider reports stop', ...);
it('does not let another conversation plan veto this chat', ...);
it('publishes deferred rather than no-reply while exact local work is still settling', ...);
```

For infinite mode, create and bind a real execution run before starting the draft and assert Goal becomes `ready` with a continuation reply, not `no-reply`.

- [ ] **Step 5: Add a bridge-level regression proving exact conversation evidence**

In `test/bridge.test.ts`, use the real `/goal/draft` route for two recorded conversations. Give B pending plan state and A none; provider stop for A must not be changed by B’s state.

Run:

```text
npx vitest run test/goal.test.ts test/bridge.test.ts -t "completion|provider says stop|infinite execution|another conversation"
```

Expected final result: PASS.

- [ ] **Step 6: Update prompt semantics without making prompts authoritative**

Modify current defaults/trailers in `src/shared/goal.ts` so the model wording says its stop is a completion *candidate* that Core may veto. Keep `NO_REPLY` compatibility and the response schema unchanged in this slice; do not add a third provider-visible action unless tests prove it is necessary.

Add/adjust prompt contract assertions in `test/goal.test.ts` so they require wording equivalent to:

```text
NO_REPLY means “I believe the requested work is complete”; Core may continue if durable evidence says otherwise.
```

- [ ] **Step 7: Run Task 2 gate and commit**

Run:

```text
npx vitest run test/goal-completion.test.ts test/goal.test.ts test/bridge.test.ts
npm run typecheck
git diff --check
```

Commit:

```text
git add src/main/goal.ts src/main/bridge.ts src/shared/goal.ts extension/content.js test/goal.test.ts test/bridge.test.ts test/content-script.test.ts test/goal-completion.test.ts
git commit -m "fix(goal): verify completion before stopping loops"
```

---

### Task 3: Strengthen the existing continuation transaction into “Continue in New Chat”

**Files:**
- Create: `src/main/session/handoff-clipboard.ts`
- Modify: `src/main/bridge.ts`
- Modify: `src/main/session/handoff-prompt.ts`
- Modify: `src/main/session/handoff.ts`
- Modify: `extension/content.js`
- Modify: `test/bridge.test.ts`
- Modify: `test/continuation.test.ts`
- Modify: `test/session.test.ts`
- Modify: `test/content-script.test.ts` only if user-facing copy is asserted there

**Interfaces:**
- Consumes: existing `attachSummary()`, `queueResumeCommand()`, `resumeBootstrapText()`, `commitContinuationResult()`.
- Produces:

```ts
export interface HandoffClipboardResult {
  copied: boolean;
  error: string | null;
}

export async function copyHandoffBootstrapToClipboard(
  text: string
): Promise<HandoffClipboardResult>;
```

- The exact value passed to this helper is `resumeBootstrapText(handoff.text)`, which is also the exact first user message later returned by `bootstrapText(spec, claimedSummary)` for the resume command.
- Clipboard failure is warning-only; it must not create a second command, abort a stored handoff, or move authority.

- [ ] **Step 1: Write RED tests for exact clipboard/bootstrap equality**

In `test/bridge.test.ts`, mock Electron clipboard and add a capture test around `/compact`:

```ts
it('stores the handoff, copies the exact fresh-chat bootstrap, then queues one replacement chat', async () => {
  const { sessionId, token } = await compacted/opened fixture setup;
  const summary = `${SAMPLE_BRIEF}\n\nNEXT\nRun Task 7.`;
  const captured = await request('POST', '/compact', {
    body: { conversationId: FROM, token, summary }
  });

  expect(captured.status).toBe(200);
  const handoff = await getHandoff(sessionId, captured.body.handoffId);
  expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  expect(clipboard.writeText).toHaveBeenCalledWith(resumeBootstrapText(handoff!.text));
  expect(openedFreshChatCommands()).toHaveLength(1);
});
```

The test must fail before production code because capture currently stores + queues but does not copy the exact bootstrap.

- [ ] **Step 2: Run the single RED test**

Run:

```text
npx vitest run test/bridge.test.ts -t "copies the exact fresh-chat bootstrap"
```

Expected: FAIL with zero clipboard writes / missing helper.

- [ ] **Step 3: Implement isolated best-effort clipboard adapter**

Create `src/main/session/handoff-clipboard.ts`:

```ts
export interface HandoffClipboardResult {
  copied: boolean;
  error: string | null;
}

export async function copyHandoffBootstrapToClipboard(
  text: string
): Promise<HandoffClipboardResult> {
  try {
    const { clipboard } = await import('electron');
    clipboard.writeText(text);
    return { copied: true, error: null };
  } catch (error) {
    return {
      copied: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
```

Keep this adapter separate so bridge transaction tests can mock one boundary instead of importing Electron throughout continuation code.

- [ ] **Step 4: Wire clipboard after durable handoff, before fresh-chat delivery**

In the `/compact` capture path after `attachSummary(token, brief)` succeeds and before `queueResumeCommand()` / `deliver()`:

```ts
const bootstrap = resumeBootstrapText(handoff.text);
const clipboard = await copyHandoffBootstrapToClipboard(bootstrap);
if (!clipboard.copied) {
  logWarn(`bridge: fresh-chat handoff for ${sessionId} was stored but clipboard copy failed — ${clipboard.error}`);
}
```

Do not fail the HTTP capture solely because clipboard write failed.

- [ ] **Step 5: Add RED/GREEN failure and idempotency cases**

Add tests proving:

```ts
it('continues to one fresh chat when clipboard copy fails after durable handoff storage', ...);
it('does not create a second replacement chat when capture is retried', ...);
it('keeps the old conversation authoritative until exact fresh-chat ACK commits rebind', ...);
it('rejects a wrong/stale replacement conversation without moving session ownership', ...);
```

Reuse existing continuation assertions instead of duplicating the WAL implementation in tests.

- [ ] **Step 6: Make the handoff explicitly executable for the new chat**

Update `nativeHandoffPrompt()` in `src/main/session/handoff-prompt.ts` so it asks for a **continuation prompt**, not an executive summary. Keep `HANDOFF_BRIEF_RULES`, but explicitly require the final artifact to end with the concrete next action and to be directly usable as the first user message in a new conversation.

Update `resumeBootstrapText()` in `src/main/session/handoff.ts` only if needed to make the leading instruction explicit and stable, for example:

```ts
return (
  'Continue the same unfinished Chat On Steroids work in this fresh conversation. ' +
  'Treat the continuation prompt below as authoritative operational context; do not restart completed work.\n\n' +
  summary
);
```

If this text changes, update `resumeBootstrapMatches()`-backed tests and existing handoff fixtures rather than weakening provenance matching.

- [ ] **Step 7: Relabel user-facing copy to “Continue in New Chat” while keeping storage compatibility**

In extension/UI strings reached by the compact button/status, replace user-facing “Compact & Resume” wording with “Continue in New Chat”. Do **not** rename persisted config keys or `/compact` route in this slice.

Add/adjust a content-script test that asserts the visible label/status and confirms worker chats still cannot trigger this flow.

- [ ] **Step 8: Run the fresh-chat focused gate and commit**

Run:

```text
npx vitest run test/bridge.test.ts test/continuation.test.ts test/session.test.ts test/content-script.test.ts test/goal-resume-handoff.test.ts
npm run typecheck
git diff --check
```

Commit:

```text
git add src/main/session/handoff-clipboard.ts src/main/bridge.ts src/main/session/handoff-prompt.ts src/main/session/handoff.ts extension/content.js test/bridge.test.ts test/continuation.test.ts test/session.test.ts test/content-script.test.ts test/goal-resume-handoff.test.ts
git commit -m "feat(session): continue long work in a fresh chat"
```

---

### Task 4: Integrated continuity verification and return to Coding Runtime Task 7

**Files:**
- No production changes expected.
- Modify plan/spec/report docs only if verification exposes a contract clarification.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: verified continuity checkpoint immediately before the pre-existing Coding Runtime Task 7 gate.

- [ ] **Step 1: Run the continuity union**

Run:

```text
npx vitest run test/goal-completion.test.ts test/goal.test.ts test/goal-resume-handoff.test.ts test/bridge.test.ts test/continuation.test.ts test/session.test.ts test/execution.test.ts test/agents.test.ts test/content-script.test.ts test/extension.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run static gates**

Run:

```text
npm run typecheck
npm run verify:notices
git diff --check
```

Expected: all exit 0.

- [ ] **Step 3: Verify clean history/scope**

Run:

```text
git status --short --branch
git log --oneline -8
```

Expected: clean worktree and continuity commits immediately after design commit `59534f1`.

- [ ] **Step 4: Resume the already-approved Coding Runtime Task 7 gate**

Run the existing Task 7 focused union from `docs/superpowers/plans/2026-09-11-upstream-2.0.9-coding-runtime.md`, then:

```text
npm run typecheck
npm run verify:notices
git diff --check
npm run verify:ci
npm run build
```

Do not create an empty checkpoint commit. If verification requires no code/doc adjustment, retain the latest continuity implementation commit as the verified tip and continue with Browser/Bridge Reliability.

---

## Plan self-review checklist

- Every design acceptance criterion is mapped to Tasks 1–4.
- No second repo/worktree is created.
- Model stop remains provider-compatible but loses terminal authority.
- Exact session/conversation scoping is tested explicitly.
- Infinite execution milestone completion is explicitly non-terminal.
- Existing continuation WAL and exact new-chat ACK remain the rebind authority.
- Clipboard copy is exact, best-effort, and non-authoritative.
- Failure paths retain the old authoritative chat.
- Persisted compaction compatibility is preserved.
- Worker exclusion remains intact.
- Task 7 is resumed after continuity verification rather than skipped.
