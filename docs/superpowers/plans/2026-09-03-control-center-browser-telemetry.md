# Control Center Browser Lease Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish exact extension-owned agent-tab lease/queue counts through the authenticated browser bridge and surface them in Control Center.

**Architecture:** `agent-tab-lifecycle.js` persists one normalized browser-session snapshot; `background.js` piggybacks it as bounded headers on existing authenticated bridge calls; `bridge.ts` validates and retains a RAM-only fresh snapshot; Control Center projects it without inference. No new bridge control endpoint is added.

**Tech Stack:** Chrome MV3 JavaScript, Electron/Node TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-control-center-browser-telemetry-design.md`

## Global Constraints

- Hard agent-tab budget remains exactly `5`.
- Never count or close unmarked user ChatGPT tabs for telemetry.
- App-side telemetry is RAM-only and authenticated-browser-derived.
- Missing/malformed/stale telemetry stays unavailable; never infer from Core queues.
- Bridge protocol moves from `8` to `9` on both sides.

---

### Task 1: Publish the authoritative browser-session snapshot

**Files:**
- Modify: `extension/agent-tab-lifecycle.js`
- Test: `test/agent-tab-budget.test.ts`

**Interfaces:**
- Produces storage key `agentTabLeaseTelemetry` with `{ budget: 5, used, queued, observedAt }`.

- [ ] **Step 1: Write the failing lifecycle telemetry tests**

Add assertions that after five marker-owned registrations plus one queued command, `chrome.storage.session` contains `{ budget: 5, used: 5, queued: 1 }`, and that adding an unmarked user ChatGPT tab does not change `used`.

- [ ] **Step 2: Run RED**

Run:

```powershell
npx vitest run test/agent-tab-budget.test.ts
```

Expected: telemetry assertions fail because no `agentTabLeaseTelemetry` snapshot exists.

- [ ] **Step 3: Implement the snapshot in the existing serialized persist path**

Add `TELEMETRY_KEY = 'agentTabLeaseTelemetry'` and include:

```js
agentTabLeaseTelemetry: {
  budget: MAX_AGENT_TABS,
  used: liveLeaseCount(),
  queued: queue.length,
  observedAt: Date.now()
}
```

in the same `chrome.storage.session.set()` operation that persists leases and queue, so the three values cannot describe different logical states.

- [ ] **Step 4: Run GREEN**

Run the same test file and require all tests green.

- [ ] **Step 5: Commit**

```powershell
git add extension/agent-tab-lifecycle.js test/agent-tab-budget.test.ts
git commit -m "feat: publish agent tab lease telemetry"
```

### Task 2: Piggyback validated telemetry on authenticated extension calls

**Files:**
- Modify: `extension/background.js`
- Modify: `src/main/version.ts`
- Test: `test/extension.test.ts`
- Test: protocol/version assertions already covering both halves

**Interfaces:**
- Consumes storage key from Task 1.
- Produces request headers `x-agent-tab-budget`, `x-agent-tabs-used`, `x-agent-tabs-queued`, `x-agent-tabs-observed-at`.

- [ ] **Step 1: Write failing extension transport tests**

Use the existing background test harness to seed `chrome.storage.session.agentTabLeaseTelemetry`, make one authenticated bridge call, and assert the four headers are present with exact string values. Add a malformed stored snapshot case and assert all four headers are omitted together.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run test/extension.test.ts
```

- [ ] **Step 3: Implement load/change tracking and header serialization**

`background.js` loads the snapshot during `loadOnce()`, updates it on `chrome.storage.onChanged` for `session`, validates all fields together, and merges telemetry headers into `call()` beside version/auth headers.

Bump extension-side `BRIDGE_PROTOCOL` from `8` to `9` and app-side `src/main/version.ts::BRIDGE_PROTOCOL` to `9`.

- [ ] **Step 4: Run GREEN plus protocol-adjacent tests**

```powershell
npx vitest run test/extension.test.ts test/bridge.test.ts test/packaging.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add extension/background.js src/main/version.ts test/extension.test.ts
git commit -m "feat: send agent tab telemetry over bridge"
```

### Task 3: Validate and retain telemetry in the authenticated bridge

**Files:**
- Modify: `src/main/bridge.ts`
- Test: `test/bridge.test.ts`

**Interfaces:**
- Produces exported `browserAgentTabTelemetry()` returning `{ budget: 5, used, queued, observedAt, receivedAt } | null` for fresh app-process state.

- [ ] **Step 1: Write failing bridge tests**

Add a real authenticated HTTP request carrying all four headers and assert the exported accessor returns the bounded snapshot. Add unauthenticated, partial, over-budget, and malformed-header cases and assert they cannot update the last good snapshot.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run test/bridge.test.ts
```

- [ ] **Step 3: Implement parser and RAM-only state**

After successful auth/protocol/rate-limit checks, parse the four headers as one unit. Accept only `budget === 5`, `0 <= used <= 5`, `0 <= queued <= 400`, and a finite positive `observedAt` not more than 60 seconds in the future. Store `receivedAt: Date.now()` locally. Reset it when bridge process state is reset/stopped/restarted.

Add the four header names to CORS `access-control-allow-headers`.

- [ ] **Step 4: Run GREEN**

```powershell
npx vitest run test/bridge.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add src/main/bridge.ts test/bridge.test.ts
git commit -m "feat: retain authenticated browser lease telemetry"
```

### Task 4: Project fresh telemetry into Control Center

**Files:**
- Modify: `src/shared/control-center.ts`
- Modify: `src/main/orchestration/control-center.ts`
- Test: `test/control-center.test.ts`
- Test: `test/control-center-renderer.test.ts`

**Interfaces:**
- Consumes `browserAgentTabTelemetry()` from Task 3.
- `ControlCenterBrowserStatus.status` becomes `'available' | 'unavailable'`.

- [ ] **Step 1: Write failing projection tests**

Cover a fresh snapshot projecting `{ budget: 5, used: 3, queued: 2, status: 'available', note: null }`, while no snapshot or an app-stale snapshot remains `{ used: null, queued: null, status: 'unavailable' }`.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run test/control-center.test.ts test/control-center-renderer.test.ts
```

- [ ] **Step 3: Implement projection**

Import the bridge accessor in `control-center.ts`. Use the existing browser-present/fresh evidence boundary and never derive values from orchestration/broker queues. Keep the renderer read-only and preserve current `used / budget` formatting.

- [ ] **Step 4: Run GREEN**

Run the same two files, then:

```powershell
npx vitest run test/agent-tab-budget.test.ts test/extension.test.ts test/bridge.test.ts test/control-center.test.ts test/control-center-renderer.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add src/shared/control-center.ts src/main/orchestration/control-center.ts test/control-center.test.ts test/control-center-renderer.test.ts
git commit -m "feat: show browser lease telemetry in Control Center"
```

### Task 5: Final verification

**Files:** none expected beyond prior tasks.

- [ ] **Step 1: Run typecheck and full suite**

```powershell
npm run typecheck
npm test
```

- [ ] **Step 2: Run production build and diff gate**

```powershell
npm run build
git diff --check
```

- [ ] **Step 3: Confirm branch state**

```powershell
git status -sb
git log -8 --oneline
```

Expected: clean `design/agent-system-3-0`, no push performed.
