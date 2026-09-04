# Core Consistency and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the remaining architectural inconsistencies and regressions, make first-party project text English-only, finish full-suite stabilization, and prepare a clean upstream-ready contribution without unrelated working-tree changes.

**Architecture:** This plan does not add a new subsystem. It reconciles implementation with already-documented authority boundaries, fixes admission/UI state machines where code and presentation currently disagree, removes locale-specific first-party behavior, and closes with evidence-driven verification. Contribution preparation operates only on logically verified commits; pre-existing unrelated edits and generated session notes remain outside the contribution.

**Tech Stack:** TypeScript, Electron IPC/renderer, Chrome bridge HTTP server, Vitest, Git.

**Spec:** `docs/superpowers/specs/2026-09-04-remote-autonomous-execution-design.md`

## Global Constraints

- The authenticated MCP endpoint is the authority boundary for live Core terminal sessions; conversation identity is attribution, not authorization.
- Browser presence is never required for ordinary Core terminal continuation.
- Protocol incompatibility must fail admission even when stale last-good telemetry is retained for presentation.
- `config.allComputer` is the only authority for All Computer active state.
- Manually changing roots while All Computer is active explicitly exits that mode and clears the old restore snapshot.
- All first-party product prompts, labels, comments, status reasons, test descriptions, and first-party fixtures touched by this work are English-only.
- Do not change unrelated Agent System 3.0 orchestration/journal behavior that is already green.
- Do not claim full success while non-environment-specific tests fail.
- Do not push or open an upstream contribution until the final cached/branch diff is reviewed and contains no unrelated WIP.
- Plans 1 and 2 must be green before this plan begins.

## File Map

- Modify `src/main/codex/ownership.ts`, `src/main/mcp/tools-core.ts`, `test/workspace.test.ts`, `test/mcp.test.ts`: terminal authority correction.
- Modify `src/main/bridge.ts`, `test/bridge.test.ts`: protocol compatibility admission fence.
- Modify `src/main/ipc.ts`, `src/renderer/main.ts`, `test/ipc.test.ts`, `test/renderer-state.test.ts`, `test/workspace.test.ts` as applicable: All Computer state machine and permission UX.
- Modify `extension/content.js`, extension tests/docs/source files containing Turkish first-party strings: English-only cleanup.
- Modify environment-sensitive test harnesses only where a deterministic mock boundary can replace accidental dependency on a real desktop/native handle.
- Modify `CHANGELOG.md`, `docs/release-notes/...`, `Brain/AI OS/Handoffs/Current.md` only after implementation behavior is verified.

---

### Task 1: Restore authenticated-endpoint terminal authority

**Files:**
- Modify: `src/main/codex/ownership.ts`
- Modify: `src/main/mcp/tools-core.ts`
- Modify: `test/workspace.test.ts`
- Modify: `test/mcp.test.ts`

**Interfaces:**
- Existing public functions remain:

```ts
export function noteExecOwner(processId: number, conversationId: string | null): void;
export function execOwner(processId: number): string | null;
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean;
export function moveExecConversationOwners(from: string, to: string): number;
```

- [ ] **Step 1: Write/restore failing tests for cross-chat authenticated continuation**

In `test/workspace.test.ts`, pin:

```ts
expect(execOwnershipDenied(101, 'chat-a')).toBe(false);
expect(execOwnershipDenied(101, 'chat-b')).toBe(false);
expect(execOwnershipDenied(102, null)).toBe(false);
expect(execOwnershipDenied(102, 'chat-b')).toBe(false);
```

In `test/mcp.test.ts`, start a real long-running `exec_command` under one attributed conversation, then call `write_stdin` from another authenticated request context and assert it continues the same session rather than returning an ownership denial.

- [ ] **Step 2: Run RED against the current WIP**

```bash
npx vitest run test/workspace.test.ts test/mcp.test.ts
```

Expected: current per-conversation WIP behavior fails the restored authority contract.

- [ ] **Step 3: Restore `execOwnershipDenied` to attribution-only semantics**

Implement:

```ts
export function execOwnershipDenied(processId: number, conversationId: string | null): boolean {
  void processId;
  void conversationId;
  return false;
}
```

Process existence remains the process manager's responsibility. Keep ownership maps for attribution and Compact & Resume transfer bookkeeping.

- [ ] **Step 4: Fix the stale model-facing denial copy in `write_stdin`**

The guard may remain for future policy hooks, but its failure text must not claim per-conversation authority. If `execOwnershipDenied` is false by current design, no normal authenticated call reaches that branch.

- [ ] **Step 5: Run GREEN**

```bash
npx vitest run test/workspace.test.ts test/mcp.test.ts
```

