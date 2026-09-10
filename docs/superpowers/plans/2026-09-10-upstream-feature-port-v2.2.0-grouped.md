# Chat On Steroids 2.2.0 Grouped Upstream Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining selective upstream feature port as four large, reviewable tranches and release it locally as Chat On Steroids 2.2.0.

**Architecture:** Preserve the fork's 2.1.4 Core/orchestration/multi-device architecture and adapt only missing upstream capabilities. Existing 2.1.5 detailed plans remain the file-level implementation references; this grouped plan changes the execution/review granularity, not the protected architecture.

**Tech Stack:** Electron 43.4.1, TypeScript, electron-vite, Vitest, MCP v2 packages, Windows packaging via electron-builder/NSIS.

**Spec:** `docs/superpowers/specs/2026-09-10-upstream-feature-port-v2.2.0-design.md`

## Global Constraints

- Target release is **2.2.0**; do not bump `package.json` or companion version fields before Tranche 4.
- Do not merge, rebase, reset, or wholesale cherry-pick `origin/main`.
- Preserve persistent Core, Agent System 3.0, Manager, Control Center, Infinite Loop, five-tab/browser ownership, terminal continuation, 2.1.4 multi-device/device registry/`device_id`, updater lineage, privacy and sandbox/capability boundaries.
- Renderer/preload additions may expose only explicit bounded methods; no new direct Node/filesystem/network authority in renderer.
- No public push, tag, GitHub release or installer publication.
- Production behavior changes require RED → GREEN evidence; classification-only skips require exact source/test evidence.

---

### Task 1: Workspace & Input tranche

**Consumes detailed plans:**
- `docs/superpowers/plans/2026-09-09-v2.1.5-browser-model-discovery.md`
- `docs/superpowers/plans/2026-09-09-v2.1.5-attachments-artifacts.md`
- `docs/superpowers/plans/2026-09-09-v2.1.5-ui-workspace.md`

**Scope:** Browser preference/candidates/startup/wake/layout, live model discovery/picker, typed file/image input and startup/history plumbing, artifact target/fetch/download, transcript file/image/artifact rendering, collapsible/resizable workspace and missing upstream renderer refinements.

- [ ] **Step 1: Classify before editing.** For every historical task in the three plans, write `ALREADY_PORTED`, `NEEDS_PORT`, `SUPERSEDED` or `REJECT` with exact fork/upstream file evidence in `docs/superpowers/reports/2026-09-10-v2.2.0-delta-audit.md`.
- [ ] **Step 2: Add RED tests only for `NEEDS_PORT`.** Reuse the named tests in the detailed plans; add no duplicate implementation for `ALREADY_PORTED` behavior.
- [ ] **Step 3: Implement the minimal fork-native ports.** Adapt into existing browser ownership, Core/session/preload and `main-app.ts`; never replace those fork subsystems wholesale.
- [ ] **Step 4: Run the combined tranche gate.** At minimum run all new browser/model/input/artifact/UI tests plus `test/browser.test.ts`, `test/window-layout.test.ts`, `test/renderer-layout.test.ts`, `test/renderer-state.test.ts`, `test/session.test.ts`, `test/mcp.test.ts`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] **Step 5: Commit one reviewable tranche commit** using the privacy-safe commit identity.

---

### Task 2: Runtime Resilience tranche

**Consumes detailed plans:**
- `docs/superpowers/plans/2026-09-09-v2.1.5-recovery-lifecycle.md`
- `docs/superpowers/plans/2026-09-09-v2.1.5-platform-hardening.md`

**Scope:** `destinationLost`, request/turn attribution, project/blocked/open-turn recovery, helper provenance, compatible browser/tunnel lifecycle ownership, multilingual access-limit classification, RTL, Windows `uv`, modern MCP JSON, swapped mouse, Brave/readiness and test-only packaging determinism.

- [ ] **Step 1: Extend the delta audit** with exact commit/file classification for every recovery/platform candidate.
- [ ] **Step 2: Add RED regressions only for missing behavior**; test-only upstream hardening may be imported as tests when fork behavior is already correct.
- [ ] **Step 3: Implement compatible ports** one subsystem at a time inside the tranche, preserving fork lifecycle ownership and multi-device semantics.
- [ ] **Step 4: Run the combined resilience gate.** Include `test/bridge.test.ts`, `test/continuation.test.ts`, `test/agents.test.ts`, `test/tunnel.test.ts`, `test/browser.test.ts`, `test/platform.test.ts`, `test/computer-swapped-buttons.test.ts`, `test/mcp.test.ts`, protected orchestration/Core suites, typecheck, build and diff-check.
- [ ] **Step 5: Commit one reviewable tranche commit** using the privacy-safe identity.

---

### Task 3: Upstream Delta Closure tranche

**Scope:** Refresh `origin/main` after Tasks 1–2 and close only the delta that appeared during implementation or was missed by earlier classification.

- [ ] **Step 1: Fetch without integrating history:** `git fetch origin main`.
- [ ] **Step 2: Compare the new `origin/main` with the audit baseline** and append each new upstream commit to the audit report.
- [ ] **Step 3: For each new candidate, classify `ALREADY_PORTED / NEEDS_PORT / SUPERSEDED / REJECT` before editing.**
- [ ] **Step 4: TDD-port only `NEEDS_PORT` changes** and rerun the affected focused suites plus protected Core/orchestration/multi-device tests.
- [ ] **Step 5: Commit audit/closure changes** as one tranche; if there is no code delta, commit only the completed audit report.

---

### Task 4: 2.2.0 Finalization tranche

**Consumes:** `docs/superpowers/plans/2026-09-09-v2.1.5-release-integration.md`, retargeted by the 2.2.0 spec.

- [ ] **Step 1: Run the structural preservation gate before version bump.** Confirm Core Host/supervisor, Agent System 3.0, Manager/Control Center, durable exec, Infinite Loop, five-tab/worker lifecycle, updater lineage, Plugins connector, multi-device registry/transport and `device_id` routing are still present and covered by tests.
- [ ] **Step 2: Run all subsystem focused suites and `npm run verify:ci` while version is still 2.1.4.** Fix failures systematically; do not version-bump over a red tree.
- [ ] **Step 3: Add RED release-version expectations for 2.2.0**, then update `package.json`, lockfile, extension/companion/version constants required by existing release tests.
- [ ] **Step 4: Write `CHANGELOG.md` 2.2.0 entry and `docs/release-notes/v2.2.0.md`.** State selective upstream porting, Plugins, browser/model/input/artifacts/UI/recovery/platform changes, protected fork architecture and platform/signing caveats accurately.
- [ ] **Step 5: Run fresh exact-HEAD verification:** privacy, notices, typecheck, complete Vitest/main+shutdown, `npm run build`, `git diff --check`.
- [ ] **Step 6: Build local Windows x64 package:** `npm run dist:x64`; inspect installer/unpacked file/product versions and Authenticode status. Do not claim signatures that are absent.
- [ ] **Step 7: Final handoff only.** Report exact commit, test counts, package paths/hashes/version/signature status. Do not push/tag/publish without separate explicit authorization.
