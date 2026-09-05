# Chat On Steroids Core — Multi-Device Architecture Design

Date: 2026-09-05
Status: Approved design draft; awaiting written-spec review before implementation planning

## 1. Objective

Extend Chat On Steroids Core from a single-Windows-machine local control bridge into a secure multi-device control plane that can coordinate several user-owned computers from one ChatGPT-facing Core.

The first production milestone is deliberately narrow: two Windows computers, remote filesystem operations, remote command execution, explicit device routing, pairing, capability enforcement, online/offline state, and auditable actions.

## 2. Architectural decision

Use a **Coordinator + Node Agent + versioned protocol** architecture.

- **Coordinator/Core** remains the only ChatGPT-facing control surface.
- **Node Agent** runs on each managed computer and exposes a bounded set of capabilities to the Coordinator.
- **LocalProvider** preserves existing local-machine behavior behind the same internal interface used by remote nodes.
- **RemoteProvider** serializes requests over the Core↔Node protocol and returns normalized results.
- Every remote-capable tool call carries an explicit `device_id` at the protocol boundary.
- Friendly device names are UI metadata only; stable opaque IDs are authoritative.

No implicit global “current device” state is used for privileged execution.

## 3. Scope

### 3.1 MVP in scope

1. Two Windows devices.
2. Device enrollment/pairing.
3. Stable device identity.
4. Device list and online/offline state.
5. Explicit `device_id` routing.
6. Filesystem read/list/stat operations.
7. Filesystem write/patch operations within configured roots.
8. Terminal command execution.
9. Capability-based authorization per device.
10. Structured protocol errors.
11. Audit log for privileged operations.
12. Reconnect behavior after temporary network loss.
13. Protocol version negotiation.
14. Local device preserved as a first-class provider.

### 3.2 Explicitly out of scope for MVP

- Mouse/keyboard/desktop streaming and UI automation.
- macOS support.
- Linux support.
- Cross-device workload scheduling.
- Automatic task placement.
- Cloud relay owned by Chat On Steroids.
- NAT traversal implementation.
- Multi-user/organization RBAC.
- Browser-accessible management console.
- File synchronization as a background service.

These are follow-up capabilities, not prerequisites for the initial architecture.

## 4. Component model

```text
ChatGPT
   |
   v
Chat On Steroids Core / Coordinator
   |
   +-- Tool Surface
   +-- Device Registry
   +-- Router
   +-- Policy Engine
   +-- Audit Log
   +-- LocalProvider
   +-- RemoteProvider
            |
            +---- secure transport ---- Node Agent A
            |
            +---- secure transport ---- Node Agent B
```

### 4.1 Coordinator

Responsibilities:

- Expose the existing ChatGPT-facing tool contract.
- Resolve `device_id` to a registered device.
- Reject unknown, revoked, offline, or unauthorized devices before execution.
- Dispatch local requests to LocalProvider.
- Dispatch remote requests to RemoteProvider.
- Normalize local and remote results into one public result shape.
- Record privileged actions in the audit log.
- Keep protocol and transport details out of tool handlers.

The Coordinator must not contain OS-specific filesystem or shell logic beyond provider dispatch.

### 4.2 Device Registry

Stores authoritative metadata for enrolled devices:

```text
device_id
friendly_name
public_identity / key fingerprint
os
agent_version
protocol_versions
capabilities
authorized_roots
status
last_seen_at
enrolled_at
revoked_at
```

Rules:

- `device_id` is immutable.
- Friendly names can change.
- A revoked device cannot reconnect without a new enrollment decision.
- Duplicate friendly names are allowed; duplicate identities are not.

### 4.3 Router

Input:

```text
device_id + operation + request payload
```

Output:

```text
provider result OR normalized routing/policy error
```

Routing rules:

1. Validate `device_id`.
2. Validate device status.
3. Validate capability.
4. Validate operation-specific policy.
5. Route to LocalProvider or RemoteProvider.
6. Attach trace/request ID.
7. Normalize result.
8. Write audit event where required.

The Router never silently falls back to another device.

### 4.4 LocalProvider

Wraps the existing local Core implementation.

Goals:

- Preserve current behavior.
- Avoid duplicating local filesystem/terminal logic.
- Conform to the same provider interface as RemoteProvider.
- Make the current machine appear in the registry as a normal managed device.

Illustrative internal interface:

```text
Provider.execute(operation, request, context) -> Result
```

### 4.5 RemoteProvider

Responsibilities:

- Convert provider requests into versioned protocol messages.
- Send them to the target Node session.
- Correlate response IDs.
- Enforce timeouts/cancellation.
- Convert wire errors into normalized Core errors.
- Never reinterpret a failed remote request as a local request.

### 4.6 Node Agent

A lightweight background process installed on every managed computer.

Responsibilities:

- Maintain a secure outbound connection to the Coordinator.
- Authenticate using its enrolled device identity.
- Advertise agent version, protocol versions, OS, and capabilities.
- Execute only operations granted by local + Coordinator policy.
- Enforce filesystem roots locally as defense in depth.
- Execute terminal commands without exposing a generic unauthenticated remote shell.
- Return structured results and errors.
- Emit health/heartbeat status.