- [ ] **Step 6: Commit only terminal-authority hunks**

```bash
git add -p src/main/codex/ownership.ts src/main/mcp/tools-core.ts test/workspace.test.ts test/mcp.test.ts
git diff --cached -- src/main/codex/ownership.ts src/main/mcp/tools-core.ts test/workspace.test.ts test/mcp.test.ts
git commit -m "fix(core): restore authenticated terminal continuation"
```

---

### Task 2: Restore strict bridge protocol admission while retaining good telemetry

**Files:**
- Modify: `src/main/bridge.ts`
- Modify: `test/bridge.test.ts`

**Interfaces:**
- Existing `protocolCompatible(req)` remains the admission decision.
- `noteAgentTabTelemetry(req)` remains presentation-only and must never influence admission.

- [ ] **Step 1: Pin the known regression with the existing telemetry test**

Keep/restore the test named:

```text
keeps the last good agent-tab telemetry when later headers are partial, impossible, or protocol-incompatible
```

The incompatible request must assert HTTP `426`, while `browserAgentTabTelemetry()` remains equal to the earlier good snapshot.

- [ ] **Step 2: Add a focused table test for protocol headers**

Cases:

```ts
[
  { header: undefined, expected: 426 },
  { header: 'not-an-int', expected: 426 },
  { header: String(BRIDGE_PROTOCOL), expected: 200 },
  { header: String(BRIDGE_PROTOCOL - 1), expected: 426 },
  { header: String(BRIDGE_PROTOCOL + 1), expected: 426 }
]
```

Once Plan 2 bumps the protocol to 10, exact equality is the compatibility rule unless a specifically documented wire-compatible range is intentionally introduced.

- [ ] **Step 3: Make admission exact and independent from telemetry**

Replace permissive range admission:

```ts
return p === BRIDGE_PROTOCOL || (p !== null && p >= 7 && p <= 12);
```

with:

```ts
return extensionProtocol(req) === BRIDGE_PROTOCOL;
```

`noteAgentTabTelemetry` may ignore malformed telemetry and retain the last good snapshot, but request routing must evaluate protocol compatibility before serving protected semantics.

- [ ] **Step 4: Run bridge tests**

```bash
npx vitest run test/bridge.test.ts
```

- [ ] **Step 5: Commit protocol fence hunks**

```bash
git add -p src/main/bridge.ts test/bridge.test.ts
git diff --cached -- src/main/bridge.ts test/bridge.test.ts
git commit -m "fix(bridge): fail closed on protocol mismatch"
```

---

### Task 3: Make `config.allComputer` the sole All Computer authority

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/renderer/main.ts`
- Modify: `test/ipc.test.ts`
- Modify: `test/renderer-state.test.ts`
- Modify: `test/workspace.test.ts` only if root naming/state helpers are covered there.

**Interfaces:**
- Existing config fields remain:

```ts
allComputer?: boolean;
previousRoots?: Root[];
```

- Renderer authority helper becomes:

```ts
function isAllComputerActive(config: AppState['config']): boolean {
  return config.allComputer === true;
}
```

- [ ] **Step 1: Add failing renderer regression for partial drive removal**

Given `allComputer=false` and roots containing only `C:\`, assert the All Computer button is OFF and clicking it calls enable, not revoke.

- [ ] **Step 2: Add failing IPC transition tests**

Pin these transitions:

1. enable: save current roots once -> detect drives -> `allComputer=true`.
2. disable: restore snapshot -> clear `previousRoots` -> `allComputer=false`.
3. remove while active: filter root -> `allComputer=false` -> `previousRoots=[]`.
4. rename while active: rename -> exit mode -> `previousRoots=[]`.
5. add folder while active: append folder -> exit mode -> `previousRoots=[]`.
6. enable again after a manual edit snapshots the current edited roots, not an old pre-All-Computer snapshot.

- [ ] **Step 3: Make renderer use only the boolean authority**

Keep `isEntireDrivePath` only for drive icon/label presentation. Remove its use from active-mode inference.

- [ ] **Step 4: Normalize every root mutation to exit All Computer mode**

For `roots:add`, `roots:remove`, and `roots:rename`, when `config.allComputer === true`, return the mutated roots with:

```ts
allComputer: false,
previousRoots: []
```

Do not silently restore old roots on a manual mutation; the user's current root list is the new explicit permission state.

- [ ] **Step 5: Add explicit confirmation before enabling full-drive access**

In renderer `toggleAllComputer()`, before calling IPC when currently off:

```ts
const approved = window.confirm(
  'Share every detected computer drive with Chat On Steroids? This grants file access across those drives according to your enabled Core permissions.'
);
if (!approved) return;
```

Do not prompt on disable. Add renderer tests for cancel/no IPC and approve/IPC.

- [ ] **Step 6: Run All Computer tests**

```bash
npx vitest run test/ipc.test.ts test/renderer-state.test.ts test/workspace.test.ts
```

- [ ] **Step 7: Commit hunk-scoped state-machine changes**

```bash
git add -p src/main/ipc.ts src/renderer/main.ts test/ipc.test.ts test/renderer-state.test.ts test/workspace.test.ts
git diff --cached
git commit -m "fix(permissions): make all-computer state explicit"
```

---

### Task 4: Remove Turkish first-party behavior and copy

**Files:**
- Modify: `extension/content.js`
- Modify: `test/content-script.test.ts`
- Modify: any changed-scope source/test/doc file returned by the scan below.

**Interfaces:**
- No new runtime interface.
- Product heuristics become English/language-neutral only.

- [ ] **Step 1: Run an explicit Turkish-source scan**

Use:

```bash
rg -n -i "[\x{00e7}\x{00c7}\x{011f}\x{011e}\x{0131}\x{0130}\x{00f6}\x{00d6}\x{015f}\x{015e}\x{00fc}\x{00dc}]|\b(d[e]vam|h[a]ta|s[o]nsuz)\b" \
  extension src test docs CHANGELOG.md "Brain/AI OS/Handoffs/Current.md"
