# Recovery State Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace page-global Auto-Loop transfer state with tab/document-scoped extension transactions, reopen stalled conversations at their exact URL, and restore the cross-chat safety invariants that currently fail in `content-script.test.ts`.

**Architecture:** `extension/background.js` owns semantic Loop transfers. A source document requests a transfer with only its proven conversation and semantic Loop snapshot; the service worker reads the source tab URL from Chrome, creates and persists a target-tab transaction before navigation, and exposes that transaction only to the exact registered target document. The content script restores semantic Loop state after identity/hydration checks and ACKs readiness; only then may the service worker close the old tab. Consecutive recovery counts live outside page `sessionStorage`, and clean-chat rollover uses the same target-tab transaction mechanism rather than origin-wide `localStorage`.

**Tech Stack:** Chrome MV3 extension APIs (`chrome.tabs`, `chrome.storage.session`, `chrome.storage.local`), plain JavaScript extension code, TypeScript/Vitest/jsdom test harnesses.

**Spec:** `docs/superpowers/specs/2026-09-04-remote-autonomous-execution-design.md`

## Global Constraints

- Reopen an existing stalled conversation using the exact URL returned by `chrome.tabs.get(sourceTabId).url`; do not add `cos_*`, `clf`, recovery, Loop, or other Chat On Steroids parameters.
- Wrong tab, wrong conversation, wrong document, stale epoch, or ambiguous ownership means no autonomous send.
- Persist semantic ownership/state before irreversible browser side effects.
- Three consecutive failed same-conversation recoveries trigger clean-chat rollover; genuine forward progress resets the counter.
- A user draft and protected local-tool state always win over autonomous insertion.
- Do not trust or consume legacy `localStorage['cos_autoloop_pending']` as authority.
- Preserve existing Agent System 3.0 orchestration durability work and unrelated working-tree edits.
- All newly authored first-party text and comments are English.

## File Map

- Modify `extension/background.js`: durable Loop transfer records, recovery counters, exact-URL replacement, transfer claim/ready/progress handlers, legacy pending-state neutralization.
- Modify `extension/content.js`: semantic Loop snapshot/restore, recovery request, transfer claim during document registration, hydration decision, readiness/progress ACK, removal of global `localStorage` authority.
- Modify `test/extension.test.ts`: service-worker transaction, target-tab, counter, exact-URL, and close-after-ready tests.
- Modify `test/content-script.test.ts`: content-side restore, duplicate-send prevention, wrong-target rejection, and invariant regression tests.
- Modify `extension/fiber.js` only if a failing invariant is proven to originate in the current Fiber WIP rather than a stale test contract.
- Modify `test/fiber.test.ts` only alongside a proven Fiber behavior correction.

---

### Task 1: Pin the Loop-transfer wire contract in tests

**Files:**
- Modify: `test/extension.test.ts`
- Modify: `test/content-script.test.ts`

**Interfaces:**
- Consumes: existing `register_document`, `chrome.tabs`, and content-script `ask()` message transport.
- Produces: the following message contract for later tasks:

```ts
type LoopMode = 'standard' | 'infinite';

interface LoopSnapshot {
  mode: LoopMode;
  turns: number;
  lastReason: string;
  recentFingerprints: string[];
  executionRunId: string | null;
  recoveryGeneration: number;
}

interface RecoverConversationMessage {
  type: 'recover_conversation_tab';
  conversationId: string;
  loop: LoopSnapshot;
  reason: string;
  rolloverText: string;
}

interface LoopTransferPayload {
  id: string;
  kind: 'recovery' | 'rollover';
  conversationId: string | null;
  loop: LoopSnapshot;
  reason: string;
  attempt: number;
  rolloverText: string | null;
}
```

`rolloverText` is app-authored continuation framing derived in the source content script from the current transcript and bounded to 8,000 characters. It is used only for an unmanaged/manual Loop fallback. When `loop.executionRunId` is present, Plan 2 replaces this path with the Core-owned `/execution/rollover` command and the browser-supplied `rolloverText` is ignored.

- [ ] **Step 1: Add a failing service-worker test for byte-for-byte URL recovery**