The Node must default to deny when a capability is not configured.

## 5. Public tool contract

The preferred long-term contract is explicit device targeting on operations that may affect a machine.

Examples:

```text
devices()
read(device_id, path)
write(device_id, path, content)
apply_patch(device_id, path, patch)
exec_command(device_id, cmd, ...)
```

Compatibility strategy:

- Existing calls that omit `device_id` may temporarily target the local device only.
- New remote-capable calls must include `device_id`.
- Omitted `device_id` must never mean “last selected device.”
- The deprecation path for implicit-local calls can be decided after the MVP is stable.

## 6. Protocol

Use a small versioned request/response protocol independent of transport.

### 6.1 Request envelope

```json
{
  "protocol_version": 1,
  "request_id": "req_...",
  "device_id": "dev_...",
  "operation": "terminal.exec",
  "payload": {},
  "deadline_ms": 30000
}
```

### 6.2 Response envelope

```json
{
  "protocol_version": 1,
  "request_id": "req_...",
  "ok": true,
  "result": {},
  "error": null
}
```

### 6.3 Error classes

At minimum:

- `DEVICE_NOT_FOUND`
- `DEVICE_OFFLINE`
- `DEVICE_REVOKED`
- `CAPABILITY_DENIED`
- `ROOT_DENIED`
- `PROTOCOL_MISMATCH`
- `REQUEST_TIMEOUT`
- `REQUEST_CANCELLED`
- `REMOTE_EXECUTION_FAILED`
- `INVALID_REQUEST`
- `TRANSPORT_UNAVAILABLE`

Errors must carry a stable machine-readable code and a concise human-readable message.

## 7. Transport

The protocol is transport-agnostic.

### MVP recommendation

Use a persistent encrypted connection reachable over Tailscale/private networking, with the Node initiating the connection outbound where practical.

The implementation should hide this behind a transport interface so later transports can include:

- LAN direct connection.
- Tailscale/private overlay.
- Direct TLS.
- Future Chat On Steroids relay.

Do not bake Tailscale-specific semantics into the application protocol.

## 8. Identity and pairing

### 8.1 Device identity

Each Node generates or receives a persistent cryptographic identity at enrollment.

The Coordinator stores the trusted public identity/fingerprint. Possession of a friendly device name is never sufficient authentication.

### 8.2 Pairing flow

1. Start Node in unenrolled state.
2. Node presents an enrollment request containing a one-time pairing secret/code and public identity.
3. Coordinator verifies the pairing secret.
4. Coordinator creates stable `device_id` and policy record.
5. Both sides persist enrollment state.
6. Subsequent sessions authenticate using the persisted identity.

Pairing credentials must be short-lived and single-use.

## 9. Authorization model

Capabilities are operation-oriented, not broad “remote access” flags.

Initial capability set:

```text
filesystem.read
filesystem.write
terminal.exec
```

Future capabilities can include:

```text
desktop.observe
desktop.control
clipboard.read
clipboard.write
process.inspect
service.control
```

Policy is enforced twice where practical:

1. Coordinator before dispatch.
2. Node before execution.

## 10. Filesystem safety

Every device has configured approved roots.

Examples:

```text
C:\dev
C:\project-inmersion
D:\workspace
```

Rules:

- Canonicalize/resolve paths before authorization.
- Block traversal outside approved roots.
- Treat junctions/symlinks/reparse points carefully on Windows.
- Write/delete/move remain higher-risk than read.
- Recursive destructive actions must verify final resolved targets before execution.
- Node-side root enforcement is mandatory even if Coordinator already checked.

## 11. Terminal execution safety

`terminal.exec` is an authenticated capability, not a raw network shell.

Requirements:

- Every request has `request_id` and target `device_id`.
- Node executes under the configured service/user identity.
- Coordinator records command metadata in the audit log.
- Timeouts and cancellation are supported.
- Exit code, stdout, and stderr are returned distinctly.
- Interactive/PTY sessions are deferred unless current Core behavior requires them for compatibility; if retained, they use explicit session IDs scoped to a device.

## 12. Audit model

Audit event fields:

```text
event_id
request_id
timestamp
device_id
operation
resource/path summary
outcome
error_code
duration_ms
```

Do not store secrets, full authentication material, or unnecessarily sensitive command output in the audit log.

## 13. Connection lifecycle

Node states:

```text
UNENROLLED
CONNECTING
ONLINE
DEGRADED
OFFLINE
REVOKED
```

Expected behavior:

- Temporary disconnect does not delete enrollment.
- Node reconnects with bounded exponential backoff.
- Coordinator marks stale sessions offline.
- Requests targeting offline devices fail explicitly.
- No request is queued indefinitely by default.
- No request is automatically rerouted to another device.

## 14. Versioning

Two independent versions are tracked:

1. Agent application version.
2. Protocol version.