```

`Söhne` is a proper font family name and is not Turkish product copy; do not rename it.

- [ ] **Step 2: Remove Turkish decision/clarification/error heuristics from `content.js`**

Delete locale-specific regexes rather than translating them into another hidden Turkish policy. Keep English patterns and language-neutral DOM state/error signals.

- [ ] **Step 3: Remove legacy Turkish rollover markers**

Delete legacy localized rollover-prefix checks and any localized status/reason string. Plan 1 legacy-state cleanup must ignore/remove stale storage without inspecting locale-specific prose.

- [ ] **Step 4: Replace localized third-party fixtures with language-neutral or English fixtures**

The current Turkish “Too many requests” ChatGPT sample in `test/content-script.test.ts` should become an English external sample or be rewritten to assert structural error detection without depending on locale prose.

- [ ] **Step 5: Make first-party test names/comments English**

Only developer-authored text is in scope. Do not alter unrelated unicode test data such as `äöüß → — …` that exists specifically to verify encoding behavior.

- [ ] **Step 6: Run the scan again**

Expected: zero Turkish first-party hits in changed scope, excluding explicitly reviewed non-Turkish proper nouns/encoding samples.

- [ ] **Step 7: Run affected tests**

```bash
npx vitest run test/content-script.test.ts test/extension.test.ts test/exec.test.ts
```

- [ ] **Step 8: Commit English-only cleanup**

```bash
git add -p extension/content.js test/content-script.test.ts
git diff --cached
git commit -m "chore: make autonomous product copy English-only"
```

---

### Task 5: Eliminate non-product full-suite failures and classify true native-environment tests

**Files:**
- Modify only files proven by a failing deterministic test.
- Likely inspect: `test/computer.test.ts`, `test/computer-frame-bounds.test.ts`, `test/exec-output-budget-mcp.test.ts`, helper seams under `src/main/computer/` and test temp cleanup helpers.

**Interfaces:**
- No new product API unless a real defect is identified.

- [ ] **Step 1: Run full suite from the current verified branch state**

```bash
npm test
```

Capture exact failing test names and stack traces. Do not reuse the old 81-failure count as current evidence.

- [ ] **Step 2: Classify every failure into one of three buckets**

1. `PRODUCT_REGRESSION` — deterministic logic failure; must fix.
2. `TEST_HARNESS_REGRESSION` — test accidentally depends on a real desktop/temp race; replace with deterministic seam.
3. `TRUE_NATIVE_SMOKE` — intentionally requires a live Windows handle/UIA/capture environment; may be conditionally skipped only when that prerequisite is absent.

- [ ] **Step 3: Fix deterministic cleanup races**

For temp-directory `ENOTEMPTY` failures, prove whether a process/session still owns a file. Ensure tests stop/await the owned runtime before cleanup rather than adding arbitrary sleeps or recursive retries that could mask a leak.

- [ ] **Step 4: Isolate native helper tests from product logic tests**

When a test is intended to validate frame math, routing, or command construction, inject/mock the capture/UIA result rather than calling a live Windows helper. Keep one separately named native smoke test for actual helper integration and gate only that test on explicit helper availability.

- [ ] **Step 5: Re-run each repaired file individually**

Example:

```bash
npx vitest run test/computer.test.ts test/computer-frame-bounds.test.ts test/exec-output-budget-mcp.test.ts
```

- [ ] **Step 6: Re-run full suite**

```bash
npm test
```

Expected: all product/deterministic tests pass. Remaining skips, if any, are explicitly native-environment tests with their prerequisite named in the test.

- [ ] **Step 7: Commit each independent fix separately**

Use `git add -p` and one commit per root cause; do not bundle unrelated native test harness changes.

---

### Task 6: Final verification and live browser smoke

**Files:**
- No production changes unless verification exposes a defect.
- Modify `Brain/AI OS/Handoffs/Current.md` only after evidence is collected.

**Interfaces:**
- Validates all acceptance criteria from the spec.

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 2: Targeted critical suites**

```bash
npx vitest run \
  test/execution.test.ts \
  test/mcp.test.ts \
  test/bridge.test.ts \
  test/extension.test.ts \
  test/content-script.test.ts \
  test/agent-tab-lifecycle.test.ts \
  test/orchestration-store.test.ts \
  test/orchestration-workflow.test.ts \
  test/ipc.test.ts \
  test/renderer-state.test.ts \
  test/workspace.test.ts
