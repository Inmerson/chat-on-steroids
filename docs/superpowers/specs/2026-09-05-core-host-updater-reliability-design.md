# Persistent Core Host and Updater Reliability Design

## Status

Design based on a live connector failure reproduced on 2026-09-05 and the current `main` implementation. This document is intentionally architectural: the failure crosses process lifetime, tunnel health, MCP execution readiness, updater handoff, and UI status.

## Root-cause report

### Observed architecture

Today the Electron main process owns all of these lifetimes directly:

1. the loopback MCP HTTP server (`src/main/mcp/server.ts`),
2. the OpenAI/cloudflared tunnel child (`src/main/tunnel/index.ts`),
3. the connection state projection (`src/main/connection.ts`),
4. the renderer/tray connection status,
5. final shutdown (`src/main/index.ts`), and
6. update installer handoff (`src/main/update.ts`).

The current process graph is therefore effectively:

```text
Chat On Steroids.exe (Electron main)
├─ renderer
├─ MCP HTTP listener (in-process)
├─ tunnel-client/cloudflared child
├─ extension bridge (in-process)
└─ local tool/runtime children
```

`connection.ts` serializes connect/disconnect and already uses a connection generation to invalidate reports from replaced tunnels. `tunnel/index.ts` already supervises the OpenAI tunnel child with readiness checks, poll-freshness checks, restart backoff, and network-outage classification. Those defenses are useful and must be retained.

The state model is still transport-centric. A tunnel report can write top-level `state: 'connected'`; there is no authoritative execution-health arbiter containing process health, local MCP readiness and a real tool-plane probe.

### Reproduction

Two independent failure classes were reproduced or proved from current behavior:

1. **Control plane / data plane divergence in this ChatGPT conversation.** The Chat On Steroids Core execution tools were invokable at the start of the investigation. Later in the same conversation, ChatGPT's plugin-management surface still reported Chat On Steroids Core as installed and `ENABLED`, while the Core execution namespace was no longer invokable. This establishes the required distinction: connector/tool metadata can remain present while the actual execution plane is unavailable.
2. **Update shutdown deterministically destroys the connector runtime.** Current `will-quit` teardown invokes `shutdownConnection()`, which stops the MCP endpoint and tunnel before the updater handoff. This is not an intermittent race: the current lifecycle explicitly couples Core availability to Electron main-process lifetime.

The updater contains a separate deterministic race. `applyStagedUpdate()` is called inside the Electron shutdown sequence and directly spawns the Windows NSIS installer before the sequence calls `app.exit(0)`. The installer therefore races the still-running application. It also treats every `app.isPackaged` Windows executable as an installed NSIS application, which incorrectly includes `release/win-unpacked/...` previews.

### Evidence

Current code establishes the following causal chain:

```text
UI/app quit
  -> Electron will-quit
  -> shutdownConnection()
  -> endpoint.stop(...)
  -> tunnel.stop()
  -> top-level status = disconnected
  -> applyStagedUpdate()
  -> installer spawned while Electron is still alive
  -> app.exit(0)
```

Current regression tests encode the same contract: final shutdown force-drains the MCP endpoint and makes further `connect()` calls terminal. The desired behavior (`UI closes while Core stays available`) therefore requires an ownership change, not another reconnect timeout.

The DesktopCommanderMCP reference confirms why transport-only health is insufficient. Its issue #633 demonstrates `online` + valid auth + `pong` while forwarded execution tools return `Not connected`; `ping` is handled without crossing its local stdio MCP execution path. Issue #660 demonstrates a second class where an individual request can disappear before reaching the remote agent even though adjacent calls work. The useful defensive patterns are heartbeat freshness, stuck-join detection, fresh transport recreation, single-flight recovery, auth recovery, and generation-scoped state. The failure to copy is a single `online` flag that does not prove local execution.

### Root cause

The primary root cause is **lifetime and authority conflation**: the Electron UI/main process is both the user interface shell and the owner of the remote MCP execution service. Consequently a UI/process/update lifecycle transition is also a connector lifecycle transition.

The secondary root cause is **health conflation**: transport reachability is permitted to write the same top-level state the UI interprets as connection readiness. A healthy tunnel is therefore stronger evidence in the state model than it should be.

The updater root cause is **handoff ordering**: an executable installer is launched from the process whose executable tree it is about to replace, before that process has actually exited.

### Secondary contributing factors