Add a test that registers a source document on a URL containing an ordinary ChatGPT query/hash, invokes `recover_conversation_tab`, and asserts the created target receives exactly that same URL.

```ts
it('reopens the exact Chrome-owned conversation URL without Chat On Steroids parameters', async () => {
  const sourceUrl = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?model=gpt-5#section';
  // register source tab/document using the existing background harness
  // request recovery with only conversationId + loop snapshot
  expect(createdTabs.at(-1)?.url).toBe(sourceUrl);
  expect(createdTabs.at(-1)?.url).not.toMatch(/cos_|clf=/);
});
```

- [ ] **Step 2: Add failing tests for target-tab isolation and close-after-ready**

Cover all of these assertions in `test/extension.test.ts`:

```ts
expect(await registerDocument(unrelatedTab)).not.toHaveProperty('recovery');
expect(await registerDocument(targetTabWrongConversation)).not.toHaveProperty('recovery');
expect(removedTabs).not.toContain(sourceTabId);
await messageFromTarget({ type: 'recovery_ready', recoveryId });
expect(removedTabs).toContain(sourceTabId);
```

- [ ] **Step 3: Add failing tests for counter durability and rollover selection**

The same conversation/run should return attempts `1`, `2`, `3`; the next stall should create a `kind: 'rollover'` transfer. Recreate the service-worker harness between attempts while preserving storage to prove worker sleep/restart does not reset the count.

- [ ] **Step 4: Add a failing content-script test that restores Loop state from `register_document` rather than localStorage**

Start the harness on the exact conversation URL with no `cos_*` parameters. Make `register_document` return a `recovery` payload and assert the control shows the restored mode/turn count after startup.

- [ ] **Step 5: Run only the new tests and verify RED**

Run:

```bash
npx vitest run test/extension.test.ts test/content-script.test.ts
```

Expected: the new recovery/transfer assertions fail because `background.js` still takes a URL from the page and `content.js` still uses `sessionStorage`/`localStorage` recovery state.

- [ ] **Step 6: Commit the tests**

```bash
git add -p test/extension.test.ts test/content-script.test.ts
git diff --cached -- test/extension.test.ts test/content-script.test.ts
git commit -m "test(extension): pin scoped loop recovery transactions"
```

---

### Task 2: Make the service worker the authority for Loop transfers

**Files:**
- Modify: `extension/background.js`
- Test: `test/extension.test.ts`

**Interfaces:**
- Consumes: `RecoverConversationMessage`, existing `register_document` source identity, `tabConversations`, `tabDocuments`, `tabEpochs`.
- Produces:

```js
// chrome.storage.session
loopTransfers = {
  [targetTabId]: {
    id,
    kind,                 // 'recovery' | 'rollover'
    sourceTabId,
    sourceDocumentId,
    targetTabId,
    targetDocumentId: null,
    expectedUrl,
    expectedConversationId,
    loop,
    reason,
    attempt,
    createdAt
  }
};

// chrome.storage.local
loopRecoveryCounters = {
  [counterKey]: { count, updatedAt }
};
```

`counterKey` is `run:<executionRunId>` when present; otherwise `conversation:<conversationId>`.

- [ ] **Step 1: Add bounded parser/helpers for Loop snapshots and transfer records**

Implement helpers inside `background.js`:

```js
function parseLoopSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.mode !== 'standard' && value.mode !== 'infinite') return null;
  const turns = Number.isInteger(value.turns) && value.turns >= 0 ? Math.min(value.turns, 10_000) : null;
  if (turns === null) return null;
  return {
    mode: value.mode,
    turns,
    lastReason: typeof value.lastReason === 'string' ? value.lastReason.slice(0, 500) : '',
    recentFingerprints: Array.isArray(value.recentFingerprints)
      ? value.recentFingerprints.filter((v) => typeof v === 'string').slice(-8).map((v) => v.slice(0, 500))
      : [],
    executionRunId: typeof value.executionRunId === 'string' && value.executionRunId ? value.executionRunId.slice(0, 80) : null,
    recoveryGeneration: Number.isInteger(value.recoveryGeneration) && value.recoveryGeneration >= 0
      ? value.recoveryGeneration
      : 0
  };
}
```

- [ ] **Step 2: Load and persist the two new stores**