```

- [ ] **Step 3: Full suite**

```bash
npm test
```

- [ ] **Step 4: Diff hygiene**

```bash
git diff --check
```

- [ ] **Step 5: English-only scan**

Run the Task 4 `rg` command again and review every remaining hit manually.

- [ ] **Step 6: Live remote-execution smoke**

From an authenticated phone/remote ChatGPT conversation, submit a harmless approved plan via `session action=execution_start`. Verify:

- durable run id returned,
- new desktop execution chat opens in Execution Window,
- plan sends once,
- Loop arms automatically,
- remote planning chat can close without stopping desktop execution,
- `execution_status`, pause, resume, stop all target only that run.

- [ ] **Step 7: Live exact-URL stall-recovery smoke**

Use a controlled test seam or deliberately suspended test generation rather than waiting for a random production stall. Verify the replacement tab receives the exact source URL, inherits Loop state, unrelated tabs cannot claim transfer, old tab remains until `recovery_ready`, and a post-recovery progress event resets the consecutive counter.

- [ ] **Step 8: Live managed worker smoke**

Spawn workers from the execution chat. Verify Agent Window separation and safe close only after sleeping/finished evidence.

- [ ] **Step 9: Update handoff with actual evidence**

Record exact commands, pass counts, any environment-only skips, bridge protocol version, and live smoke outcomes in `Brain/AI OS/Handoffs/Current.md`.

---

### Task 7: Prepare the upstream/original-project contribution

**Files:**
- Modify: `CHANGELOG.md`
- Modify: appropriate `docs/release-notes/` file or create the next release note only if the repository's release convention requires it.
- Read-only inspect: git remotes, branch history, final diff.

**Interfaces:**
- Produces a clean logical commit series and PR-ready branch; no runtime interface.

- [ ] **Step 1: Inspect remotes and contribution target**

```bash
git remote -v
git branch -vv
git log --oneline --decorate -20
```

Identify the original/upstream repository from actual configured remotes; do not guess from package metadata.

- [ ] **Step 2: Review every intended commit since the design commit**

```bash
git log --oneline 8beda07..HEAD
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
```

Exclude generated `Brain/AI OS/Sessions/...` files and unrelated pre-existing WIP from the contribution unless they are explicitly part of the approved feature and verified behavior.

- [ ] **Step 3: Add concise English release documentation**

Document only shipped behavior:

- remote plan -> durable desktop execution,
- managed Execution/Agent windows,
- exact-URL recovery and bounded consecutive recovery,
- safe worker-tab cleanup,
- terminal/bridge/All Computer corrections.

Do not claim tests or live behavior that were not actually verified in Task 6.

- [ ] **Step 4: Verify final contribution diff again**

```bash
git diff --check origin/main...HEAD
git status --short
```

The working tree may still contain unrelated user WIP, but the contribution commit range itself must not.

- [ ] **Step 5: Push only after verifying authenticated target and branch name**

If a writable fork/remote is already configured and authentication succeeds:

```bash
git push -u <writable-remote> <contribution-branch>
```

Do not force-push. If no writable remote/authentication exists, stop at a clean PR-ready local branch and report the exact limitation rather than modifying remotes without user authorization.

- [ ] **Step 6: Open a pull request only when repository tooling/authentication is available**

If `gh auth status` succeeds and the identified original repository accepts PRs, create a PR using the verified commit range. The PR body must contain Summary, Safety/identity invariants, Verification, and Known environment-only skips (if any). If `gh` is unavailable or unauthenticated, provide the ready branch/commit range instead of claiming submission.