- `app.isPackaged` is used as an installation-ownership proxy; `win-unpacked` is packaged but not installed.
- Core session paths are regenerated whenever the in-process MCP server starts, so an Electron restart necessarily creates a new local endpoint identity even if the tunnel configuration is unchanged.
- Request IDs exist at the inbound HTTP boundary but are not promoted into a structured, generation-scoped lifecycle log.
- Existing `lastRequestAt` / `lastToolCallAt` are useful clocks, but neither proves that a real MCP execution probe succeeds now.
- Tunnel-child supervision is strong for the transport process but there is no independent supervisor above the Core runtime itself.
- The OpenAI tunnel uses API-key authentication in this product. There is no app-owned refresh-token protocol to repair; invalid API-key/tunnel authentication must map to `AUTH_REQUIRED`, while transient network/backend failures remain recoverable.

## Proposed architecture

### Process ownership

The target Windows process graph is:

```text
ChatGPT
  |
  v
Secure MCP Tunnel
  |
  v
Core Host (independent Electron helper mode)
  |- MCP server
  |- tunnel lifecycle
  |- connection health arbiter
  |- watchdog/probes
  |- local tools/runtime
  `- structured request lifecycle
  ^
  | authenticated local IPC
  v
Electron UI

Core Supervisor (independent helper mode)
  `- starts/restarts Core Host with bounded backoff
```

The first migration uses a second Electron process launched in a non-UI helper mode rather than `utilityProcess` or a pure Node helper:

- `utilityProcess` is parent-owned and therefore does not solve UI/main lifetime coupling.
- a pure `ELECTRON_RUN_AS_NODE` host cannot directly reuse the current `electron.safeStorage` credential implementation and would force a credential-migration project into the first reliability fix.
- a separate Electron helper-mode process can reuse the current encrypted store and existing Core runtime while having an independent OS process lifetime.

The UI process must no longer own the Core tunnel or MCP listener. It attaches to Core over local IPC and renders Core's status. Closing/restarting the UI therefore does not call Core disconnect.

The Core Supervisor and Core Host are distinct. A host crash must leave a process alive that can restart it. They use single-instance local ownership so concurrent UI launches cannot create duplicate hosts.

### Local IPC and single-instance ownership

Use an OS-local endpoint as both rendezvous and liveness authority:

- Windows: a user-scoped named pipe.
- macOS/Linux: a socket below the app's user-data/runtime directory.

The Core Host binds the endpoint exclusively. A second host that cannot bind exits cleanly instead of creating a second tunnel. The supervisor treats an already-healthy endpoint as success rather than spawning another host.

IPC messages carry:

```ts
interface CoreHello {
  protocolVersion: 3;
  coreVersion: string;
  corePid: number;
  generation: number;
}
```

and a typed status snapshot. The UI never receives secrets.

### Supervision

Supervisor restart delays are deterministic and testable:

```text
2s -> 5s -> 10s -> 30s -> 60s -> 120s -> 180s cap
```

A healthy host interval (default 5 minutes) resets the failure counter. Only one `ensureHost()` / restart operation may execute at once. Exit, probe-failure and UI attach events all converge on the same single-flight operation.

A successful IPC health handshake, not merely a live PID, is what counts as a running host. Stale PID/lock metadata never blocks recovery when the IPC endpoint is absent and the recorded PID is dead.

### Central connection-health arbiter

Replace the notion that any subsystem can independently write `connected` with one serialized health model:

```ts
type OverallConnectionState =
  | 'CONNECTED'
  | 'DEGRADED'
  | 'RECONNECTING'
  | 'OFFLINE'
  | 'AUTH_REQUIRED';

interface CoreHealthSnapshot {
  overall: OverallConnectionState;
  authHealthy: boolean;
  remoteTransportHealthy: boolean;
  remoteSubscriptionHealthy: boolean;
  coreProcessHealthy: boolean;
  localMcpHealthy: boolean;
  toolProbeHealthy: boolean;
  lastToolSuccessAt: number | null;
  lastRemoteHeartbeatAt: number | null;
  lastProbeAt: number | null;
  reconnectAttempt: number;
  connectionGeneration: number;
}
```

All subsystem events are reduced through one arbiter. The minimum `CONNECTED` predicate is:

```text
authHealthy
&& remoteTransportHealthy
&& remoteSubscriptionHealthy
&& coreProcessHealthy
&& localMcpHealthy
&& toolProbeHealthy
```

A live tunnel with a failed local MCP/probe is `DEGRADED` or `RECONNECTING`, never `CONNECTED`.

### End-to-end execution probe

Core periodically performs a short, read-only MCP `tools/list` probe against the real loopback endpoint through the MCP transport adapter. The probe:

