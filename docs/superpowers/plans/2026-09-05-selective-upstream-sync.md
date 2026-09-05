# Selective Upstream Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the useful upstream fixes and missing 2.0.3–2.0.5 provenance into the Inmerson 2.1.x fork without replacing or weakening Agent System 3.0, Control Center, autonomous execution, Infinite Loop, worker lifecycle, fork updater, or other 2.1.x behavior.

**Architecture:** Treat `origin/main` (`v2.1.1`) as the behavioral reference and selectively re-derive upstream invariants on top of it. Do not merge or cherry-pick `upstream/main`; each selected patch is implemented as a narrow fork-native change with regression proof, then checked against the protected-feature gate.

**Tech Stack:** Electron, TypeScript, JavaScript Chrome extension, Vitest, Node.js 22+, Git worktrees.

**Spec:** `docs/superpowers/specs/2026-09-05-upstream-sync-preserve-v21-design.md`

## Global Constraints

- `origin/main` is the protected 2.1.x behavioral reference.
- No wholesale `upstream/main` merge, rebase, reset, force-push, or blind cherry-pick.
- Preserve Agent System 3.0, Manager authority/plans, Control Center, autonomous execution, managed Execution/Agent windows, Infinite Loop/scoped recovery, worker lifecycle/five-tab budget, authenticated terminal continuation, fork updater/release channel, privacy and permission/sandbox invariants.
- For production behavior, TDD is mandatory: write the regression first, observe the expected failure, then write the minimal implementation.
- Every slice is a separate commit and must leave the worktree clean.
- Do not alter `package.json`, `src/main/version.ts`, or `extension/manifest.json` version values during this synchronization.
- Final acceptance requires `npm run verify`, `npm run build` for shipping UI/extension changes, `git diff --check`, and explicit protected-feature comparison against `origin/main`.

---

### Task 1: Restore Upstream 2.0.3–2.0.5 Release Provenance

**Files:**
- Create: `docs/release-notes/v2.0.3.md`
- Create: `docs/release-notes/v2.0.4.md`
- Create: `docs/release-notes/v2.0.5.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: exact upstream historical release-note content from `upstream/main`, plus fork release lineage in `CHANGELOG.md`.
- Produces: accurate historical provenance that does not claim the fork published upstream 2.0.3/2.0.4/2.0.5 artifacts or tags.

- [ ] **Step 1: Add an explicit provenance banner to each historical note**

  Each new note begins with:

  ```markdown
  > **Upstream historical release.** This file preserves the public `totec448-spec/chat-on-steroids`
  > release record for provenance. The Inmerson fork did not publish a matching fork tag or artifact
  > set for this version; the fork's next published line is 2.1.x.
  ```

  Then include the corresponding upstream release-note body from:

  ```powershell
  git show upstream/main:docs/release-notes/v2.0.3.md
  git show upstream/main:docs/release-notes/v2.0.4.md
  git show upstream/main:docs/release-notes/v2.0.5.md
  ```

- [ ] **Step 2: Repair the changelog lineage without inventing fork releases**

  In `CHANGELOG.md`, immediately before `## [2.1.0]`, add a short lineage section explaining:

  ```markdown
  ### Upstream lineage between 2.0.2 and the fork's 2.1.x line

  The original `totec448-spec/chat-on-steroids` project continued through upstream releases
  2.0.3, 2.0.4 and 2.0.5 before and while this fork's 2.1.x architecture was developed. Their
  historical release notes are preserved under `docs/release-notes/` for provenance. These are
  not Inmerson fork release tags. The fork's 2.1.x line selectively incorporates relevant
  upstream hardening while retaining Agent System 3.0, Control Center and autonomous execution.
  ```

  Keep the existing `2.1.1`, `2.1.0`, and `2.0.2` entries unchanged except for placement of this lineage explanation.

- [ ] **Step 3: Verify documentation-only scope**

  Run:

  ```powershell
  git diff --name-only HEAD~1..HEAD  # after commit, or inspect staged names before commit
  git diff --check
  git diff -- package.json src/main/version.ts extension/manifest.json
  ```

  Expected: only the three release-note files and `CHANGELOG.md` change; version files have no diff.