Add `loopTransfers` to the existing `chrome.storage.session.get(...)` load set and `loopRecoveryCounters` to `chrome.storage.local.get(...)`. Add dedicated persistence helpers so recovery counter writes cannot be lost behind unrelated journal writes.

- [ ] **Step 3: Replace `recover_conversation_tab` with identity-checked exact-URL capture**

The handler must:

1. `await load()`.
2. Require `ownsDocument(source)`.
3. Parse `message.loop`.
4. Require `message.conversationId === tabConversations[source.tab]`.
5. Read the source tab with `chrome.tabs.get(source.tab)`.
6. Parse the browser URL and require a ChatGPT host and `/c/<conversationId>` path matching the proven conversation.
7. Increment/persist the counter before creating the target.
8. Choose `kind='rollover'` when the previous count is already `>= 3`; otherwise `kind='recovery'`.
9. Create a blank target tab in the same window as the source when possible.
10. Persist `loopTransfers[targetTabId]` before navigating the target.
11. Navigate with `chrome.tabs.update(targetTabId, { url: exactUrl, active: true })` for recovery, or the canonical ChatGPT root for rollover.
12. Return `{ ok: true, transferId, kind, attempt }` without closing the source.

For `kind='rollover'`, require `executionRunId === null`, bound `message.rolloverText` to 8,000 characters, and persist it as `rolloverText` on the target-tab transaction. If an execution run id is present, return `{ ok: false, error: 'core_rollover_required' }`; Plan 2 replaces that branch with authenticated Core-owned rollover publication.

- [ ] **Step 4: Extend `register_document` to claim only the exact target transfer**

After normal document ownership registration succeeds, look up `loopTransfers[source.tab]`. Return a `recovery` payload only when:

- the tab id is the exact target id,
- the document is the current owned document,
- recovery kind: current concrete conversation equals `expectedConversationId` and current `chrome.tabs.get(tab).url` equals `expectedUrl`,
- rollover kind: the page is still a new-chat route with no concrete conversation id.

Bind `targetDocumentId` before returning the payload and persist it to `chrome.storage.session`.

- [ ] **Step 5: Add `recovery_ready` and `recovery_progress` handlers**

`recovery_ready` validates target tab, target document, and transfer id. Then it removes the source tab only after re-proving the source tab is still the original ChatGPT conversation; finally retire the transfer.

`recovery_progress` validates the same target identity and resets `loopRecoveryCounters[counterKey].count = 0`. It is idempotent and may safely arrive after `recovery_ready` by retaining a small completed-transfer receipt long enough to identify the counter key.

- [ ] **Step 6: Bound and garbage-collect stale records**

Use a five-minute transaction TTL. On load and on `chrome.tabs.onRemoved`, delete transfers whose source/target is gone or whose age exceeds the TTL. Never close any surviving tab during stale-record cleanup.

- [ ] **Step 7: Run the service-worker tests**

```bash
npx vitest run test/extension.test.ts
```

Expected: all newly added transaction/counter/exact-URL tests pass.

- [ ] **Step 8: Commit the service-worker transaction**

```bash
git add -p extension/background.js test/extension.test.ts
git diff --cached -- extension/background.js test/extension.test.ts
git commit -m "fix(extension): scope loop recovery to target documents"
```

---

### Task 3: Restore semantic Auto-Loop state in the replacement document

**Files:**
- Modify: `extension/content.js`
- Test: `test/content-script.test.ts`

**Interfaces:**
- Consumes: `register_document` response field `recovery: LoopTransferPayload | null`.
- Produces: `recovery_ready` and `recovery_progress` messages; no page-global pending state.

- [ ] **Step 1: Add explicit snapshot/restore helpers**

Implement:

```js
function autoLoopSnapshot() {
  return {
    mode: autoLoopMode === 'infinite' ? 'infinite' : 'standard',
    turns: autoLoopTurns,
    lastReason: autoLoopLastReason || '',
    recentFingerprints: autoLoopRecentFingerprints.slice(-8),
    executionRunId: currentExecutionRunId || null,
    recoveryGeneration: autoLoopRecoveryGeneration
  };
}

function restoreAutoLoopSnapshot(snapshot) {
  autoLoopActive = true;
  autoLoopMode = snapshot.mode;
  autoLoopTurns = snapshot.turns;
  autoLoopLastReason = snapshot.lastReason;
  autoLoopRecentFingerprints = snapshot.recentFingerprints.slice(-8);
  currentExecutionRunId = snapshot.executionRunId || null;
  autoLoopRecoveryGeneration = snapshot.recoveryGeneration + 1;
  clearAutoLoopWatchdog();
}
```

