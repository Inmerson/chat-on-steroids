# Trust Boundary Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce fresh-install authority and harden durable credential/update boundaries without changing Chat On Steroids' small MCP architecture.

**Architecture:** Keep existing Core/Desktop authority separation and file sandboxing intact. Make conservative defaults and truthful UI copy explicit at the edges, factor recorder redaction into one recursive sanitizer, and constrain Windows update handoff to the proven per-user NSIS path while correcting the installer ACL command quoting.

**Tech Stack:** Electron 43, TypeScript, Vitest, electron-builder NSIS, Node.js.

**Spec:** `docs/superpowers/specs/2026-09-05-trust-boundary-hardening-design.md`

## Global Constraints

- Work only in `.worktrees/trust-boundary-hardening-20260905` on `feat/trust-boundary-hardening-20260905`.
- Preserve existing persisted user choices; only genuinely fresh/missing config receives the new restricted default.
- Do not add a command blocklist or describe approved folders as an OS containment boundary.
- Do not add URL/network authority to local file tools.
- Do not merge, push, publish, install the candidate, or alter the dirty primary checkout.
- Strict TDD: add a failing behavioral test, observe the expected failure, then edit production code.

---

### Task 1: Restricted Fresh-Install Defaults

**Files:**
- Modify: `test/config.test.ts`
- Modify: `src/main/config.ts`

**Interfaces:**
- Consumes: `DEFAULT_CAPABILITIES` from `src/shared/types.ts`.
- Produces: `defaultConfig()` and the missing-config path in `loadConfig()` return a restricted config: safe capabilities, `readOnly: true`, `multiAgent.enabled: false`.

- [ ] **Step 1: Write the failing tests**

Replace the permissive fresh-install assertions so they require `DEFAULT_CAPABILITIES`, read-only mode, and multi-agent off, while retaining the legacy-config tests that prove explicit old choices survive migration.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/config.test.ts`

Expected: fresh-install/default tests fail because current `defaultConfig()` enables portable capabilities, returns `readOnly: false`, and enables multi-agent.

- [ ] **Step 3: Implement the minimal default change**

In `defaultConfig(platform)`, use a fresh copy of `DEFAULT_CAPABILITIES`; do not auto-enable capabilities from `CAPABILITIES`. Set `readOnly: true` and `multiAgent.enabled: false`. Leave session recording and unrelated defaults unchanged. Do not alter `mergeRawConfig()` migration semantics beyond what the new default requires.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run test/config.test.ts`

Expected: pass.

- [ ] **Step 5: Commit the task**

Commit message: `fix(config): restrict fresh-install authority`

---

### Task 2: Recursive Session Credential Redaction

**Files:**
- Create: `src/main/session/redaction.ts`
- Modify: `src/main/session/recorder.ts`
- Modify: `test/session.test.ts`

**Interfaces:**
- Produces: `sanitizeRecordedValue(value: unknown): unknown` and `sanitizeComputerActions(value: unknown): unknown`.
- Recorder consumes those functions before snapshotting durable tool-call arguments.

- [ ] **Step 1: Write failing sanitizer and integration tests**

