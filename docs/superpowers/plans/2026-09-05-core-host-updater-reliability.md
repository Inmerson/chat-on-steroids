# Core Host Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple ChatGPT Core execution from the Electron UI lifetime, make connection status prove end-to-end execution readiness, and hand Windows updates to NSIS only after the old UI process has exited.

**Architecture:** A non-UI Electron Core Host owns MCP/tunnel/tool execution and publishes a typed local IPC status/command protocol. An independent supervisor ensures exactly one healthy host with bounded exponential restart. The renderer/main UI becomes an IPC client. A centralized health arbiter is the sole authority for `CONNECTED`. Windows updates use explicit installation ownership detection and a PID-wait handoff helper; explicit installs are visible.

**Tech Stack:** Electron 43, TypeScript, Node.js child processes/net IPC, MCP SDK, Vitest, electron-vite/electron-builder, Windows NSIS.

**Spec:** `docs/superpowers/specs/2026-09-05-core-host-updater-reliability-design.md`

## Global Constraints

- Preserve existing MCP surface/security behavior and endpoint token protections.
- Do not log tool arguments, MCP secret path tokens, API keys, or decrypted credentials.
- Preserve ordinary MCP request draining; never replay an ambiguous mutating operation.
- UI quit/restart/reload must not imply Core disconnect.
- Explicit Windows Install Update must never directly spawn the visible installer from the still-running Electron UI process.
- `app.isPackaged` alone is not proof of an installed NSIS application.
- `utilityProcess` is not an acceptable Core lifetime owner because it is parent-owned.
- Existing tunnel supervision stays authoritative for tunnel-client process health; overall connection readiness is a separate arbiter.

---

### Task 1: Pure connection-health arbiter and execution retry policy

**Files:**
- Create: `src/main/core/health.ts`
- Create: `src/main/core/retry.ts`
- Create: `test/core-health.test.ts`

**Interfaces:**
- Produces `CoreHealthSnapshot`, `CoreHealthEvent`, `reduceCoreHealth()`, `overallConnectionState()`.
- Produces `toolRetryPolicy(toolName)` returning `never | one-safe-retry`.

- [ ] Write failing tests for remote healthy + local dead, ping/transport healthy + tool probe failed, reconnecting transitions, local recovery to Connected, auth-required precedence, generation monotonicity, and retry classification.
- [ ] Run `npm test -- --run test/core-health.test.ts` and confirm RED because the modules do not exist.
- [ ] Implement the minimal pure reducer/classifier.
- [ ] Re-run the targeted test and confirm GREEN.

### Task 2: Core supervisor single-flight and backoff

**Files:**
- Create: `src/main/core/supervisor.ts`
- Create: `test/core-supervisor.test.ts`

**Interfaces:**
- `CoreSupervisor` consumes an injected `CoreProcessAdapter` (`probe`, `spawn`, `waitForExit`, `stop`) and clock/scheduler seams.
- `ensureHost(reason)` is single-flight.
- Backoff sequence: `2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 180_000` ms cap.

- [ ] Write failing tests: UI detach does not stop host, reopen attaches existing host, crash restarts, crash loop backs off, two concurrent triggers spawn once, healthy interval resets attempts, stale PID without healthy IPC does not block recovery.
- [ ] Run targeted tests and confirm RED.
- [ ] Implement minimal supervisor state machine.
- [ ] Run targeted tests and confirm GREEN.

### Task 3: Core IPC protocol and version compatibility

**Files:**
- Create: `src/shared/core-protocol.ts`
- Create: `src/main/core/ipc.ts`
- Create: `test/core-ipc.test.ts`

**Interfaces:**
- `CORE_PROTOCOL_VERSION = 3`.
- `CoreHello`, `CoreCommand`, `CoreEvent`, `CoreStatusEnvelope`.
- `isCoreCompatible(uiProtocol, hello)`.
- IPC server/client uses a user-scoped local endpoint and never transmits secrets.

- [ ] Write RED tests for protocol handshake, compatible patch/minor mismatch, incompatible protocol, stale generation discard, single-host bind/attach behavior.
- [ ] Implement protocol types and bounded local IPC request framing.
- [ ] Run targeted tests GREEN.

### Task 4: Extract Core runtime ownership from Electron UI

**Files:**
- Create: `src/main/core/runtime.ts`
- Create: `src/main/core/host-entry.ts`
- Create: `src/main/core/supervisor-entry.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/connection.ts`
- Modify: `electron.vite.config.ts`
- Test: `test/connection.test.ts`, `test/core-lifecycle.test.ts`, `test/mcp-shutdown.test.ts`

**Interfaces:**
- Core Host initializes userData config/secrets/durable services required by Core, owns `connection.ts`, and serves status over IPC.
- UI mode obtains connection state/commands through Core IPC instead of directly owning endpoint/tunnel.
- Helper modes bypass the UI single-instance lock and do not create BrowserWindow/tray.

- [ ] Write RED lifecycle regressions: UI shutdown leaves host alive; new UI attaches existing host; explicit Disconnect unpublishes but does not conflate with UI quit.
- [ ] Extract runtime bootstrap without duplicating execution/session process managers.
- [ ] Route UI connect/disconnect/status through IPC.
- [ ] Preserve system-shutdown and explicit Core-stop semantics.
- [ ] Run lifecycle + MCP shutdown tests GREEN.