- [ ] **Step 4: Commit**

  ```powershell
  git add CHANGELOG.md docs/release-notes/v2.0.3.md docs/release-notes/v2.0.4.md docs/release-notes/v2.0.5.md
  git commit -m "docs: restore upstream 2.0.3-2.0.5 provenance"
  ```

---

### Task 2: Make the Bridge Shutdown Regression Deterministic

**Files:**
- Modify: `test/bridge.test.ts`

**Interfaces:**
- Consumes: current fork bridge shutdown/drain behavior and the existing test named `drains a request that was still in flight instead of waiting out the force timeout`.
- Produces: the same behavioral assertion synchronized on HTTP acceptance rather than elapsed-time subtraction. No production-code change.

- [ ] **Step 1: Add the Node event barrier import**

  Add:

  ```ts
  import { once } from 'node:events';
  ```

- [ ] **Step 2: Replace the timer-based request setup**

  In the existing shutdown test, create the request with `expect: '100-continue'`, keep the final request-body byte withheld, wait on:

  ```ts
  const accepted = once(req, 'continue');
  req.write(payload.subarray(0, payload.length - 1));
  await accepted;
  ```

  Start `stopBridge()` without awaiting it, prove the bridge is no longer accepting new work while shutdown is still pending, then send the final byte and require the accepted request to finish with HTTP 200 before shutdown resolves. Preserve the existing `< 3_000 ms` bounded-drain assertion.

- [ ] **Step 3: Run the focused test and full bridge suite**

  ```powershell
  npx vitest run test/bridge.test.ts -t "drains a request that was still in flight"
  npx vitest run test/bridge.test.ts
  ```

  Expected: both pass; no production files are modified.

- [ ] **Step 4: Commit**

  ```powershell
  git add test/bridge.test.ts
  git commit -m "test: synchronize bridge drain on request acceptance"
  ```

---

### Task 3: Preserve Desktop Reply Generation Across Helper Replacement

**Files:**
- Create: `test/computer-generation.test.ts`
- Modify: `src/main/computer/index.ts`

**Interfaces:**
- Consumes: current Windows helper queue, `helperGeneration`, `Frame`, UI-ref identity, `runHelper`, `screenshotFromReply`, `findUiLocked`, `screenshotLocked`, `actLocked`.
- Produces: successful helper replies, frames and refs remain bound to the exact helper runtime that produced them, even if a replacement helper starts during asynchronous local work.

- [ ] **Step 1: Write the RED transport-generation regression harness**

  Create `test/computer-generation.test.ts` with a fake `node:child_process.spawn` transport that:

  - emits `spawn` asynchronously;
  - records JSON requests written to stdin;
  - returns deterministic `snapshot`, `capture`, `find_ui`, `act`, `windows` and `cursor` replies;
  - can close the current helper and allow the next call to spawn a replacement;
  - writes a minimal PNG payload whenever a request names `file`.

  Mock `../src/main/env.js`, `../src/main/exec.js`, and `../src/main/logger.js` so the real `src/main/computer/index.ts` helper lifecycle is exercised without real desktop input.

- [ ] **Step 2: Add RED case — replacement during asynchronous image materialization**

  Test sequence:

  1. spy on `fs.stat` for the first screenshot materialization;
  2. inside that async boundary, close the helper and call `listWindows()` so a replacement helper becomes active;
  3. let `getWindowState({ window: 77 })` finish using the old reply;
  4. assert the returned screenshot frame and UI ref are rejected as `STALE_FRAME` / `STALE_REF` and send no native action;
  5. take a fresh state from the replacement helper and prove its ref works.

  Run:

  ```powershell
  npx vitest run test/computer-generation.test.ts -t "keeps an original reply identity across asynchronous image materialization"
  ```

  Expected RED: current baseline incorrectly treats the old reply as belonging to the replacement generation, so at least one stale operation is accepted or mislabeled.