At connect time, Coordinator and Node negotiate a compatible protocol version.

Backward-compatible additions should be preferred. Breaking wire changes require a new protocol version.

## 15. Proposed code boundaries

Exact file names should follow the existing repository conventions once the local repo is accessible. Logical boundaries are:

```text
core/
  coordinator/
    device-registry
    router
    policy
    audit
  providers/
    local-provider
    remote-provider

node/
  agent
  identity
  capabilities
  filesystem
  terminal
  connection

protocol/
  envelopes
  operations
  errors
  versioning

transport/
  interface
  websocket-or-stream-transport
```

Existing local filesystem and terminal implementations should be wrapped, not rewritten, unless repository inspection shows they are inseparable from the current MCP/tool handlers.

## 16. Data flow examples

### 16.1 Local filesystem read

```text
ChatGPT -> Core tool -> Router -> LocalProvider -> existing local read implementation -> result
```

### 16.2 Remote command

```text
ChatGPT
  -> exec_command(device_id=dev_laptop)
  -> Router
  -> policy check
  -> RemoteProvider
  -> transport
  -> Node Agent
  -> capability/root/local checks
  -> command executor
  -> response
  -> RemoteProvider
  -> normalized Core result
```

## 17. Failure behavior

The system must prefer explicit failure to ambiguous recovery.

Examples:

- Unknown device: fail `DEVICE_NOT_FOUND`.
- Offline device: fail `DEVICE_OFFLINE`.
- Unauthorized operation: fail `CAPABILITY_DENIED`.
- Unsupported protocol: fail `PROTOCOL_MISMATCH`.
- Transport loss during execution: return transport/unknown-execution-state error; never retry a potentially non-idempotent command automatically.

Automatic retry is allowed only for clearly safe transport setup/heartbeat operations, not arbitrary filesystem writes or commands.

## 18. Testing strategy

### Unit tests

- Device registry identity and lifecycle.
- Router dispatch.
- Capability denial.
- Root normalization/traversal rejection.
- Protocol encode/decode.
- Protocol mismatch behavior.
- LocalProvider compatibility.
- RemoteProvider error normalization.

### Integration tests

- Coordinator + local Node process on loopback.
- Pairing/enrollment.
- Remote read.
- Remote write/patch.
- Remote terminal command.
- Disconnect/reconnect.
- Revocation.
- Timeout and cancellation.
- Duplicate/late response handling.

### Security-focused tests

- Forged device ID.
- Replayed pairing credential.
- Unauthorized capability.
- Path traversal.
- Reparse-point escape on Windows.
- Stale/revoked identity reconnect.
- Non-idempotent request after transport interruption.

## 19. Migration strategy

Phase 1 — Internal provider abstraction

- Extract/wrap existing local operations behind LocalProvider.
- Keep public behavior unchanged.

Phase 2 — Device model + routing

- Add local device to registry.
- Introduce explicit `device_id` internally.
- Add `devices()`.

Phase 3 — Protocol + loopback Node

- Implement protocol independently of production networking.
- Run Node locally in tests to validate remote semantics.

Phase 4 — Second Windows device

- Add real transport.
- Pair second device.
- Validate filesystem + terminal operations end-to-end.

Phase 5 — Hardening

- Audit logging.
- Revocation.
- Reconnect behavior.
- Security tests and compatibility coverage.

## 20. Acceptance criteria for MVP

The MVP is complete when all of the following hold:

1. Core lists at least two enrolled Windows devices with stable IDs and status.
2. A caller can explicitly target either device.
3. Remote filesystem read works only inside approved roots.
4. Remote filesystem write/patch works only when granted.
5. Remote terminal execution works only when granted.
6. The wrong/offline/revoked device produces an explicit deterministic error.
7. A command is never silently executed on a different device.
8. Temporary connection loss is reflected in device state and reconnects cleanly.
9. Every privileged remote operation has an audit event.
10. Existing local-machine workflows remain compatible through LocalProvider.
11. Protocol compatibility is tested.
12. The complete test suite passes on the primary development machine and end-to-end tests pass against a second Windows node.

## 21. Deferred decisions

These choices are intentionally deferred until repository inspection and implementation planning, because they do not alter the approved architecture:

- Exact language/runtime of the Node if different from Core.
- Exact persistent storage mechanism for the registry.
- Exact encrypted stream implementation (e.g. WebSocket vs another framed stream) behind the transport interface.
- Service packaging/installer details for Windows.
- Whether legacy local-only tool calls without `device_id` remain permanently supported or are later deprecated.

Each deferred choice must be resolved in the implementation plan before the relevant code is written.

## 22. Constraints and non-goals

- Do not expose unauthenticated arbitrary remote shell access.
- Do not allow friendly names to act as security identities.
- Do not use implicit global device selection for privileged operations.
- Do not auto-reroute failed operations.
- Do not couple protocol semantics to Tailscale.
- Do not duplicate existing local command/filesystem logic unnecessarily.
- Do not expand MVP into desktop control before the remote execution foundation is stable.