### Task 5: End-to-end MCP probe and transport recovery integration

**Files:**
- Create: `src/main/core/probe.ts`
- Modify: `src/main/mcp/server.ts`
- Modify: `src/main/connection.ts`
- Modify: `src/main/tunnel/index.ts` only where an additional typed report is needed
- Test: `test/core-health.test.ts`, `test/connection.test.ts`, `test/tunnel.test.ts`

**Interfaces:**
- `probeMcpTools(endpoint, timeoutMs=3_000)` executes MCP `tools/list` through the real local endpoint with the self-test marker.
- Probe failure emits a health event and enters single-flight recovery.

- [ ] RED: transport connected + probe timeout cannot be Connected; probe success restores Connected; stale transport proof triggers fresh recreation; generation increments.
- [ ] Implement bounded probe scheduler and arbiter wiring.
- [ ] Confirm self-test does not update ChatGPT `lastRequestAt`.
- [ ] Run targeted tests GREEN.

### Task 6: Request lifecycle observability and safe execution recovery

**Files:**
- Create: `src/main/core/request-lifecycle.ts`
- Modify: `src/main/mcp/server.ts`
- Modify: `src/main/mcp/kernel.ts`
- Modify: `src/main/logger.ts`
- Test: `test/mcp-inbound.test.ts`, `test/core-request-lifecycle.test.ts`

**Interfaces:**
- Canonical request id is preserved from `x-request-id` or internally generated for logs.
- `logRequestPhase(requestId, generation, phase, fields)` supports `receivedByCore`, `forwardedToLocalMcp`, `localMcpCompleted`, `responseSent`.

- [ ] RED: request ID propagates, generation included, stale generation response cannot update new connection state, safe read-only retry at most once after proven pre-execution failure, mutating tools never auto-retry.
- [ ] Implement lifecycle events with argument redaction-by-omission.
- [ ] Run targeted tests GREEN.

### Task 7: Windows installation ownership and updater handoff policy

**Files:**
- Create: `src/main/update/windows-installation.ts`
- Create: `src/main/update/handoff-policy.ts`
- Modify: `src/main/update.ts`
- Modify: `test/update.test.ts`

**Interfaces:**
- `ownsWindowsInstallation(execPath)` checks the adjacent electron-builder uninstaller.
- `windowsInstallPlan({ explicit, ownsInstallation })` returns installer args/visibility or no-op.

- [ ] RED: true install explicit => assisted visible upgrade with `--updated`; preview explicit => visible fresh install without `--updated`; ordinary preview quit => no installer; ordinary true install => silent `/S --updated`.
- [ ] Implement pure ownership/argument policy.
- [ ] Run update tests GREEN.

### Task 8: PID-wait updater handoff helper

**Files:**
- Create: `src/main/update/handoff.ts`
- Create: `src/main/update/handoff-entry.ts` (or a native-helper integration point if the release pipeline provides the binary)
- Modify: `src/main/update.ts`
- Modify: `src/main/index.ts`
- Modify: `electron.vite.config.ts`
- Modify: `electron-builder.yml`
- Test: `test/update-handoff.test.ts`, `test/update.test.ts`, `test/shutdown.test.ts`

**Interfaces:**
- UI starts hidden helper with old UI PID and validated installer plan.
- Helper waits until PID is gone before installer spawn.
- Explicit installer spawn has `windowsHide:false`; helper may be hidden.

- [ ] RED: explicit install never directly spawns installer from UI path; helper waits PID; installer appears only after exit; Core is not stopped unless compatibility/file-lock policy requires it.
- [ ] Implement helper with argv-safe/no-shell interpolation.
- [ ] Run targeted tests GREEN.

### Task 9: Layered connection UI

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Test: `test/renderer-state.test.ts`, `test/ipc.test.ts`

**Interfaces:**
- Renderer receives `CoreHealthSnapshot` and renders overall state plus Core/transport/auth/local-MCP/tool-execution detail.

- [ ] RED: remote live + local execution dead does not render Connected; reconnecting renders correctly; details reflect snapshot.
- [ ] Implement minimal status rendering without exposing sensitive data.
- [ ] Run renderer/IPC tests GREEN.

### Task 10: Verification and Windows package smoke

**Files:**
- Modify docs/comments only if actual behavior changed from current architecture guide.

- [ ] Run targeted new suites.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run verify` / repository CI-equivalent gate.
- [ ] Run `npm run build`.
- [ ] Run Windows x64 unpacked packaging and true NSIS packaging.
- [ ] Smoke A: close UI, prove Core process remains, invoke Core tool, reopen UI/attach.
- [ ] Smoke B: kill Core Host, prove supervisor restart/backoff/status recovery.
- [ ] Smoke C: interrupt remote transport, prove fresh recreation and same-chat recovery where upstream session remains valid.
- [ ] Smoke D: staged explicit update, prove helper waits old UI PID, visible NSIS, correct installed-vs-preview args, compatible Core continuity or one controlled reconnect.
- [ ] Run `git diff --check` and inspect final diff for unrelated shared-tree changes.