- [ ] **Step 3: Add RED case — replacement during a local wait before dispatch**

  Create a state, use fake timers, call `act([{ type: 'wait', ms: 100 }, { type: 'move', ... }], { frameId })`, replace the helper while the wait is pending, advance the timer, and require:

  ```ts
  await expect(work).rejects.toMatchObject({
    completedCount: 1,
    failedIndex: 1,
    completedRoutes: ['local'],
    message: expect.stringMatching(/STALE_FRAME/)
  });
  ```

  Repeat the same boundary for `click_ref` and require `STALE_REF`.

  Verify both are RED before production edits.

- [ ] **Step 4: Give each helper runtime an immutable generation**

  In `src/main/computer/index.ts`:

  ```ts
  interface HelperRuntime {
    generation: number;
    // existing fields...
  }
  ```

  Initialize `generation: 0`, then on `spawn` assign:

  ```ts
  runtime.generation = ++helperGeneration;
  ```

  Do not read the global generation later to infer which runtime produced an already-returned reply.

- [ ] **Step 5: Stamp successful replies with transport-owned generation metadata**

  Add a module-private `WeakMap<object, number>` plus helpers equivalent to:

  ```ts
  const helperReplyGeneration = new WeakMap<object, number>();

  function stampHelperReply(reply: Record<string, any>, generation: number): Record<string, any> {
    helperReplyGeneration.set(reply, generation);
    return reply;
  }

  function generationOfReply(reply: Record<string, any>): number {
    const generation = helperReplyGeneration.get(reply);
    if (generation === undefined) throw new ComputerError('Desktop reply has no transport identity.');
    return generation;
  }
  ```

  Resolve successful helper replies with `stampHelperReply(reply, runtime.generation)`.

- [ ] **Step 6: Add active-generation assertions at dispatch**

  Add:

  ```ts
  type ExpectedHelper = { generation: number; code: 'STALE_FRAME' | 'STALE_REF' };
  ```

  plus `isHelperGenerationActive()` and `assertHelperGeneration()` helpers. Thread an optional `ExpectedHelper` through `sendHelperRequest()` and `runHelper()`. After `startHelper()` but before writing a request, reject if the expected generation is no longer the active helper.

- [ ] **Step 7: Bind frames and refs to reply generation**

  Add `helperGeneration: number` to `Frame`; populate it from `generationOfReply(reply)` in `screenshotFromReply()`.

  Change `rememberUiRef(...)` to accept the reply generation explicitly and call it from `findUiLocked()` using `generationOfReply(reply)`. Before mapping UI bounds, qualify the supplied frame against that same reply generation so a new helper's UI reply cannot be projected into an old helper's screenshot.

  `frameById()` must return only a frame whose generating helper is still active.

- [ ] **Step 8: Re-check generation for crop and native dispatch**

  In `screenshotLocked()`, reject a retained-but-stale crop frame as `STALE_FRAME` and pass its generation as `ExpectedHelper` to the capture request.

  In `actLocked()`, compute one `ExpectedHelper` after synchronous validation and use it for every native batch flushed after local wait/clipboard actions. This closes the gap where local work can outlive the helper that validated the frame/ref.

  Keep clipboard-only/wait-only batches independent from the desktop helper.

- [ ] **Step 9: Verify GREEN and adjacent Desktop contracts**

  ```powershell
  npx vitest run test/computer-generation.test.ts
  npx vitest run test/computer.test.ts test/computer-stale-ref.test.ts test/computer-local-actions.test.ts
  npm run typecheck
  ```

  Expected: new generation suite green; existing stale-frame/ref and local-action semantics remain green.

- [ ] **Step 10: Commit**

  ```powershell
  git add src/main/computer/index.ts test/computer-generation.test.ts
  git commit -m "fix(desktop): preserve helper reply provenance"
  ```

---

### Task 4: Keep Folder Access Discoverable After Setup