- uses the existing self-test marker so it does not fake `lastRequestAt`,
- has a short timeout (3 seconds default),
- causes no tool side effect,
- crosses HTTP/MCP dispatch and server construction,
- records probe latency/result,
- sets `toolProbeHealthy=false` on timeout/error and enters single-flight recovery.

A tunnel `/readyz` or remote poll remains transport evidence only.

### Remote transport recovery

The current tunnel-client supervision remains the transport implementation. Its already-correct properties are preserved: fresh child on unready/exit, bounded readiness, poll freshness, network-outage classification and exponential reconnect.

Core's arbiter consumes those reports without allowing a transport report to set overall readiness directly. `connectionGeneration` increments on any true tunnel recreation. Async reports and responses from older generations are ignored.

The DesktopCommander-specific `joining` state is not invented where tunnel-client does not expose it. The equivalent invariant here is bounded tunnel readiness plus stale control-plane poll detection; when tunnel-client reports/acts half-open, the app replaces the process rather than reusing its stale transport.

### Authentication recovery

For the OpenAI Secure MCP Tunnel path, the app's credential is an API key, not an access/refresh-token pair. Therefore:

- network/DNS/timeout failures: recoverable `OFFLINE` / `RECONNECTING`;
- temporary tunnel-client/backend failure: bounded recovery;
- explicit 401/403/invalid key/tunnel-id: `AUTH_REQUIRED`, no restart storm;
- actual Disconnect: intentionally stop remote publication.

If a future transport introduces access/refresh tokens, it must implement refresh as a separate auth state machine rather than overloading tunnel retry.

### Tool request lifecycle and retry

Every inbound request receives a canonical request ID. If ChatGPT supplied `x-request-id`, preserve its normalized value; otherwise generate an internal UUID for observability. Log phase transitions without tool arguments:

```text
receivedByCore
forwardedToLocalMcp
localMcpCompleted
responseSent
```

The log record includes timestamp, request id, connection generation, Core PID and tool name. `receivedByRelay` is only emitted if the remote relay/tunnel actually supplies authoritative acknowledgement; local Core must not fabricate that phase.

Responses are generation-scoped. A response started under generation N that arrives after the corresponding execution channel has been replaced is not allowed to mutate generation N+1 transport state.

Automatic retry is conservative:

- one retry maximum for explicitly classified read-only/idempotent operations after a proven pre-execution transport failure;
- no automatic retry for mutation-capable operations (`apply_patch`, `exec_command`, `write_stdin`, desktop input/clipboard writes, create/send/install/delete equivalents);
- never retry when it is ambiguous whether the original operation committed.

### Shutdown semantics

Shutdown reason is explicit:

```ts
type ShutdownReason =
  | 'user-quit-ui'
  | 'ui-restart'
  | 'renderer-reload'
  | 'app-update'
  | 'core-update'
  | 'system-shutdown'
  | 'core-crash'
  | 'auth-logout'
  | 'explicit-disconnect';
```

Rules:

- user quit UI / UI restart / renderer reload: Core remains alive;
- ordinary app update: UI exits; compatible Core remains alive until installer compatibility requires restart;
- explicit Disconnect: Core unpublishes remote tunnel but process may remain available for UI control;
- system shutdown: Core publishes/records graceful offline where feasible and exits;
- Core crash: supervisor restarts with backoff;
- auth logout/invalid key: remote publication stops and state becomes `AUTH_REQUIRED`.

### Version compatibility

Protocol version is independent of product version:

```text
protocolVersion = 3
coreVersion = product build version
uiVersion = product build version
```

Initial compatibility rule: UI and Core must agree on protocol major exactly. Product patch/minor differences are allowed only while protocol major matches and the Core reports all required capabilities.

On UI update:

1. new UI attaches to existing Core;
2. if protocol/capabilities are compatible, keep Core running;
3. if incompatible, request a controlled Core restart into the newly installed binary;
4. do not kill a compatible Core merely because `uiVersion !== coreVersion`.

The first Windows migration may require a short Core restart during NSIS file replacement because the helper-mode Core is launched from the installed application binary. That is an explicit, observable controlled reconnect, not an accidental UI teardown. A later side-by-side Core payload can remove that last update interruption without changing the IPC/status protocol.

## Windows updater handoff

### Installation ownership

`app.isPackaged` is not enough. Add a pure helper:

```ts
ownsWindowsInstallation(execPath)
```

It returns true only when the running Windows executable's directory has the electron-builder uninstaller (`Uninstall Chat On Steroids.exe`). This continues to work for a custom install directory while classifying `release/win-unpacked/Chat On Steroids.exe` as a preview.