Add `currentExecutionRunId = null` and `autoLoopRecoveryGeneration = 0` as semantic state; Plan 2 will bind managed execution runs to the former.

- [ ] **Step 2: Capture the `register_document` response instead of discarding it**

Where the content script currently registers its document, retain the response in a page-local variable such as `startupLoopTransfer`. Never read `cos_autoloop_pending` to decide authority.

- [ ] **Step 3: Rewrite `recoverOrRolloverAutoLoop(reason)`**

Remove `sessionStorage['cos_conv_recover_*']`, URL construction, and `localStorage['cos_autoloop_pending']`. Send only:

```js
ask({
  type: 'recover_conversation_tab',
  conversationId: currentConvId,
  loop: autoLoopSnapshot(),
  reason: reason || 'stall_recovery',
  rolloverText: buildManualRolloverText(reason)
});
```

Implement `buildManualRolloverText(reason)` by reusing the existing bounded transcript extraction, but keep the output English-only and cap it to 8,000 characters. It must contain app-owned framing that says to continue only the interrupted task plus bounded root/latest user prompts and last assistant progress; it must not carry credentials or browser identity.

On a successful response, stop local timers and leave navigation/closing to the service worker. If the request fails, keep the source tab open and call `stopAutoLoop('Recovery could not be started')` rather than navigating optimistically.

- [ ] **Step 4: Replace `checkAndResumeAutoLoopRollover()` with transfer restoration**

For `startupLoopTransfer.kind === 'recovery'`:

1. restore semantic state,
2. wait for composer,
3. verify current conversation still matches the transfer,
4. hydrate for the existing bounded delay,
5. if already generating, send `recovery_ready` and observe only,
6. if latest assistant turn is completed, let normal Loop logic select the next step,
7. otherwise schedule exactly one continuation if composer/tool safety permits,
8. send `recovery_ready` after state/hydration validation, before any old-tab close can occur.

For `kind === 'rollover'`, require `startupLoopTransfer.rolloverText`, insert that app-owned continuation framing only after the new-chat composer is empty/stable, send once, and then ACK readiness. Do not use localStorage.

- [ ] **Step 5: Emit genuine progress evidence**

After a recovered document observes either a new generating turn with meaningful activity or a new `turn_end`, send once:

```js
ask({ type: 'recovery_progress', recoveryId: startupLoopTransfer.id });
```

Do not emit it merely because the page loaded.

- [ ] **Step 6: Neutralize legacy state**

On startup, best-effort remove `cos_autoloop_pending` and old `cos_conv_recover_*` keys without acting on them. Do not preserve Turkish legacy prompt text in the cleanup path.

- [ ] **Step 7: Run the content tests**

```bash
npx vitest run test/content-script.test.ts
```

Expected: the new recovery tests pass; remaining failures are unrelated invariant/stale-contract failures to classify in Task 4.

- [ ] **Step 8: Commit semantic Loop restoration**

```bash
git add -p extension/content.js test/content-script.test.ts
git diff --cached -- extension/content.js test/content-script.test.ts
git commit -m "fix(extension): restore loop state from scoped recovery"
```

---

### Task 4: Restore genuine content-script safety invariants

**Files:**
- Modify: `extension/content.js`
- Modify: `test/content-script.test.ts`
- Conditional Modify: `extension/fiber.js`
- Conditional Modify: `test/fiber.test.ts`

**Interfaces:**
- Consumes: existing `epoch`, document ownership, `pendingTools`, Goal draft ownership, bootstrap marker/redeem state.
- Produces: no new public API; this task restores existing documented behavior.

- [ ] **Step 1: Run the file with verbose failure names and capture the list**

```bash
npx vitest run test/content-script.test.ts --reporter=verbose
```