**Files:**
- Modify: `test/renderer-state.test.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: existing Setup wizard, `foldersCard`, `addFolder`, `showTab('home')`, tidy-wizard CSS.
- Produces: a navigation-only Manage folders path after onboarding; it grants no root and changes no connection state.

- [ ] **Step 1: Write the RED renderer-state test**

  Add a test named:

  ```ts
  it('keeps folder access discoverable after setup and navigates without granting access', async () => { ... })
  ```

  Arrange a connected/tidy setup state with an existing `/repo` root. Require a visible folder-management control, click it, then assert:

  - active panel becomes `home`;
  - focus lands on `addFolder`;
  - existing root summary still contains `/repo`;
  - `addRoot` was not called;
  - no IPC mutation was made merely by navigation.

  Run the focused test and observe RED because `wizManageFolders` does not exist.

- [ ] **Step 2: Add the narrow UI affordance**

  In the folder step beside `wizAddFolder`, add:

  ```html
  <button class="btn" id="wizManageFolders" type="button">Manage folders</button>
  ```

  Add a handler that calls `showTab('home')`, scrolls `foldersCard` into view, and focuses the existing `addFolder` button with `{ preventScroll: true }`.

  Extend the tidy-wizard CSS selector so the folder step's `.step-actions` remain visible after setup is complete. Do not change root permission APIs or connection lifecycle.

- [ ] **Step 3: Verify GREEN and renderer neighbors**

  ```powershell
  npx vitest run test/renderer-state.test.ts -t "keeps folder access discoverable after setup"
  npx vitest run test/renderer-state.test.ts test/renderer-layout.test.ts
  npm run typecheck
  ```

- [ ] **Step 4: Commit**

  ```powershell
  git add src/renderer/index.html src/renderer/main.ts src/renderer/styles.css test/renderer-state.test.ts
  git commit -m "fix(renderer): keep folder access discoverable"
  ```

---

### Task 5: Add Bounded Native Tool Disclosures Without Disturbing 2.1 Recovery

**Files:**
- Modify: `test/content-script.test.ts`
- Modify: `extension/content.js`
- Modify: `extension/overlay.css`

**Interfaces:**
- Consumes: current `streamRow(entry)`, `renderStreams()`, activity stream identity/signature logic, scoped recovery and conversation-reset behavior.
- Produces: keyboard-operable native `<details>` disclosure for tool-call metadata only; raw args/results are never rendered.

- [ ] **Step 1: Write RED disclosure tests in the existing app-owned stream describe block**

  Add independent tests covering:

  1. bounded metadata display (`tool`, outcome, duration, changed-file counts) while sentinel raw `args` and `result` remain absent;
  2. same-call expansion/focus survives a repaint;
  3. authoritative activity-tail replacement refreshes details;
  4. changed-file paths are bounded to 12 visible entries, escaped through text nodes, and an unknown outcome is not invented as success;
  5. reused call ids in another conversation do not inherit disclosure state.

  Run:

  ```powershell
  npx vitest run test/content-script.test.ts -t "native, keyboard-operable tool disclosures"
  ```

  Expected RED: current stream rows have no disclosure panel.

- [ ] **Step 2: Add bounded metadata projection**

  Add `streamToolDetails(entry)` immediately before `streamRow`. It returns app-owned text rows only:

  - tool name capped at 160 characters;
  - outcome mapped to `completed`, `failed`, `refused`, or `unknown`;
  - non-negative finite duration rounded to milliseconds;
  - at most 12 changed-file rows;
  - each path capped at 1024 characters;
  - optional `+N`, `−N`, and `≈` for approximate counts;
  - one final `N more changed files` row when truncated.

  Do not read or render `args`, `result`, credentials, tool payloads, or arbitrary nested objects.

- [ ] **Step 3: Wrap only tool calls in native `<details>`**

  Change `streamRow(entry, expandedTools)` so non-tool rows remain ordinary `div`s. Tool calls use a `<summary>` carrying the existing stream-row content inside a `<details class="clf-stream-tool-disclosure">` with a panel rendered entirely via `textContent`.

  Key each disclosure by `entry.callId || `seq:${entry.seq}`` and initialize `details.open` only from the exact current turn root's prior expanded-call set.

- [ ] **Step 4: Preserve expansion/focus only inside the exact current render root**

  Extend the existing stream signature with `JSON.stringify(streamToolDetails(entry))` for tool calls. Before `root.replaceChildren(...)`, collect open disclosure ids and the focused disclosure summary from that same root, then rebuild rows with those ids. Restore focus only when the same call is still present.

  Do not add any module-global expansion store. Existing conversation reset/removal must naturally discard disclosure state.

- [ ] **Step 5: Add native disclosure CSS**

  In `extension/overlay.css`, add styles for:

  - `.clf-stream-tool-disclosure > summary`
  - hidden browser marker and a small CSS chevron
  - `[open]` chevron rotation
  - `:focus-visible` outline
  - `.clf-stream-tool-panel`
  - `.clf-stream-tool-change` monospace paths

  Preserve current `.clf-stream-tool_call` visual treatment and all scoped recovery/overwrite selectors.

- [ ] **Step 6: Verify GREEN and extension neighbors**

  ```powershell
  npx vitest run test/content-script.test.ts
  npx vitest run test/extension.test.ts
  npm run typecheck
  npm run build
  ```

- [ ] **Step 7: Commit**

  ```powershell
  git add extension/content.js extension/overlay.css test/content-script.test.ts
  git commit -m "feat(extension): disclose bounded tool activity details"
  ```

---

### Task 6: Re-Audit Upstream and Enforce the 2.1 Preservation Gate

**Files:**
- Modify only if needed: `docs/superpowers/specs/2026-09-05-upstream-sync-preserve-v21-design.md` audit SHA/classification section when upstream has moved during implementation.
- No production edits are permitted in this task unless they become a new separately designed slice.

**Interfaces:**
- Consumes: completed synchronization branch, latest `upstream/main`, protected `origin/main` reference.
- Produces: verified branch that can be reviewed for fork integration without hidden feature loss.

- [ ] **Step 1: Refresh upstream refs read-only with respect to worktree files**

  ```powershell
  git fetch upstream --prune
  git fetch origin --prune
  git cherry origin/main upstream/main
  ```

  Classify any newly appearing upstream-only patch. Do not absorb it automatically; if it changes production behavior, it requires its own design/TDD slice.

- [ ] **Step 2: Run the protected-feature structural checks**

  Require these fork files/directories still exist and are not deleted in `origin/main..HEAD`:

  ```powershell
  git diff --diff-filter=D --name-only origin/main..HEAD
  Test-Path src/main/orchestration
  Test-Path src/main/orchestration/control-center.ts
  Test-Path src/renderer/control-center.ts
  Test-Path src/main/execution.ts
  Test-Path extension/agent-tab-lifecycle.js
  ```

  Also inspect:

  ```powershell
  git diff origin/main..HEAD -- package.json src/main/version.ts extension/manifest.json src/main/update.ts src/main/orchestration src/renderer/control-center.ts src/main/execution.ts extension/agent-tab-lifecycle.js
  ```

  Expected: no version downgrade, no updater repository/channel rollback, and no deletion/replacement of protected 2.1 systems.

- [ ] **Step 3: Run focused preservation suites**

  ```powershell
  npx vitest run test/orchestration-*.test.ts test/control-center.test.ts test/control-center-renderer.test.ts test/agent-tab-budget.test.ts test/agent-tab-lifecycle.test.ts test/execution.test.ts
  ```

  If glob handling differs on Windows, enumerate the same matching files explicitly rather than weakening the suite.

- [ ] **Step 4: Run final gates**

  ```powershell
  npm run verify:privacy
  npm run verify
  npm run build
  git diff --check origin/main..HEAD
  git status --short --branch
  ```

  Expected: all gates pass and the sync worktree is clean.

- [ ] **Step 5: Final branch review**

  Review `origin/main..HEAD` as one branch and reject any change that is not attributable to one of Tasks 1–5. Do not merge or push to a shared branch as part of this task; integration/push is a separate explicit side effect.