Test a nested object/array with mixed-case versions of `authorization`, `token`, `access_token`, `refresh_token`, `password`, `passwd`, `api_key`, `apikey`, `secret`, `cookie`, `set-cookie`, and `client_secret`. Every sensitive value must become `[redacted]`; ordinary fields such as path, exit code, index and nested labels must survive. Add a `recordToolCall()` integration assertion that persisted args contain no supplied secret literals. Retain clipboard redaction coverage.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/session.test.ts -t "redact|credential|secret"`

Expected: new credential-key cases fail because the current recorder recognizes only the smaller historical set and the new module does not exist yet.

- [ ] **Step 3: Implement the focused redaction module**

Move recursive key redaction and computer clipboard-action sanitation into `src/main/session/redaction.ts`. Match sensitive keys case-insensitively by lowercasing the complete property name. Do not redact arbitrary string content by pattern. Import the module from `recorder.ts` and remove the duplicate private policy there.

- [ ] **Step 4: Verify GREEN and recorder compatibility**

Run: `npx vitest run test/session.test.ts`

Expected: pass.

- [ ] **Step 5: Commit the task**

Commit message: `fix(session): redact nested credential fields`

---

### Task 3: Truthful Terminal Authority Copy

**Files:**
- Modify: `test/renderer-layout.test.ts` or the nearest renderer static-contract test that already reads `src/renderer/index.html`
- Modify: `src/renderer/index.html`

**Interfaces:**
- Preserves: `CAPABILITY_DETAILS.command = 'Run anything as you. NOT limited to approved folders.'`
- Produces: setup wizard copy that explicitly limits the approved-folder claim to file tools and discloses OS-user terminal scope.

- [ ] **Step 1: Add a failing copy contract**

Assert that the folder setup step contains both concepts: `File tools` are limited to approved folders, and terminal/command execution is not limited to those folders. Also assert the old unconditional sentence `Nothing outside the folders you approve is reachable.` is absent.

- [ ] **Step 2: Verify RED**

Run the focused renderer test file.

Expected: fail on the current unconditional folder-boundary copy.

- [ ] **Step 3: Replace only the misleading sentence**

Use concise copy equivalent to: `File tools can reach only the folders you approve. Terminal commands, if you enable Run commands, run as your OS user and are not limited to those folders.` Keep the rest of setup flow unchanged.

- [ ] **Step 4: Verify GREEN**

Run the same renderer test file and relevant renderer-state/layout tests.

- [ ] **Step 5: Commit the task**

Commit message: `fix(ui): disclose terminal authority boundary`

---

### Task 4: Deterministic Windows Current-User Update Handoff

**Files:**
- Modify: `test/update.test.ts`
- Modify: `test/packaging.test.ts`
- Modify: `src/main/update.ts`
- Modify: `scripts/windows-installer-acl.nsh`

**Interfaces:**
- Windows staged installer invocation becomes `/S /currentuser --updated` plus optional `--force-run`.
- ACL macro retains fail-closed `ExecWait` exit handling but uses valid NSIS command quoting.

- [ ] **Step 1: Add failing updater and packaging contracts**

Add an updater test named for the old-machine-wide-install regression that expects `/currentuser`. Update/add the packaging assertion to require exactly:

`ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q' $0`

as NSIS source text, with no backslash-escaped quote form around that command.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run test/update.test.ts test/packaging.test.ts`

Expected: updater contract fails because `/currentuser` is absent; packaging contract fails because the ACL command still contains backslash-escaped quotes.

- [ ] **Step 3: Implement minimal updater and NSIS fixes**

Change the Windows installer argument array to begin `['/S', '/currentuser', '--updated']`. Preserve `--force-run` ordering after `--updated`. Replace only the malformed `ExecWait` command string in `windows-installer-acl.nsh`; retain all ACL target, SID, error and abort logic.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run test/update.test.ts test/packaging.test.ts`

Expected: pass.

- [ ] **Step 5: Commit the task**

Commit message: `fix(update): force per-user Windows handoff`

---

## Deferred gate: exact agent health

No implementation task is created against `origin/main` because this base has no agent-health engine. When that subsystem lands, add the regression `missing exact worker conversation + unrelated global browser presence => degraded/not healthy` before changing its evaluator/bridge evidence logic.

## Final verification

- [ ] Run `npm run typecheck`.
- [ ] Run `npx vitest run test/config.test.ts test/session.test.ts test/renderer-layout.test.ts test/renderer-state.test.ts test/update.test.ts test/packaging.test.ts`.
- [ ] Run `npm test -- --run`.
- [ ] Run `git diff --check`.
- [ ] Inspect `git status --short --branch` and commit history. Do not merge or push.
