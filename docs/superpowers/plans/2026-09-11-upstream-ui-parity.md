# Upstream UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the upstream 2.0.9 desktop shell and navigation while retaining every current 2.2.0 capability and authority boundary.

**Architecture:** Keep the current renderer panels and IDs as feature authority, but replace the permanent 2.2.0 dashboard rail with a two-mode upstream-style shell: Chat mode (conversation sidebar + session main area) and Settings mode (settings navigation + selected settings panel). `main-app.ts` owns shell-mode routing; `chat.ts`, `control-center.ts`, `plugins.ts`, and backend IPC semantics stay feature owners.

**Tech Stack:** Electron renderer, TypeScript, HTML/CSS, jsdom, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-upstream-ui-parity-design.md`

## Global Constraints

- Preserve current 2.2.0 Core/session/tool/security ownership; this is a renderer-shell port, not an upstream runtime rollback.
- Preserve current stable control IDs wherever possible.
- Keep one physical project checkout and branch `port/upstream-2.0.9`.
- Do not restore local Projects/sidebar grouping.
- Keep Control Center, Agent System 3.0, Plugins, Fleet/Devices, Persistent Core, browser/model discovery, Setup and Activity reachable.
- Default application posture is Chat mode, not Overview/Control dashboard mode.
- No horizontal scrolling at the supported default window size.
- Every production behavior change follows RED → GREEN → refactor.

---

### Task 1: Pin the upstream shell structure with failing layout tests

**Files:**
- Modify: `test/renderer-layout.test.ts`
- Modify: `src/renderer/index.html`

**Interfaces:**
- Produces stable shell anchors: `#sidebar`, `#sidebarSettings`, `#backToChat`, `#settingsNav`, existing `#sessionList`, existing `#sidebarToggle`, existing `#sidebarResize`, and the current panel `data-panel` names.
- Later tasks depend on the existing current IDs inside each feature panel remaining unchanged.

- [ ] **Step 1: Add RED structural tests**

Add a focused `describe('upstream-style application shell', ...)` that asserts:

```ts
it('starts with a conversation sidebar and keeps settings navigation separate', () => {
  const sidebar = document.getElementById('sidebar')!;
  expect(sidebar.querySelector('#newChat')).not.toBeNull();
  expect(sidebar.querySelector('#sessionList')).not.toBeNull();
  expect(sidebar.querySelector('#sidebarSettings')).not.toBeNull();
  expect(sidebar.querySelector('#settingsNav')).not.toBeNull();
  expect(document.querySelector('[data-panel="chat"]')).not.toBeNull();
});

it('retains every current 2.2.0 destination in the document', () => {
  for (const panel of ['home', 'control', 'chat', 'plugins', 'setup', 'activity']) {
    expect(document.querySelector(`[data-panel="${panel}"]`), panel).not.toBeNull();
  }
});
```

The first test must fail before HTML changes because the current rail has no upstream-style `#sidebar/#settingsNav` split.

- [ ] **Step 2: Run RED**

Run:

```text
npx vitest run test/renderer-layout.test.ts
```

Expected: the new shell test fails for missing structural anchors while existing layout tests remain runnable.

- [ ] **Step 3: Recompose `index.html` without deleting feature panels**

Create the upstream-style shell around the current panels:

- `<aside id="sidebar" class="sidebar">` owns brand, `#newChat`, conversation list, `#sidebarSettings`, `#backToChat`, `#settingsNav`, resize handle and bottom action.
- Move the existing `#sessionList`, `#sessionsEmpty`, and `#sessionsFoot` into the sidebar Chat-mode section; do not duplicate them.
- Keep the selected-session card/timeline inside `data-panel="chat"` as the main Chat content.
- Reuse the existing settings panels (`home`, `control`, `plugins`, `setup`, `activity`) without duplicating their controls.
- `#settingsNav` contains buttons for Workspace, Agents & automation, Plugins, Setup, Activity; Control Center is reachable under Agents & automation in Task 3.
- Keep current header connection/theme/update controls and current notice nodes.

- [ ] **Step 4: Run GREEN**

Run `npx vitest run test/renderer-layout.test.ts` and fix only structural regressions required by this task.

- [ ] **Step 5: Commit**

Commit: `feat(ui): restore upstream shell structure`

### Task 2: Restore upstream visual hierarchy and sidebar behavior

**Files:**
- Modify: `src/renderer/styles.css`
- Modify: `test/renderer-layout.test.ts`

**Interfaces:**
- Consumes Task 1 shell anchors.
- Produces visual contracts for `.sidebar`, `.sidebar-sessions`, `#settingsNav`, `.app.is-settings`, `.app.is-sidebar-collapsed`, header/main grid placement.

- [ ] **Step 1: Add RED CSS contract tests**

Assert the final CSS expresses the structural silhouette rather than exact colors:

```ts
it('gives the upstream sidebar the navigation column and main content the flexible column', () => {
  expect(rule('.app')).toContain('grid-template-columns: var(--sidebar-width');
  expect(rule('.sidebar')).toContain('grid-column: 1');
  expect(rule('.app > main')).toContain('grid-column: 2');
});

it('collapses the sidebar without hiding the main content', () => {
  expect(rule('.app.is-sidebar-collapsed')).toContain('--sidebar-width: 64px');
});
```