Classify each failure in a temporary local note (not committed) as `STALE_TEST_CONTRACT` or `REAL_INVARIANT_REGRESSION`. A test is stale only when the asserted UI/test-hook surface was intentionally removed and no product invariant depends on it. Safety tests listed below are always real until proven otherwise.

- [ ] **Step 2: Fix worker compaction authority**

Before any automatic compaction claim/send, require the current conversation not be bound as a worker. Preserve the existing app-side authority check as a second fence.

Run the exact tests whose names contain:

```text
never emits an automatic compaction claim from a worker chat
```

- [ ] **Step 3: Fix local-tool and composer pre-send gates**

Immediately before irreversible compact/Goal/Loop sends, re-check:

```js
if (pendingTools > 0 || localToolStateUnverifiable) return failClosed;
if (!sameComposerValue(validatedComposerSnapshot)) return failClosed;
```

Run the tests named around `local tool is still running`, `cannot verify pending local tools`, and `composer changes during pre-send wait`.

- [ ] **Step 4: Fence bootstrap/revival sends by navigation epoch and recorder generation**

Capture `{ epoch, RUN_ID }` before redeem/insert; after every `await` and immediately before `CLF_DOM.send()`, require both still match and require the current document still owns the command. Abort/ACK failed without sending on mismatch.

Run the tests named around SPA navigation retarget, recorder takeover, hidden-tab revival, and duplicate revival delivery.

- [ ] **Step 5: Serialize Goal and Auto-Loop autonomous writes**

Use one page-local autonomous-send lease with explicit owner values (`'goal' | 'loop' | 'compact' | 'bootstrap' | 'revival'`). Acquisition fails closed if another owner holds the lease; release in `finally`. This prevents two independent async paths from typing into the same composer.

- [ ] **Step 6: Correct only proven Fiber regressions**

If transcript/final-turn failures remain after content authority fixes, run:

```bash
npx vitest run test/fiber.test.ts test/content-script.test.ts
```

Change `fiber.js` only for failures reproducible in `test/fiber.test.ts` or a minimal new regression test. Do not restore obsolete `data-turn-id` assumptions merely to satisfy a stale fixture.

- [ ] **Step 7: Delete or rewrite stale UI-contract tests rather than production-shimming removed APIs**

Examples include tests that require removed `toggleMenu`/`settingsView` hooks when those hooks no longer exist in the shipped UI. Replace them with assertions against the current rendered control if the behavior still matters; otherwise remove only the stale assertion.

- [ ] **Step 8: Run the entire content/extension cluster**

```bash
npx vitest run test/content-script.test.ts test/extension.test.ts test/fiber.test.ts test/agent-tab-lifecycle.test.ts
```

Expected: zero genuine invariant failures. Any remaining failure must be explicitly identified as a separate environment or obsolete-contract issue before proceeding.

- [ ] **Step 9: Commit the invariant restoration**

```bash
git add -p extension/content.js extension/fiber.js test/content-script.test.ts test/fiber.test.ts
git diff --cached -- extension/content.js extension/fiber.js test/content-script.test.ts test/fiber.test.ts
git commit -m "fix(extension): restore autonomous send invariants"
```

---

### Task 5: Recovery-plan verification gate

**Files:**
- No production changes unless verification exposes a regression.

**Interfaces:**
- Produces the stable browser primitives required by Plan 2.

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run targeted extension suites**

```bash
npx vitest run test/content-script.test.ts test/extension.test.ts test/fiber.test.ts test/agent-tab-lifecycle.test.ts
```

Expected: all non-environment-specific tests pass.

- [ ] **Step 3: Check patch hygiene**

```bash
git diff --check
```

Expected: exit 0.

- [ ] **Step 4: Record the recovery boundary in the project handoff only after tests are green**

Update `Brain/AI OS/Handoffs/Current.md` with the exact recovery transaction semantics and verification commands/results. Do not edit unrelated session records.

- [ ] **Step 5: Commit the handoff update separately**

```bash
git add -p "Brain/AI OS/Handoffs/Current.md"
git diff --cached -- "Brain/AI OS/Handoffs/Current.md"
git commit -m "docs: record scoped recovery boundary"
```