### Explicit install flow

The Electron process never directly starts the visible NSIS installer. It persists the update intent, starts a tiny detached handoff helper, and exits. The helper is allowed to be hidden. It receives only validated values (parent PID, installer path, mode/arguments) and:

1. waits until the old UI PID no longer exists;
2. if Core must be stopped for binary compatibility/replacement, waits for the supervisor/Core handoff to complete first;
3. starts the NSIS installer with `windowsHide:false`;
4. exits.

Installer argument policy:

| Runtime | Explicit `Install Update` | Ordinary quit |
| --- | --- | --- |
| true NSIS install | visible assisted upgrade, `--updated`; relaunch policy explicit | silent `/S --updated` if product policy retains install-on-quit |
| win-unpacked preview | visible fresh-install wizard; no `--updated` | do not install |

The handoff helper itself may be hidden. The NSIS child must be visible for an explicit install.

A production helper must avoid command-string interpolation. If PowerShell is used in the first migration, it must be invoked with a generated script/file plus positional arguments, `-NoProfile -NonInteractive`, and no concatenated shell command. A small native helper is preferable once the release pipeline owns its build; tests target behavior rather than implementation language so that substitution is possible without protocol changes.

## UI

Renderer displays the arbiter state, not tunnel state. Minimum details:

```text
Overall
Core Host
Remote Transport
Authentication
Local MCP
Tool Execution
Last successful call
```

Debug detail may additionally display PID, generation, reconnect attempt and last heartbeat/probe times. A remote-live/local-dead snapshot must never render the green Connected headline.

## Structured logging

Core connection/update logs use stable event records with at least:

- timestamp,
- component,
- event,
- connectionGeneration,
- corePid,
- uiPid where applicable,
- remote state,
- local MCP state,
- reconnect attempt,
- request ID where applicable,
- health probe result,
- auth state,
- shutdown reason,
- update state.

Sensitive tool arguments, path-secret MCP tokens and API keys are never logged.

## Migration sequence

1. Introduce pure health arbiter, retry classifier, supervisor/backoff model and updater-handoff policy behind tests.
2. Move current MCP/tunnel ownership behind a Core runtime interface; preserve tool behavior and security guards.
3. Add helper-mode Core Host + Supervisor processes and local IPC; switch Electron UI to attach rather than own the connection.
4. Add end-to-end probe and structured request lifecycle.
5. Change shutdown reason semantics so UI-only quits leave Core alive.
6. Introduce Windows PID-wait updater handoff and real-install detection.
7. Render layered connection health in Settings/Connection.
8. Add protocol compatibility handshake and controlled Core restart.
9. Package and smoke on Windows, including true NSIS installation and win-unpacked preview.

## Migration risks

- **Runtime extraction risk:** Core tools currently import session, agent, execution and other main-process services. Moving ownership must extract a non-renderer runtime without creating duplicate process/session managers.
- **safeStorage risk:** credentials are Electron-safeStorage-backed. This is why the first Core Host remains an Electron helper-mode process.
- **single-instance risk:** the existing app-wide Electron single-instance lock must apply only to UI mode; helper modes need their own ownership endpoint and must not steal/lose the UI lock.
- **Windows update file locks:** a Core launched from the installed executable can keep NSIS replacement blocked. The update protocol must explicitly stop/restart an incompatible/replace-blocking Core before installer launch, or later ship a side-by-side host payload outside the installed directory.
- **schema/session continuity:** ChatGPT caches tool schemas. Core restart/reconnect must preserve the remote tunnel identity and avoid unnecessary tool-surface churn.
- **exactly-once risk:** automatic retries are restricted because ambiguous mutation outcomes can duplicate side effects.
- **cross-platform risk:** Windows process/update behavior must not regress macOS/Linux startup/shutdown and packaging.

## Acceptance criteria

The implementation is complete only when the requested regression matrix is automated where deterministic, package verification is green, and Windows packaged smoke demonstrates:

- UI closes while Core remains callable;
- UI reopens and attaches to the existing Core;
- Core crash self-recovers without duplicate instances or restart storm;
- transport stale/unready self-recovers;
- remote-live/local-dead never reports Connected;
- a real MCP tools-list probe gates Connected;
- request/generation lifecycle is observable;
- explicit update uses PID-wait handoff and a visible installer;
- win-unpacked is not treated as an installed upgrade;
- update preserves Core when compatible or performs one controlled, observable reconnect when replacement requires it;
- the same ChatGPT conversation remains usable after ordinary transient failures without manual connector recreation whenever the upstream connector session itself remains valid.