- [ ] **Step 2: Run RED**

Run `npx vitest run test/renderer-layout.test.ts` and confirm the new rules fail against the current dashboard-rail CSS.

- [ ] **Step 3: Implement upstream-derived presentation**

Replace the late `canvas workspace` rail override with styles adapted from `v2.0.9`:

- 220–240px default sidebar with persisted `--sidebar-width` and 64px collapsed width;
- upstream dark/light page/card/line hierarchy using current CSS variables;
- compact brand, New chat, conversation rows and Settings footer;
- settings-nav mode that occupies the same sidebar without changing main-panel authority;
- main header at column 2, notice at column 2, main at column 2;
- selected-session main area gets the dominant flexible region;
- current Control Center canvas styles remain intact below its feature selectors;
- keep all existing no-horizontal-overflow rules and session-card explicit grid tracks.

- [ ] **Step 4: Run GREEN**

Run:

```text
npx vitest run test/renderer-layout.test.ts test/control-center-renderer.test.ts
```

- [ ] **Step 5: Commit**

Commit: `feat(ui): match upstream desktop hierarchy`

### Task 3: Add Chat/Settings shell routing without losing 2.2.0 destinations

**Files:**
- Modify: `src/renderer/main-app.ts`
- Modify: `src/renderer/chat.ts` only if a public selection helper is needed
- Modify: `test/renderer-state.test.ts`
- Modify: `test/renderer-layout.test.ts`

**Interfaces:**
- Produces `showShellMode(mode: 'chat' | 'settings')` or an equivalently named private function in `main-app.ts`.
- Existing panel router continues to choose `home | control | chat | plugins | setup | activity`; shell mode only decides whether Chat sidebar or Settings navigation is visible.

- [ ] **Step 1: Add RED state tests**

Cover these real behaviors in the existing renderer harness:

```ts
it('opens in Chat mode and preserves the selected session across Settings round-trip', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  expect(doc.querySelector('.app')!.classList.contains('is-settings')).toBe(false);
  (doc.getElementById('sidebarSettings') as HTMLButtonElement).click();
  expect(doc.querySelector('.app')!.classList.contains('is-settings')).toBe(true);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  expect(doc.querySelector('.app')!.classList.contains('is-settings')).toBe(false);
});
```

Add navigation coverage proving Workspace, Plugins, Setup, Activity and Control Center remain reachable after entering Settings.

- [ ] **Step 2: Run RED**

Run `npx vitest run test/renderer-state.test.ts test/renderer-layout.test.ts` and confirm failure is shell-routing absence.

- [ ] **Step 3: Implement routing**

In `main-app.ts`:

- startup defaults to Chat mode after state bootstrap unless the existing missing-setup flow explicitly sends the user to Setup;
- `#sidebarSettings` enters Settings and selects the last settings panel, default `home`;
- `#backToChat` returns to Chat without changing `selectedId` or chat view;
- settings nav buttons call the existing panel router;
- `Agents & automation` selects the existing automation/settings destination and exposes a clear `Open Control Center` action that routes to `control`;
- header title/subtitle changes by shell mode without duplicating connection controls;
- collapsed/resized sidebar state works in both modes.

- [ ] **Step 4: Run GREEN**

Run:

```text
npx vitest run test/renderer-state.test.ts test/renderer-layout.test.ts test/control-center-renderer.test.ts test/plugins-ui.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 5: Commit**

Commit: `feat(ui): route upstream chat and settings modes`

### Task 4: Preserve current features and verify the integrated renderer

**Files:**
- Modify only if a focused regression proves a missing link.
- Test: existing renderer/control/plugin/session suites.

**Interfaces:**
- No new backend interfaces.
- Completion requires all current 2.2.0 surfaces to remain reachable through the restored shell.

- [ ] **Step 1: Run the focused feature-preservation matrix**

Run:

```text
npx vitest run test/renderer-layout.test.ts test/renderer-state.test.ts test/timeline-scroll.test.ts test/session-list-refresh.test.ts test/control-center-renderer.test.ts test/plugins-ui.test.ts test/renderer-browser-models.test.ts test/browser-preferences.test.ts
```

If a test name does not exist on this branch, replace it with the existing focused suite for that module; do not invent a second harness.

- [ ] **Step 2: Verify static gates**

Run:

```text
npm run typecheck
git diff --check
```

- [ ] **Step 3: Run full renderer/application CI gate**

Run the repository's exact `npm run verify:ci`. Do not weaken or skip tests to make the shell pass.

- [ ] **Step 4: Build and visually inspect**

Run `npm run build`, launch the development/packaged renderer using the repository's existing safe workflow, and verify against the user's upstream screenshot:

- conversation sidebar silhouette;
- compact dark header and connection state;
- Settings mode/back-to-chat transition;
- all 2.2.0 feature destinations remain reachable;
- no clipped primary controls at the default window size.

- [ ] **Step 5: Commit any regression-only fixes**

Commit: `test(ui): verify upstream shell parity`
