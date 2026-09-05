# Chat On Steroids Multi-Device Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Chat On Steroids Core so one authenticated ChatGPT-facing Core can explicitly route filesystem and non-interactive terminal operations to either the local Windows machine or an enrolled second Windows Node Agent without weakening the existing security model.

**Architecture:** Build on the current browserless/Core-runtime direction. Keep the existing seven public MCP tools; extend `session` with device-management actions and add optional explicit `device_id` targeting to `read`, `apply_patch`, and `exec_command`. Add a Coordinator-side registry/router/provider layer, a same-repository Node Agent process, and a versioned request/response protocol over a Tailscale-bound authenticated WebSocket transport. The Node uses Ed25519 identity, enforces capabilities and approved roots locally, and never exposes an unauthenticated generic shell.

**Tech Stack:** TypeScript, Node.js/Electron runtime already used by Chat On Steroids, Zod schemas, Vitest, Node `crypto` Ed25519, `ws` WebSocket transport if not already present, existing `sandbox.ts` / `rawfs.ts` / `exec.ts` primitives, Tailscale/WireGuard for MVP transport encryption.

**Spec:** `docs/superpowers/specs/2026-09-05-chat-on-steroids-multi-device-design.md`

## Global Constraints

- Base this work on the current `feat/core-runtime-hardening` line, which was created from `feat/browserless-core`; do not regress the browserless/runtime-hardening architecture.
- Never modify the original dirty/shared checkout. Use a clean isolated worktree.
- Never use `git reset --hard`, `git clean`, broad checkout/restore, force push, or any operation that could overwrite unrelated user work.
- Preserve the existing seven public Core tools: `agents`, `apply_patch`, `exec_command`, `read`, `session`, `view_image`, `write_stdin`.
- Device management is added as `session` actions; do not add an eighth public MCP tool for the MVP.
- Existing calls without `device_id` remain local-only for compatibility. Omitted `device_id` must never mean “last selected device.”
- Every remote privileged request carries a stable explicit `device_id` internally and on the wire.
- Friendly device names are display metadata only and are never security identities.
- No automatic rerouting to another device after failure.
- No automatic retry of arbitrary commands or filesystem writes after ambiguous transport failure.
- MVP remote capabilities are exactly `filesystem.read`, `filesystem.write`, and `terminal.exec`.
- `write_stdin`, interactive PTY continuation, `view_image`, desktop automation, Linux/macOS, cloud relay, NAT traversal, and background file sync remain local-only or deferred in this plan.
- The Node must enforce approved roots locally for `filesystem.read` and `filesystem.apply_patch` even after Coordinator authorization succeeds.
- `terminal.exec` is a separate high-trust capability: the Node must require an approved working directory, but arbitrary Windows commands run with the Node process user's OS authority and are **not** filesystem/network-sandboxed by approved roots. Do not claim root confinement for arbitrary shell content.
- Keep the Node identity/state directory outside ordinary approved filesystem roots and hard-deny that subtree to the filesystem operations. A caller granted `terminal.exec` is nevertheless trusted with user-context command execution and may be able to reach same-user resources; grant that capability only deliberately.
- Existing Core live permissions remain the caller-side authority for local and remote tool calls. A remote Node capability can narrow what that Node accepts, but it must never elevate a Core permission that is currently disabled.
- The Coordinator must authorize before dispatch and the Node must authorize again before execution.
- Tailscale/WireGuard supplies transport encryption in the MVP. The Coordinator listener must bind to an explicitly configured private/Tailscale address, never wildcard `0.0.0.0` or `::`.
- Authentication is application-level Ed25519 challenge/response plus persisted enrollment identity; network reachability alone is not authentication.
- Pairing secrets are cryptographically random, single-use, and expire after 10 minutes.
- Audit logs must not contain pairing codes, private keys, bearer tokens, or full command output.
- Preserve existing request/correlation ownership semantics and current file/terminal sandbox rules.
- Use TDD: every production behavior change starts with a test that is observed failing for the intended reason.
- After each task, run the task-specific tests and commit only that task’s files.

---

## File Structure

Create these focused modules unless an identically purposed module already exists in the current `feat/core-runtime-hardening` tree; in that case, extend the existing module rather than creating a parallel abstraction:

```text
src/shared/multidevice/
  protocol.ts                 wire envelopes, operations, protocol version
  errors.ts                   stable error codes and normalized error shape
  types.ts                    device/capability/public metadata types

src/main/multidevice/
  device-store.ts             atomic durable JSON persistence
  device-registry.ts          enrolled device lifecycle + local-device record
  pairing.ts                  one-time enrollment tickets
  policy.ts                   capability/status checks
  audit.ts                    append-only structured audit events
  provider.ts                 provider interface
  local-provider.ts           local operation adapter
  remote-provider.ts          remote request dispatch/correlation
  router.ts                   explicit device routing
  coordinator.ts              composition root for registry/router/transport
  transport-server.ts         Tailscale-bound WebSocket server + auth handshake

src/runtime/operations/
  types.ts                    reusable operation request/result contracts
  read.ts                     current read/list/stat behavior extracted from MCP handler
  patch.ts                    current apply_patch behavior extracted from MCP handler
  command.ts                  current non-interactive exec behavior extracted from MCP handler

src/node-agent/
  main.ts                     CLI/process entrypoint
  config.ts                   endpoint, approved roots, capabilities, state dir
  identity.ts                 Ed25519 key persistence + signing
  client.ts                   connect/pair/auth/reconnect loop
  executor.ts                 protocol operation dispatch
  backoff.ts                  bounded reconnect backoff

scripts/
  run-node-agent.mjs          production-like Node Agent launcher from built output

config/example/
  node-agent.example.json     non-secret sample Node config

test/
  multidevice-protocol.test.ts
  device-registry.test.ts
  multidevice-policy.test.ts
  multidevice-pairing.test.ts
  multidevice-router.test.ts
  multidevice-audit.test.ts
  multidevice-transport.test.ts
  node-agent-identity.test.ts
  node-agent-executor.test.ts
  multidevice-mcp.test.ts
  multidevice-e2e.test.ts
```

Existing files expected to be modified:

```text
package.json
src/shared/types.ts
src/main/mcp/tools-core.ts
src/main/mcp/session-tool.ts     device-management actions stay with the existing session tool owner
src/main/mcp/tools.ts
src/main/mcp/surfaces.ts
src/main/mcp/kernel.ts          add the typed multi-device facade to ToolContext
src/main/mcp/server.ts          only if current hardening ownership requires context plumbing here
src/main/connection.ts          inject the live Coordinator facade into per-request ToolContext
src/main/config.ts              only for Core runtime config plumbing
`src/main/index.ts` on the known browserless baseline, or its already-existing hardening successor if Task 1 proves ownership has moved
src/main/sandbox.ts             only to export/reuse an existing safe helper; do not weaken rules
src/main/rawfs.ts               only if a reusable primitive must be exported
src/main/exec.ts                only if current command primitive must be exported
test/mcp.test.ts
```

The known `feat/browserless-core` baseline composes long-lived Core startup in `src/main/index.ts`. Task 1 must verify whether `feat/core-runtime-hardening` has already extracted that ownership; if so, extend the existing successor module and keep exactly one Core composition root.

---

### Task 1: Establish the clean implementation worktree and current runtime baseline

**Files:**
- Read only: current `feat/core-runtime-hardening` worktree and repository metadata
- Create worktree: `C:\Users\exprt\Project Inmersion\.worktrees\chat-on-steroids-multi-device`
- Create branch: `feat/multi-device-core-20260905`

**Interfaces:**
- Consumes: local branch `feat/core-runtime-hardening`
- Produces: one clean isolated worktree containing the exact current Core/runtime code used by all later tasks

- [ ] **Step 1: Verify the local hardening branch ref and list all existing worktrees without touching them**

```powershell
$seed = 'C:\Users\exprt\Project Inmersion\.worktrees\chat-on-steroids-browserless-core'
$hardeningRef = 'feat/core-runtime-hardening'
if (-not (Test-Path -LiteralPath $seed -PathType Container)) { throw "Seed worktree not found: $seed" }
git -C $seed show-ref --verify "refs/heads/$hardeningRef"
if ($LASTEXITCODE -ne 0) { throw "Missing local branch: $hardeningRef" }
git -C $seed worktree list --porcelain
```

Expected: the hardening branch ref exists locally. It may or may not currently own its own worktree; that does not block creating a new isolated worktree from the branch ref.

- [ ] **Step 2: Verify the hardening branch tip and inspect any existing owner without mutating it**

```powershell
$hardeningSha = (git -C $seed rev-parse $hardeningRef).Trim()
if (-not $hardeningSha) { throw 'Could not resolve hardening branch SHA' }
git -C $seed log --oneline --decorate -20 $hardeningRef
$owner = git -C $seed worktree list --porcelain | Select-String -Context 1,1 "branch refs/heads/$hardeningRef"
$owner
```

Expected: the branch resolves to a concrete commit. If an existing worktree owns it and is dirty, leave it untouched; no later step depends on editing that worktree.

- [ ] **Step 3: Create the isolated multi-device worktree directly from the verified branch ref**

```powershell
$target = 'C:\Users\exprt\Project Inmersion\.worktrees\chat-on-steroids-multi-device'
if (Test-Path -LiteralPath $target) { throw "Refusing existing target worktree: $target" }
git -C $seed worktree add -b feat/multi-device-core-20260905 $target $hardeningRef
```

Expected: new clean worktree at the exact target path.

- [ ] **Step 4: Capture exact code boundaries before editing**

```powershell
Set-Location $target
git status --short --branch
Get-ChildItem src\main -Recurse -File | Select-Object -ExpandProperty FullName
Get-ChildItem src\shared -Recurse -File | Select-Object -ExpandProperty FullName
Get-ChildItem test -File | Select-Object -ExpandProperty Name
Get-Content package.json
Get-Content src\main\mcp\tools-core.ts
Get-Content src\main\mcp\tools.ts
Get-Content src\main\mcp\surfaces.ts
```

Expected: identify the current Core composition entrypoint, the existing `read` / `apply_patch` / `exec_command` implementations, and the existing `session` schema.

- [ ] **Step 5: Run the baseline verification before feature work**

```powershell
npm.cmd test -- test/mcp.test.ts
npm.cmd run typecheck
npm.cmd run build
```

Expected: baseline passes. If a baseline test fails, invoke `superpowers:systematic-debugging` and classify it before any multi-device production change.

- [ ] **Step 6: Commit nothing**

This task establishes the isolated baseline only.

---

### Task 2: Define the versioned multi-device domain and wire protocol

**Files:**
- Create: `src/shared/multidevice/types.ts`
- Create: `src/shared/multidevice/errors.ts`
- Create: `src/shared/multidevice/protocol.ts`
- Test: `test/multidevice-protocol.test.ts`

**Interfaces:**
- Produces: `DeviceId`, `DeviceStatus`, `DeviceCapability`, `DeviceRecordPublic`, `ProtocolRequest`, `ProtocolResponse`, `ProtocolOperation`, `MULTIDEVICE_PROTOCOL_VERSION`, `MultiDeviceErrorCode`
- Later tasks import these types; no duplicate string unions are allowed elsewhere.

- [ ] **Step 1: Write failing protocol tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  MULTIDEVICE_PROTOCOL_VERSION,
  parseProtocolRequest,
  parseProtocolResponse
} from '../src/shared/multidevice/protocol.js';

describe('multi-device protocol', () => {
  it('accepts an explicit device-scoped terminal request', () => {
    const parsed = parseProtocolRequest({
      protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
      request_id: 'req_123',
      device_id: 'dev_123',
      operation: 'terminal.exec',
      payload: { cmd: 'whoami', timeout_ms: 30_000 }
    });
    expect(parsed.device_id).toBe('dev_123');
    expect(parsed.operation).toBe('terminal.exec');
  });

  it('rejects a request without device_id', () => {
    expect(() => parseProtocolRequest({
      protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
      request_id: 'req_123',
      operation: 'terminal.exec',
      payload: { cmd: 'whoami' }
    })).toThrow();
  });

  it('parses a stable structured error response', () => {
    const parsed = parseProtocolResponse({
      protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
      request_id: 'req_123',
      ok: false,
      result: null,
      error: { code: 'DEVICE_OFFLINE', message: 'Device is offline' }
    });
    expect(parsed.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
npx.cmd vitest run test/multidevice-protocol.test.ts
```

Expected: fail because the new protocol modules do not exist.

- [ ] **Step 3: Implement the exact protocol constants and schemas**

Use these authoritative values:

```ts
export const MULTIDEVICE_PROTOCOL_VERSION = 1 as const;

export type DeviceCapability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'terminal.exec';

export type DeviceStatus =
  | 'UNENROLLED'
  | 'CONNECTING'
  | 'ONLINE'
  | 'DEGRADED'
  | 'OFFLINE'
  | 'REVOKED';

export type ProtocolOperation =
  | 'filesystem.read'
  | 'filesystem.apply_patch'
  | 'terminal.exec';

export interface DeviceRecordPublic {
  deviceId: string;
  friendlyName: string;
  provider: 'local' | 'remote';
  os: 'windows';
  agentVersion: string | null;
  protocolVersions: number[];
  capabilities: DeviceCapability[];
  authorizedRoots: string[];
  status: DeviceStatus;
  publicKeyFingerprint: string | null;
  lastSeenAt: string | null;
  enrolledAt: string;
  revokedAt: string | null;
}

export interface ProtocolRequest {
  protocol_version: typeof MULTIDEVICE_PROTOCOL_VERSION;
  request_id: string;
  device_id: string;
  operation: ProtocolOperation;
  payload: unknown;
}

export type ProtocolResponse =
  | {
      protocol_version: typeof MULTIDEVICE_PROTOCOL_VERSION;
      request_id: string;
      ok: true;
      result: unknown;
      error: null;
    }
  | {
      protocol_version: typeof MULTIDEVICE_PROTOCOL_VERSION;
      request_id: string;
      ok: false;
      result: null;
      error: { code: MultiDeviceErrorCode; message: string };
    };
```

`MultiDeviceErrorCode` must contain exactly:

```ts
'DEVICE_NOT_FOUND'
'DEVICE_OFFLINE'
'DEVICE_REVOKED'
'CAPABILITY_DENIED'
'ROOT_DENIED'
'PROTOCOL_MISMATCH'
'REQUEST_TIMEOUT'
'REQUEST_CANCELLED'
'REMOTE_EXECUTION_FAILED'
'INVALID_REQUEST'
'TRANSPORT_UNAVAILABLE'
'AUTHENTICATION_FAILED'
'PAIRING_INVALID'
'PAIRING_EXPIRED'
```

Also export:

```ts
export class MultiDeviceError extends Error {
  constructor(public readonly code: MultiDeviceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MultiDeviceError';
  }
}
```

Implement Zod parsing for request and response envelopes. Payload remains `unknown` at envelope level and is validated again by the operation executor.

- [ ] **Step 4: Run focused tests GREEN**

```powershell
npx.cmd vitest run test/multidevice-protocol.test.ts
npm.cmd run typecheck
```

Expected: both pass.

- [ ] **Step 5: Commit**

```powershell
git add src/shared/multidevice test/multidevice-protocol.test.ts
git commit -m "feat(core): define multi-device protocol"
```

---

### Task 3: Add durable device registry, local-device identity, and one-time pairing tickets

**Files:**
- Create: `src/main/multidevice/device-store.ts`
- Create: `src/main/multidevice/device-registry.ts`
- Create: `src/main/multidevice/pairing.ts`
- Test: `test/device-registry.test.ts`
- Test: `test/multidevice-pairing.test.ts`

**Interfaces:**
- Produces: `DeviceStore`, `DeviceRegistry`, `PairingManager`, `EnrollDeviceInput`, and internal `DeviceRecord extends DeviceRecordPublic` with `publicKeyPem: string | null`.
- `new DeviceStore(coreUserDataDir: string)` persists beneath the existing Core userData root.
- `DeviceRegistry.open({ store, localFriendlyName, now?, idFactory? }): Promise<DeviceRegistry>` loads state and creates the local record only when missing.
- `DeviceRegistry.get(deviceId)`, `.listPublic()`, `.enroll(input)`, `.markOnline(deviceId)`, `.markOffline(deviceId)`, `.revoke(deviceId)` are the only mutation/query entrypoints used later.
- `PairingManager.createTicket()` returns `{ pairingId: string, code: string, expiresAt: string }`.
- `PairingManager.consume(code)` returns `{ pairingId: string }` once only and throws `MultiDeviceError` after replay or expiry.

- [ ] **Step 1: Write failing registry tests**

Use this real-filesystem fixture; do not mock persistence:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MULTIDEVICE_PROTOCOL_VERSION } from '../src/shared/multidevice/protocol.js';
import { DeviceStore } from '../src/main/multidevice/device-store.js';
import { DeviceRegistry } from '../src/main/multidevice/device-registry.js';

const tempDirs: string[] = [];
async function tempUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cos-multidevice-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const remoteInput = {
  friendlyName: 'Ibrahim Laptop',
  publicKeyPem: 'PUBLIC_KEY_A',
  publicKeyFingerprint: 'fp_remote_a',
  os: 'windows' as const,
  agentVersion: '0.1.0',
  protocolVersions: [MULTIDEVICE_PROTOCOL_VERSION],
  capabilities: ['filesystem.read', 'filesystem.write', 'terminal.exec'] as const,
  authorizedRoots: [String.raw`C:\COS-Remote-Test`]
};

async function openRegistry(userDataDir: string, ids: string[]): Promise<DeviceRegistry> {
  const queue = [...ids];
  return DeviceRegistry.open({
    store: new DeviceStore(userDataDir),
    localFriendlyName: 'Coordinator PC',
    idFactory: () => queue.shift() ?? 'dev_unexpected'
  });
}

describe('device registry', () => {
  it('persists an enrolled device and restores it with the same immutable id', async () => {
    const userDataDir = await tempUserData();
    const first = await openRegistry(userDataDir, ['dev_local', 'dev_remote']);
    const enrolled = await first.enroll(remoteInput);
    expect(enrolled.deviceId).toBe('dev_remote');

    const reloaded = await openRegistry(userDataDir, ['dev_should_not_be_used']);
    expect(reloaded.get('dev_remote')?.deviceId).toBe('dev_remote');
    expect(reloaded.get('dev_remote')?.publicKeyFingerprint).toBe('fp_remote_a');
  });

  it('allows duplicate friendly names but rejects duplicate public-key fingerprints', async () => {
    const userDataDir = await tempUserData();
    const registry = await openRegistry(userDataDir, ['dev_local', 'dev_a', 'dev_b']);
    await registry.enroll(remoteInput);
    const second = await registry.enroll({
      ...remoteInput,
      publicKeyPem: 'PUBLIC_KEY_B',
      publicKeyFingerprint: 'fp_remote_b'
    });
    expect(second.friendlyName).toBe('Ibrahim Laptop');
    await expect(registry.enroll({ ...remoteInput, friendlyName: 'Another name' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('persists revocation and refuses to mark a revoked device online', async () => {
    const userDataDir = await tempUserData();
    const registry = await openRegistry(userDataDir, ['dev_local', 'dev_remote']);
    await registry.enroll(remoteInput);
    await registry.revoke('dev_remote');

    const reloaded = await openRegistry(userDataDir, ['dev_unused']);
    expect(reloaded.get('dev_remote')?.status).toBe('REVOKED');
    await expect(reloaded.markOnline('dev_remote')).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('always exposes one persistent local provider record', async () => {
    const userDataDir = await tempUserData();
    const first = await openRegistry(userDataDir, ['dev_local']);
    const local = first.listPublic().find((device) => device.provider === 'local');
    expect(local?.deviceId).toBe('dev_local');

    const reloaded = await openRegistry(userDataDir, ['dev_unused']);
    expect(reloaded.listPublic().filter((device) => device.provider === 'local')).toHaveLength(1);
    expect(reloaded.get('dev_local')?.provider).toBe('local');
  });
});
```

- [ ] **Step 2: Write failing pairing tests**

```ts
import { describe, expect, it } from 'vitest';
import { PairingManager } from '../src/main/multidevice/pairing.js';

describe('pairing tickets', () => {
  it('creates a single-use ticket that expires exactly ten minutes later', () => {
    let now = Date.UTC(2026, 8, 5, 10, 0, 0);
    const manager = new PairingManager({ now: () => now });
    const ticket = manager.createTicket();
    expect(Date.parse(ticket.expiresAt) - now).toBe(10 * 60_000);
    expect(manager.consume(ticket.code)).toEqual({ pairingId: ticket.pairingId });
    expect(() => manager.consume(ticket.code)).toThrowError(/PAIRING_INVALID/);
  });

  it('rejects a ticket after the ten-minute expiry boundary', () => {
    let now = Date.UTC(2026, 8, 5, 10, 0, 0);
    const manager = new PairingManager({ now: () => now });
    const ticket = manager.createTicket();
    now += 10 * 60_000 + 1;
    expect(() => manager.consume(ticket.code)).toThrowError(/PAIRING_EXPIRED/);
  });
});
```

- [ ] **Step 3: Verify RED**

```powershell
npx.cmd vitest run test/device-registry.test.ts test/multidevice-pairing.test.ts
```

Expected: fail because registry/pairing modules do not exist.

- [ ] **Step 4: Implement atomic JSON persistence**

`DeviceStore` writes versioned JSON to:

```ts
path.join(coreUserDataDir, 'multi-device', 'devices-v1.json')
```

Write to a sibling temporary file, `fsync`/close, then rename over the destination. Store trusted public key PEM/fingerprint, capabilities, approved roots, timestamps, revoked state, but never private keys or pairing codes.

- [ ] **Step 5: Implement immutable IDs and local record**

Use opaque IDs generated as:

```ts
`dev_${randomUUID().replaceAll('-', '')}`
```

The local record is created once with provider kind `local`, persisted, and re-used across restarts. Remote enrolled records use provider kind `remote`.

- [ ] **Step 6: Implement pairing tickets**

Use `randomBytes(24).toString('base64url')` for the secret code. Store only `sha256(code)` in memory with expiry and consumed state. Pairing tickets are intentionally not durable across Core restart.

- [ ] **Step 7: Run focused tests GREEN**

```powershell
npx.cmd vitest run test/device-registry.test.ts test/multidevice-pairing.test.ts
npm.cmd run typecheck
```

- [ ] **Step 8: Commit**

```powershell
git add src/main/multidevice/device-store.ts src/main/multidevice/device-registry.ts src/main/multidevice/pairing.ts test/device-registry.test.ts test/multidevice-pairing.test.ts
git commit -m "feat(core): persist enrolled device identities"
```

---

### Task 4: Add capability policy and audit logging

**Files:**
- Create: `src/main/multidevice/policy.ts`
- Create: `src/main/multidevice/audit.ts`
- Test: `test/multidevice-policy.test.ts`
- Test: `test/multidevice-audit.test.ts`

**Interfaces:**
- Produces: `authorizeDeviceOperation(device, operation)`
- Produces: `AuditLog.append(event)` and `AuditEvent`
- Audit file: `path.join(coreUserDataDir, 'multi-device', 'audit.ndjson')`

- [ ] **Step 1: Write RED authorization tests**

```ts
import { describe, expect, it } from 'vitest';
import type { DeviceRecord } from '../src/main/multidevice/device-registry.js';
import { authorizeDeviceOperation } from '../src/main/multidevice/policy.js';

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: 'dev_remote',
    friendlyName: 'Laptop',
    provider: 'remote',
    os: 'windows',
    agentVersion: '0.1.0',
    protocolVersions: [1],
    capabilities: ['filesystem.read'],
    authorizedRoots: [String.raw`C:\COS-Remote-Test`],
    status: 'ONLINE',
    publicKeyFingerprint: 'fp_remote',
    publicKeyPem: 'PUBLIC_KEY',
    lastSeenAt: '2026-09-05T10:00:00.000Z',
    enrolledAt: '2026-09-05T09:00:00.000Z',
    revokedAt: null,
    ...overrides
  };
}

describe('multi-device capability policy', () => {
  it('requires filesystem.write for filesystem.apply_patch', () => {
    expect(() => authorizeDeviceOperation(device(), 'filesystem.apply_patch'))
      .toThrowError(/CAPABILITY_DENIED/);
    expect(() => authorizeDeviceOperation(
      device({ capabilities: ['filesystem.read', 'filesystem.write'] }),
      'filesystem.apply_patch'
    )).not.toThrow();
  });

  it('rejects an offline device before capability evaluation', () => {
    expect(() => authorizeDeviceOperation(device({ status: 'OFFLINE' }), 'filesystem.read'))
      .toThrowError(/DEVICE_OFFLINE/);
  });

  it('rejects a revoked device before dispatch', () => {
    expect(() => authorizeDeviceOperation(device({ status: 'REVOKED' }), 'filesystem.read'))
      .toThrowError(/DEVICE_REVOKED/);
  });

  it('requires terminal.exec for terminal operations', () => {
    expect(() => authorizeDeviceOperation(device(), 'terminal.exec'))
      .toThrowError(/CAPABILITY_DENIED/);
    expect(() => authorizeDeviceOperation(
      device({ capabilities: ['terminal.exec'] }),
      'terminal.exec'
    )).not.toThrow();
  });
});
```

- [ ] **Step 2: Write RED audit tests**

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/main/multidevice/audit.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('multi-device audit log', () => {
  it('writes one sanitized NDJSON event', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'cos-audit-'));
    dirs.push(userDataDir);
    const log = new AuditLog(userDataDir);
    const unsafeCandidate = {
      eventId: 'evt_1',
      requestId: 'req_1',
      timestamp: '2026-09-05T10:00:00.000Z',
      deviceId: 'dev_remote',
      operation: 'terminal.exec',
      resourceSummary: 'cwd=C:\\COS-Remote-Test cmd=powershell',
      outcome: 'failure',
      errorCode: 'REMOTE_EXECUTION_FAILED',
      durationMs: 42,
      secret: 'must-not-be-written',
      stdout: 'must-not-be-written',
      privateKeyPem: 'must-not-be-written'
    } as const;
    await log.append(unsafeCandidate);

    const raw = await readFile(join(userDataDir, 'multi-device', 'audit.ndjson'), 'utf8');
    const event = JSON.parse(raw.trim());
    expect(event).toMatchObject({
      event_id: 'evt_1',
      request_id: 'req_1',
      device_id: 'dev_remote',
      operation: 'terminal.exec',
      outcome: 'failure',
      error_code: 'REMOTE_EXECUTION_FAILED',
      duration_ms: 42
    });
    expect(raw).not.toContain('must-not-be-written');
  });
});
```

Define `AuditLog.append(event: AuditEvent & Record<string, unknown>): Promise<void>` so callers may pass internal metadata without forcing it into the persisted schema. Serialization must construct a fresh allowlisted object from the typed audit fields; never spread the candidate event into the NDJSON record. Extra payload/output/secret fields are ignored rather than copied through.

- [ ] **Step 3: Verify RED**

```powershell
npx.cmd vitest run test/multidevice-policy.test.ts test/multidevice-audit.test.ts
```

- [ ] **Step 4: Implement policy and audit modules**

Use explicit operation-to-capability mapping. Do not infer permission from friendly name, OS, online transport object, or prior successful request.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx.cmd vitest run test/multidevice-policy.test.ts test/multidevice-audit.test.ts
npm.cmd run typecheck
git add src/main/multidevice/policy.ts src/main/multidevice/audit.ts test/multidevice-policy.test.ts test/multidevice-audit.test.ts
git commit -m "feat(core): enforce device capabilities and audit actions"
```

---

### Task 5: Extract reusable local read/patch/command operations without changing existing behavior

**Files:**
- Create: `src/runtime/operations/types.ts`
- Create: `src/runtime/operations/read.ts`
- Create: `src/runtime/operations/patch.ts`
- Create: `src/runtime/operations/command.ts`
- Modify: `src/main/mcp/tools-core.ts`
- Modify only as required: `src/main/sandbox.ts`, `src/main/rawfs.ts`, `src/main/exec.ts`
- Test: existing `test/mcp.test.ts`
- Add focused test only if current tool behaviors lack direct regression coverage: `test/local-operation-compat.test.ts`

**Interfaces:**
- Produces reusable functions used by both LocalProvider and Node Agent:

```ts
export interface OperationContext {
  roots: readonly Root[];
  caps: Capabilities;
}

executeReadOperation(input, context: OperationContext): Promise<ReadOperationResult>
executePatchOperation(input, context: OperationContext): Promise<PatchOperationResult>
executeCommandOperation(input, context: OperationContext): Promise<CommandOperationResult>
```

`OperationContext` contains approved roots plus the existing product `Capabilities`; it does not contain MCP registrar objects. LocalProvider obtains this context from live Core config for every call. NodeExecutor builds a synthetic context from Node-local grants: `filesystem.read` enables read/browse/metadata, `filesystem.write` enables the mutation permissions needed by `apply_patch`, and `terminal.exec` enables command. Node mapping can only narrow what the Node accepts; the ChatGPT-facing Core handler still enforces its own live permission before dispatch.

- [ ] **Step 1: Characterize current behavior with tests before extraction**

Add or identify tests that prove at minimum:

```text
read: relative/approved-root behavior and text/folder output
apply_patch: creates/updates only inside approved roots and rejects escape
exec_command: preserves cwd/root restrictions, exit code/stdout/stderr, timeout behavior
```

- [ ] **Step 2: Run the characterization tests and confirm GREEN on the untouched baseline**

```powershell
npm.cmd test -- test/mcp.test.ts
```

If a new characterization test is added, it must pass against current behavior before extraction because this task is a refactor, not a behavior change.

- [ ] **Step 3: Extract one operation at a time**

Move the implementation body from the MCP registration callback into the runtime operation module while leaving schema, annotations, guarding, and result presentation in `tools-core.ts`. The MCP handler should become an adapter that calls the extracted function.

- [ ] **Step 4: Keep remote-incompatible PTY behavior out of the shared command contract**

The reusable `executeCommandOperation` must support the non-interactive command path required by remote MVP. Existing local PTY/session behavior remains in the local MCP path and is not deleted.

- [ ] **Step 5: Verify no behavior drift**

```powershell
npm.cmd test -- test/mcp.test.ts
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

Expected: existing public tool behavior unchanged.

- [ ] **Step 6: Commit**

```powershell
git add src/runtime/operations src/main/mcp/tools-core.ts src/main/sandbox.ts src/main/rawfs.ts src/main/exec.ts test/mcp.test.ts test/local-operation-compat.test.ts
git commit -m "refactor(core): extract reusable local operations"
```

If `test/local-operation-compat.test.ts` was not needed, omit it from `git add` rather than creating an empty file.

---

### Task 6: Implement provider abstraction and explicit router

**Files:**
- Create: `src/main/multidevice/provider.ts`
- Create: `src/main/multidevice/local-provider.ts`
- Create: `src/main/multidevice/router.ts`
- Test: `test/multidevice-router.test.ts`

**Interfaces:**
- Produces these exact provider contracts in `src/main/multidevice/provider.ts`:

```ts
import type { MultiDeviceErrorCode } from '../../shared/multidevice/errors.js';
import type { ProtocolOperation } from '../../shared/multidevice/protocol.js';

export interface ProviderRequest {
  requestId: string;
  deviceId: string;
  operation: ProtocolOperation;
  payload: unknown;
  timeoutMs: number;
}

export type ProviderResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: MultiDeviceErrorCode; message: string } };

export interface DeviceProvider {
  execute(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult>;
}

export class DeviceRouter {
  execute(
    deviceId: string,
    operation: ProtocolOperation,
    payload: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<ProviderResult>;
}
```

Default router timeout is `30_000` ms when `timeoutMs` is omitted.

- `LocalProvider` delegates to Task 5 functions and receives a `contextFactory: () => OperationContext` that reads current Core roots/capabilities at execution time; it must not capture a startup-time permission snapshot.
- RemoteProvider is introduced in Task 9 and plugged into the same router without changing the router contract.

Add this constructor to the `DeviceRouter` contract so routing dependencies are explicit and testable:

```ts
new DeviceRouter({
  registry: DeviceRegistry,
  localProvider: DeviceProvider,
  remoteProvider: DeviceProvider,
  audit: AuditLog,
  requestIdFactory?: () => string
})

new LocalProvider({
  contextFactory: () => OperationContext
})
```

- [ ] **Step 1: Write RED router tests with narrow provider doubles**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DeviceRecord } from '../src/main/multidevice/device-registry.js';
import { DeviceRouter } from '../src/main/multidevice/router.js';
import type { DeviceProvider } from '../src/main/multidevice/provider.js';

function record(provider: 'local' | 'remote', overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: provider === 'local' ? 'dev_local' : 'dev_remote',
    friendlyName: provider === 'local' ? 'Coordinator PC' : 'Laptop',
    provider,
    os: 'windows',
    agentVersion: provider === 'local' ? null : '0.1.0',
    protocolVersions: [1],
    capabilities: ['filesystem.read', 'filesystem.write', 'terminal.exec'],
    authorizedRoots: [String.raw`C:\COS-Test`],
    status: 'ONLINE',
    publicKeyFingerprint: provider === 'local' ? null : 'fp_remote',
    publicKeyPem: provider === 'local' ? null : 'PUBLIC_KEY',
    lastSeenAt: '2026-09-05T10:00:00.000Z',
    enrolledAt: '2026-09-05T09:00:00.000Z',
    revokedAt: null,
    ...overrides
  };
}

function harness(devices: Record<string, DeviceRecord>) {
  const localExecute = vi.fn().mockResolvedValue({ ok: true, result: { source: 'local' } });
  const remoteExecute = vi.fn().mockResolvedValue({ ok: true, result: { source: 'remote' } });
  const append = vi.fn().mockResolvedValue(undefined);
  const router = new DeviceRouter({
    registry: { get: (id: string) => devices[id] } as never,
    localProvider: { execute: localExecute } as DeviceProvider,
    remoteProvider: { execute: remoteExecute } as DeviceProvider,
    audit: { append } as never,
    requestIdFactory: () => 'req_fixed'
  });
  return { router, localExecute, remoteExecute, append };
}

describe('device router', () => {
  it('routes a local device only to LocalProvider', async () => {
    const h = harness({ dev_local: record('local') });
    const result = await h.router.execute('dev_local', 'filesystem.read', { path: 'README.md' });
    expect(result).toEqual({ ok: true, result: { source: 'local' } });
    expect(h.localExecute).toHaveBeenCalledOnce();
    expect(h.remoteExecute).not.toHaveBeenCalled();
  });

  it('never falls back to local when a remote device is offline', async () => {
    const h = harness({ dev_remote: record('remote', { status: 'OFFLINE' }) });
    const result = await h.router.execute('dev_remote', 'filesystem.read', { path: 'README.md' });
    expect(result).toMatchObject({ ok: false, error: { code: 'DEVICE_OFFLINE' } });
    expect(h.localExecute).not.toHaveBeenCalled();
    expect(h.remoteExecute).not.toHaveBeenCalled();
  });

  it('denies missing capability before either provider executes', async () => {
    const h = harness({ dev_remote: record('remote', { capabilities: ['filesystem.read'] }) });
    const result = await h.router.execute('dev_remote', 'terminal.exec', { cmd: 'whoami' });
    expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } });
    expect(h.localExecute).not.toHaveBeenCalled();
    expect(h.remoteExecute).not.toHaveBeenCalled();
  });

  it('audits success and pre-dispatch failure with the same generated request id', async () => {
    const h = harness({
      dev_local: record('local'),
      dev_remote: record('remote', { status: 'OFFLINE' })
    });
    await h.router.execute('dev_local', 'filesystem.read', { path: 'README.md' });
    await h.router.execute('dev_remote', 'filesystem.read', { path: 'README.md' });
    expect(h.append).toHaveBeenNthCalledWith(1, expect.objectContaining({ requestId: 'req_fixed', outcome: 'success' }));
    expect(h.append).toHaveBeenNthCalledWith(2, expect.objectContaining({ requestId: 'req_fixed', outcome: 'failure', errorCode: 'DEVICE_OFFLINE' }));
  });
});
```

- [ ] **Step 2: Verify RED**

```powershell
npx.cmd vitest run test/multidevice-router.test.ts
```

- [ ] **Step 3: Implement router ordering exactly**

The order is:

```text
create request_id
lookup device
reject unknown/revoked/offline
for remote provider only: capability authorization from enrolled Node grants
select provider by immutable provider kind
execute
normalize result/error
append audit for success or failure using the same request_id
return
```

Creating `request_id` first is intentional: unknown/offline/revoked/capability failures are privileged attempts too and must receive a correlation ID and audit event before the router returns. Remote device grants are checked in the router. Local authorization remains inside LocalProvider's live `OperationContext` so a persisted local registry record can never become a stale permission grant.

There is no fallback branch from remote to local.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npx.cmd vitest run test/multidevice-router.test.ts
npm.cmd run typecheck
git add src/main/multidevice/provider.ts src/main/multidevice/local-provider.ts src/main/multidevice/router.ts test/multidevice-router.test.ts
git commit -m "feat(core): route operations by explicit device id"
```

---

### Task 7: Add Ed25519 Node identity and secure enrollment/authentication handshake

**Files:**
- Create: `src/node-agent/identity.ts`
- Create: `src/main/multidevice/transport-server.ts`
- Modify: `src/main/multidevice/pairing.ts`
- Test: `test/node-agent-identity.test.ts`
- Test: `test/multidevice-transport.test.ts`
- Modify: `package.json` only if `ws` / `@types/ws` are absent

**Interfaces:**
- Node identity API:

```ts
loadOrCreateNodeIdentity(stateDir): Promise<{
  publicKeyPem: string;
  fingerprint: string;
  sign(data: Uint8Array): Buffer;
}>;
```

- Coordinator transport handshake messages are protocol-internal and use this single canonical message vocabulary:

```ts
type NodeTransportMessage =
  | { kind: 'pair_request'; pairing_code: string; public_key_pem: string; friendly_name: string; os: 'windows'; agent_version: string; protocol_versions: number[]; capabilities: DeviceCapability[]; approved_roots: string[] }
  | { kind: 'pair_accepted'; device_id: string }
  | { kind: 'auth_challenge'; device_id: string; challenge: string }
  | { kind: 'auth_response'; device_id: string; signature: string }
  | { kind: 'auth_accepted'; device_id: string }
  | { kind: 'request'; body: ProtocolRequest }
  | { kind: 'response'; body: ProtocolResponse }
  | { kind: 'heartbeat'; device_id: string; sent_at: string };
```

`challenge` and `signature` are base64url. The Coordinator computes the public-key fingerprint itself from `public_key_pem`; it never trusts a caller-supplied fingerprint. Transport authentication signs `Buffer.concat([Buffer.from('chat-on-steroids-node-auth-v1\0'), challengeBytes])`, not the naked challenge, to domain-separate this signature from other Ed25519 uses. Each challenge is 32 random bytes, single-use, and expires after 30 seconds.

- [ ] **Step 1: Write RED identity tests**

Use real temporary state directories and Node's real Ed25519 verifier:

```ts
import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateNodeIdentity } from '../src/node-agent/identity.js';
import { DeviceStore } from '../src/main/multidevice/device-store.js';
import { DeviceRegistry } from '../src/main/multidevice/device-registry.js';
import { MULTIDEVICE_PROTOCOL_VERSION } from '../src/shared/multidevice/protocol.js';

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('node Ed25519 identity', () => {
  it('creates an identity once and reloads the same fingerprint', async () => {
    const stateDir = await tempDir('cos-node-id-');
    const first = await loadOrCreateNodeIdentity(stateDir);
    const second = await loadOrCreateNodeIdentity(stateDir);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  it('signs a challenge that verifies with the persisted public key', async () => {
    const stateDir = await tempDir('cos-node-sign-');
    const identity = await loadOrCreateNodeIdentity(stateDir);
    const challenge = Buffer.alloc(32, 0x5a);
    const signature = identity.sign(challenge);
    expect(verify(null, challenge, createPublicKey(identity.publicKeyPem), signature)).toBe(true);
  });

  it('persists only public identity material in the Coordinator registry', async () => {
    const stateDir = await tempDir('cos-node-private-');
    const userDataDir = await tempDir('cos-core-public-');
    const identity = await loadOrCreateNodeIdentity(stateDir);
    const registry = await DeviceRegistry.open({
      store: new DeviceStore(userDataDir),
      localFriendlyName: 'Coordinator',
      idFactory: (() => {
        const ids = ['dev_local', 'dev_remote'];
        return () => ids.shift() ?? 'dev_unexpected';
      })()
    });
    await registry.enroll({
      friendlyName: 'Laptop',
      publicKeyPem: identity.publicKeyPem,
      publicKeyFingerprint: identity.fingerprint,
      os: 'windows',
      agentVersion: '0.1.0',
      protocolVersions: [MULTIDEVICE_PROTOCOL_VERSION],
      capabilities: ['filesystem.read'],
      authorizedRoots: [String.raw`C:\COS-Remote-Test`]
    });

    const registryJson = await readFile(join(userDataDir, 'multi-device', 'devices-v1.json'), 'utf8');
    expect(registryJson).toContain(identity.fingerprint);
    expect(registryJson).toContain('BEGIN PUBLIC KEY');
    expect(registryJson).not.toContain('BEGIN PRIVATE KEY');
  });
});
```

`identity.ts` stores `identity-v1.json` only in the Node's configured `stateDir`, writes it atomically, and requests owner-only permissions (`0o600`) where the platform honors POSIX modes. The private key is never sent to the Coordinator. Task 8 hard-denies the `stateDir` subtree through dedicated filesystem operations even when an approved root is broader; this is defense in depth, not a sandbox against a caller already granted full user-context `terminal.exec`.

- [ ] **Step 2: Write RED transport authentication tests**

Start the transport server on loopback in tests only and prove:

```text
valid single-use pairing code + new public key -> pair_accepted with stable device_id, then challenge proof -> authenticated session
same code replay -> PAIRING_INVALID
known device + valid domain-separated signed challenge -> authenticated session
known device + invalid signature -> AUTHENTICATION_FAILED
revoked device + valid signature -> DEVICE_REVOKED
protocol version mismatch -> PROTOCOL_MISMATCH
```

- [ ] **Step 3: Verify RED**

```powershell
npx.cmd vitest run test/node-agent-identity.test.ts test/multidevice-transport.test.ts
```

- [ ] **Step 4: Add `ws` only if the dependency is absent**

```powershell
npm.cmd ls ws
```

If absent:

```powershell
npm.cmd install ws
npm.cmd install -D @types/ws
```

Do not add a second WebSocket library.

- [ ] **Step 5: Implement challenge/response**

Coordinator challenge is `randomBytes(32)` and expires after 30 seconds. Node signs the domain-separated auth bytes defined above. Coordinator verifies with the enrolled public key, consumes the challenge once, and binds a successfully authenticated socket to exactly one `device_id`. If a second valid socket authenticates for the same device, install the new authenticated session first and then close the older socket so a stale TCP/WebSocket cannot block recovery. Configure the WebSocket server with an 8 MiB maximum message payload and reject application `request`/`response` messages before authentication.

- [ ] **Step 6: Enforce safe production binding**

Production transport startup requires explicit config:

```text
# Resolve the Coordinator PC's actual Tailscale IPv4 first:
$tailscaleIp = (& tailscale.exe ip -4 | Select-Object -First 1).Trim()
$env:CHAT_ON_STEROIDS_NODE_LISTEN_HOST = $tailscaleIp
$env:CHAT_ON_STEROIDS_NODE_LISTEN_PORT = '8788'
```

Reject `0.0.0.0` and `::`. Test-only constructors may bind loopback. No production listener starts when the host is unset.

- [ ] **Step 7: Run GREEN and commit**

```powershell
npx.cmd vitest run test/node-agent-identity.test.ts test/multidevice-transport.test.ts
npm.cmd run typecheck
git add package.json package-lock.json src/node-agent/identity.ts src/main/multidevice/transport-server.ts src/main/multidevice/pairing.ts test/node-agent-identity.test.ts test/multidevice-transport.test.ts
git commit -m "feat(core): authenticate enrolled node agents"
```

If dependencies were already present, omit unchanged lock/package files.

---

### Task 8: Implement Node Agent config, executor, filesystem-root enforcement, and reconnect loop

**Files:**
- Create: `src/node-agent/config.ts`
- Create: `src/node-agent/executor.ts`
- Create: `src/node-agent/backoff.ts`
- Create: `src/node-agent/client.ts`
- Create: `src/node-agent/main.ts`
- Create: `config/example/node-agent.example.json`
- Test: `test/node-agent-executor.test.ts`
- Extend: `test/multidevice-transport.test.ts`

**Interfaces:**
- Node config:

```ts
export interface NodeAgentConfig {
  coordinatorUrl: string;
  friendlyName: string;
  stateDir: string;
  capabilities: Array<'filesystem.read' | 'filesystem.write' | 'terminal.exec'>;
  approvedRoots: string[];
  pairingCode?: string;
}

export function loadNodeAgentConfig(configPath: string): Promise<NodeAgentConfig>;
export function consumePairingCode(configPath: string): Promise<void>;
```

- Executor:

```ts
export class NodeExecutor {
  constructor(config: Pick<NodeAgentConfig, 'stateDir' | 'capabilities' | 'approvedRoots'>);
  execute(request: ProtocolRequest, signal?: AbortSignal): Promise<ProtocolResponse>;
}
```

- Reconnect backoff:

```ts
export class ReconnectBackoff {
  nextDelayMs(): number;
  markHealthy(durationMs: number): void;
  reset(): void;
}
```

- Client heartbeat is 15 seconds; Coordinator stale/offline threshold is 45 seconds.
- Remote `terminal.exec` is non-interactive and full user-context command execution for the MVP. Approved roots constrain the requested working directory only; they do not OS-sandbox arbitrary shell content.

- [ ] **Step 1: Write RED executor tests with real temp roots and a protected state directory**

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutor } from '../src/node-agent/executor.js';
import { MULTIDEVICE_PROTOCOL_VERSION } from '../src/shared/multidevice/protocol.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture(capabilities: Array<'filesystem.read' | 'filesystem.write' | 'terminal.exec'>) {
  const root = await mkdtemp(join(tmpdir(), 'cos-node-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'cos-node-outside-'));
  const stateDir = join(root, '.cos-node-state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
  await writeFile(join(outside, 'outside.txt'), 'outside', 'utf8');
  await writeFile(join(stateDir, 'identity-v1.json'), 'PRIVATE_SENTINEL', 'utf8');
  dirs.push(root, outside);
  return {
    root,
    outside,
    stateDir,
    executor: new NodeExecutor({ stateDir, capabilities, approvedRoots: [root] })
  };
}

function request(operation: 'filesystem.read' | 'filesystem.apply_patch' | 'terminal.exec', payload: unknown) {
  return {
    protocol_version: MULTIDEVICE_PROTOCOL_VERSION,
    request_id: 'req_test',
    device_id: 'dev_remote',
    operation,
    payload
  } as const;
}

describe('NodeExecutor authorization', () => {
  it('reads only inside approved filesystem roots', async () => {
    const f = await fixture(['filesystem.read']);
    await expect(f.executor.execute(request('filesystem.read', { paths: [join(f.root, 'inside.txt')] })))
      .resolves.toMatchObject({ ok: true });
    await expect(f.executor.execute(request('filesystem.read', { paths: [join(f.outside, 'outside.txt')] })))
      .resolves.toMatchObject({ ok: false, error: { code: 'ROOT_DENIED' } });
  });

  it('hard-denies the Node state directory to filesystem operations', async () => {
    const f = await fixture(['filesystem.read']);
    const result = await f.executor.execute(request('filesystem.read', { paths: [join(f.stateDir, 'identity-v1.json')] }));
    expect(result).toMatchObject({ ok: false, error: { code: 'ROOT_DENIED' } });
  });

  it('requires filesystem.write before applying a patch', async () => {
    const f = await fixture(['filesystem.read']);
    const result = await f.executor.execute(request('filesystem.apply_patch', {
      patch: `*** Begin Patch\n*** Update File: ${join(f.root, 'inside.txt')}\n@@\n-inside\n+changed\n*** End Patch`
    }));
    expect(result).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } });
    expect(await readFile(join(f.root, 'inside.txt'), 'utf8')).toBe('inside');
  });

  it.skipIf(process.platform !== 'win32')('requires terminal.exec and an approved cwd, while rejecting PTY semantics', async () => {
    const f = await fixture(['terminal.exec']);
    await expect(f.executor.execute(request('terminal.exec', {
      cmd: 'powershell -NoProfile -Command "Write-Output COS_REMOTE_OK"',
      workdir: f.root,
      tty: false
    }))).resolves.toMatchObject({ ok: true });
    await expect(f.executor.execute(request('terminal.exec', {
      cmd: 'whoami', workdir: f.outside, tty: false
    }))).resolves.toMatchObject({ ok: false, error: { code: 'ROOT_DENIED' } });
    await expect(f.executor.execute(request('terminal.exec', {
      cmd: 'whoami', workdir: f.root, tty: true
    }))).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
});
```

On Windows, extend the same file with a junction/reparse-point case: create an in-root junction whose final target is `outside`, request the linked file through `filesystem.read`, and require `ROOT_DENIED` after final-path resolution. Skip only when junction creation is denied by the test environment, and report the skip reason explicitly.

- [ ] **Step 2: Write RED reconnect/backoff tests**

```ts
import { describe, expect, it } from 'vitest';
import { ReconnectBackoff } from '../src/node-agent/backoff.js';

describe('ReconnectBackoff', () => {
  it('uses the bounded schedule and resets only after 60 seconds healthy', () => {
    const backoff = new ReconnectBackoff();
    expect(Array.from({ length: 7 }, () => backoff.nextDelayMs()))
      .toEqual([1000, 2000, 5000, 15000, 30000, 60000, 60000]);
    backoff.markHealthy(59_999);
    expect(backoff.nextDelayMs()).toBe(60_000);
    backoff.markHealthy(60_000);
    expect(backoff.nextDelayMs()).toBe(1_000);
  });
});
```

Add transport fake-clock tests proving authenticated clients send heartbeats every 15 seconds and the Coordinator marks a remote session offline after 45 seconds without heartbeat/socket activity.

- [ ] **Step 3: Verify RED**

```powershell
npx.cmd vitest run test/node-agent-executor.test.ts test/multidevice-transport.test.ts
```

- [ ] **Step 4: Implement strict config parsing and one-time pairing-code removal**

Use a strict Zod schema mapping the on-disk snake_case JSON into `NodeAgentConfig`. Rules:

```text
coordinator_url: ws:// only for the Tailscale/WireGuard MVP
friendly_name: 1..80 characters
state_dir: absolute native Windows path
capabilities: unique members of the exact three-capability enum
approved_roots: at least one unique absolute native Windows path
pairing_code: optional, non-empty, never logged
unknown JSON fields: reject
```

`consumePairingCode(configPath)` must atomically rewrite the same JSON file after `pair_accepted`, removing only `pairing_code` while preserving the other validated fields. Write to a sibling temporary file, close/fsync, then rename. Do not copy pairing codes into durable Node state.

Use this non-secret example config:

```json
{
  "coordinator_url": "ws://100.64.0.10:8788",
  "friendly_name": "Ibrahim Laptop",
  "state_dir": "C:\\ChatOnSteroidsNode\\state",
  "capabilities": ["filesystem.read"],
  "approved_roots": ["C:\\COS-Remote-Test"]
}
```

- [ ] **Step 5: Implement executor with exact capability semantics**

For filesystem operations, resolve/canonicalize every requested path through the existing sandbox/path primitives extracted in Task 5, then reject any final target outside `approvedRoots` or inside `stateDir`. Re-check the required Node capability locally before touching disk. Build the Task 5 `OperationContext` from those roots and a synthetic existing-Core `Capabilities` projection; do not skip the operation module's own checks. `filesystem.write` is the MVP grant for `apply_patch` mutation forms within approved roots, so document that it covers create/update/move/delete hunks expressed through `apply_patch`.

For `terminal.exec`:

```text
require terminal.exec
require tty !== true and no stdin/session continuation fields
resolve workdir inside approvedRoots and outside stateDir
run the existing non-interactive command operation once
return exit code/stdout/stderr in the normalized result
```

Do **not** inspect command text and pretend that approved roots sandbox what the shell can access. Document in code comments and user-facing device metadata that `terminal.exec` grants arbitrary command execution under the Node process user.

- [ ] **Step 6: Implement authenticated client lifecycle, heartbeat, and reconnect**

`client.ts` owns exactly one socket/reconnect loop:

```text
load config + persisted Ed25519 identity
connect to coordinator_url
if not enrolled and pairing_code exists -> pair_request
on pair_accepted -> persist device_id, consumePairingCode(configPath), then complete auth_challenge / auth_response
otherwise -> auth_challenge / auth_response
on authenticated -> send capabilities + protocol versions, start 15s heartbeat
on request -> NodeExecutor.execute once and send one matching response
on socket close -> cancel in-flight local AbortControllers, mark unhealthy, wait ReconnectBackoff.nextDelayMs(), reconnect
on authenticated connection healthy for 60s -> reset backoff
```

Never start a second concurrent reconnect timer for the same client.

- [ ] **Step 7: Implement `main.ts` argument handling**

Support exactly:

```text
node-agent --config C:\COS-MultiDevice-Test\node-agent.json
node-agent --help
```

`--help` prints usage and exits 0 without reading config, creating identity files, or opening a socket. Missing/invalid `--config` exits non-zero with a sanitized error that contains no pairing code.

- [ ] **Step 8: Run GREEN and commit**

```powershell
npx.cmd vitest run test/node-agent-executor.test.ts test/multidevice-transport.test.ts
npm.cmd run typecheck
git add src/node-agent config/example/node-agent.example.json test/node-agent-executor.test.ts test/multidevice-transport.test.ts
git commit -m "feat(node): execute authenticated remote operations"
```

---

### Task 9: Implement RemoteProvider correlation, timeout, cancellation, and disconnect semantics

**Files:**
- Create: `src/main/multidevice/remote-provider.ts`
- Modify: `src/main/multidevice/transport-server.ts`
- Modify: `src/main/multidevice/router.ts`
- Test: `test/remote-provider.test.ts`

**Interfaces:**
- `RemoteProvider.execute(request, signal)` implements the `DeviceProvider` interface from Task 6.
- Add this narrow transport interface beside `RemoteProvider`; `transport-server.ts` implements it without exposing raw WebSocket objects to the provider:

```ts
export interface RemoteDeviceTransport {
  isAuthenticated(deviceId: string): boolean;
  sendRequest(deviceId: string, request: ProtocolRequest): void;
  onResponse(listener: (deviceId: string, response: ProtocolResponse) => void): () => void;
  onDisconnect(listener: (deviceId: string) => void): () => void;
}

export class RemoteProvider implements DeviceProvider {
  constructor(transport: RemoteDeviceTransport);
  execute(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult>;
  close(): void;
}
```

`close()` unsubscribes transport listeners and rejects any remaining pending calls with `TRANSPORT_UNAVAILABLE`.

- [ ] **Step 1: Write RED tests with a deterministic fake transport**

```ts
import { describe, expect, it, vi } from 'vitest';
import { RemoteProvider, type RemoteDeviceTransport } from '../src/main/multidevice/remote-provider.js';
import type { ProtocolRequest, ProtocolResponse } from '../src/shared/multidevice/protocol.js';

class FakeTransport implements RemoteDeviceTransport {
  authenticated = new Set<string>();
  sent: Array<{ deviceId: string; request: ProtocolRequest }> = [];
  private responseListeners = new Set<(deviceId: string, response: ProtocolResponse) => void>();
  private disconnectListeners = new Set<(deviceId: string) => void>();

  isAuthenticated(deviceId: string): boolean { return this.authenticated.has(deviceId); }
  sendRequest(deviceId: string, request: ProtocolRequest): void { this.sent.push({ deviceId, request }); }
  onResponse(listener: (deviceId: string, response: ProtocolResponse) => void): () => void {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }
  onDisconnect(listener: (deviceId: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  respond(deviceId: string, response: ProtocolResponse): void {
    for (const listener of this.responseListeners) listener(deviceId, response);
  }
  disconnect(deviceId: string): void {
    this.authenticated.delete(deviceId);
    for (const listener of this.disconnectListeners) listener(deviceId);
  }
}

function providerRequest(overrides: Partial<{ requestId: string; timeoutMs: number }> = {}) {
  return {
    requestId: overrides.requestId ?? 'req_1',
    deviceId: 'dev_remote',
    operation: 'terminal.exec' as const,
    payload: { cmd: 'whoami', workdir: String.raw`C:\COS-Remote-Test`, tty: false },
    timeoutMs: overrides.timeoutMs ?? 30_000
  };
}

describe('RemoteProvider', () => {
  it('resolves only the matching request_id and ignores a duplicate late response', async () => {
    const transport = new FakeTransport();
    transport.authenticated.add('dev_remote');
    const provider = new RemoteProvider(transport);
    const pending = provider.execute(providerRequest());
    expect(transport.sent).toHaveLength(1);
    transport.respond('dev_remote', {
      protocol_version: 1,
      request_id: 'req_1',
      ok: true,
      result: { stdout: 'ok' },
      error: null
    });
    await expect(pending).resolves.toEqual({ ok: true, result: { stdout: 'ok' } });
    transport.respond('dev_remote', {
      protocol_version: 1,
      request_id: 'req_1',
      ok: true,
      result: { stdout: 'duplicate' },
      error: null
    });
    expect(transport.sent).toHaveLength(1);
    provider.close();
  });

  it('fails before send when no authenticated device session exists', async () => {
    const transport = new FakeTransport();
    const provider = new RemoteProvider(transport);
    await expect(provider.execute(providerRequest()))
      .resolves.toMatchObject({ ok: false, error: { code: 'DEVICE_OFFLINE' } });
    expect(transport.sent).toHaveLength(0);
    provider.close();
  });

  it('returns REQUEST_CANCELLED without replay after AbortSignal fires', async () => {
    const transport = new FakeTransport();
    transport.authenticated.add('dev_remote');
    const provider = new RemoteProvider(transport);
    const abort = new AbortController();
    const pending = provider.execute(providerRequest(), abort.signal);
    abort.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
    expect(transport.sent).toHaveLength(1);
    provider.close();
  });

  it('reports ambiguous socket loss and never resends the command', async () => {
    const transport = new FakeTransport();
    transport.authenticated.add('dev_remote');
    const provider = new RemoteProvider(transport);
    const pending = provider.execute(providerRequest());
    transport.disconnect('dev_remote');
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'TRANSPORT_UNAVAILABLE', message: expect.stringMatching(/may be unknown/i) }
    });
    transport.authenticated.add('dev_remote');
    expect(transport.sent).toHaveLength(1);
    provider.close();
  });
});
```

Add a fake-timer test with `timeoutMs: 1000` proving the pending call settles exactly once with `REQUEST_TIMEOUT`, its map entry is removed, and a later response with the same ID is ignored. Also emit a response with an unknown `request_id` and assert no pending call settles.

- [ ] **Step 2: Verify RED**

```powershell
npx.cmd vitest run test/remote-provider.test.ts
```

- [ ] **Step 3: Implement the pending request map exactly by request ID**

Use:

```ts
interface PendingRemoteRequest {
  deviceId: string;
  resolve: (result: ProviderResult) => void;
  timer: NodeJS.Timeout;
  removeAbortListener: () => void;
}

private readonly pending = new Map<string, PendingRemoteRequest>();
```

Before sending, reject duplicate local `requestId` values with `INVALID_REQUEST`. Insert the pending entry before `sendRequest` so a synchronous transport failure cannot race an untracked request. On response, timeout, cancellation, disconnect, or `close()`, delete the entry first and settle it second. Never correlate by operation, path, command text, friendly name, or timing.

Convert `ProviderRequest` to `ProtocolRequest` without changing `requestId`/`deviceId`; preserve the same correlation ID across router, wire, response, and audit.

- [ ] **Step 4: Implement disconnect and ambiguity semantics**

When a device socket closes:

```text
mark registry device OFFLINE in transport/coordinator layer
for each pending entry for that device:
  delete pending entry
  clear timeout + abort listener
  resolve TRANSPORT_UNAVAILABLE
  message states the remote execution state may be unknown if request was already sent
```

Do not queue, replay, or resend the request when the same device reconnects. Reads may be retried only by a new caller request with a new `request_id`; the transport/provider itself never auto-replays.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx.cmd vitest run test/remote-provider.test.ts test/multidevice-router.test.ts test/multidevice-transport.test.ts
npm.cmd run typecheck
git add src/main/multidevice/remote-provider.ts src/main/multidevice/transport-server.ts src/main/multidevice/router.ts test/remote-provider.test.ts
git commit -m "feat(core): dispatch correlated remote requests"
```

---

### Task 10: Compose Coordinator into the Core runtime and preserve browserless lifecycle

**Files:**
- Create: `src/main/multidevice/coordinator.ts`
- Modify: `src/main/index.ts` on the known browserless baseline; if Task 1 proves `feat/core-runtime-hardening` already moved Core ownership to a successor composition module, modify that successor instead and leave `src/main/index.ts` as a thin desktop client
- Modify: `src/main/connection.ts` to include the live Coordinator facade in the Core MCP `ToolContext`
- Modify: `src/main/mcp/kernel.ts` to type the optional `multiDevice` facade in `ToolContext`
- Modify only if needed: `src/main/config.ts`, `src/shared/types.ts`, `src/main/mcp/server.ts`
- Test: create `test/multidevice-coordinator.test.ts`
- Extend: `test/background-startup.test.ts`, `test/window-lifecycle.test.ts`, and `test/mcp-shutdown.test.ts` as applicable to the current ownership boundary

**Interfaces:**
- Produces one `MultiDeviceCoordinator` instance owned by the long-lived Core runtime, not by a BrowserWindow/renderer lifecycle.
- Exposes registry, router, pairing manager, audit log, and optional Node transport server to MCP registration through a narrow `MultiDeviceToolFacade` carried by the existing per-request `ToolContext`; MCP modules do not import transport/store singletons directly.

Define the facade in `src/main/multidevice/coordinator.ts`:

```ts
export interface MultiDeviceToolFacade {
  localDeviceId(): string;
  listDevices(): DeviceRecordPublic[];
  createPairingTicket(): { pairingId: string; code: string; expiresAt: string };
  revokeDevice(deviceId: string): Promise<DeviceRecordPublic>;
  execute(deviceId: string, operation: ProtocolOperation, payload: unknown, options?: { timeoutMs?: number }): Promise<ProviderResult>;
}
```

- [ ] **Step 1: Write RED lifecycle tests**

Prove:

```text
Coordinator starts with Core runtime even when no browser window exists
transport remains disabled when listen host is unset
local device exists before any remote node connects
shutdown closes Node listener and rejects outstanding requests
Core restart reloads enrolled device registry but not pairing tickets
```

- [ ] **Step 2: Verify RED**

Run the new coordinator test plus `test/background-startup.test.ts`, `test/window-lifecycle.test.ts`, and `test/mcp-shutdown.test.ts`. If Task 1 proves the hardening branch added a dedicated Core-runtime lifecycle test, include that file in the same command.

- [ ] **Step 3: Wire the Coordinator into the Core runtime composition root**

Use the current `feat/core-runtime-hardening` ownership boundary. Do not attach Coordinator lifetime to renderer, tray, BrowserWindow, or extension connection. Initialize it before ordinary Core connection/autoconnect can build an MCP server. `connection.ts` must place the current facade on `ToolContext.multiDevice`; `startMcpServer` continues to obtain context per request so a restarted/disabled transport does not require rebuilding tool handlers.

- [ ] **Step 4: Run lifecycle regression tests GREEN**

```powershell
npx.cmd vitest run test/multidevice-coordinator.test.ts
npm.cmd run typecheck
npm.cmd run build
```

Also run `test/background-startup.test.ts`, `test/window-lifecycle.test.ts`, and `test/mcp-shutdown.test.ts`; include any dedicated hardening-runtime lifecycle test identified in Task 1.

- [ ] **Step 5: Commit**

```powershell
git add src/main/multidevice/coordinator.ts src/main/connection.ts src/main/mcp/kernel.ts src/main/mcp/server.ts src/main/config.ts src/shared/types.ts src/main/index.ts test/multidevice-coordinator.test.ts test/background-startup.test.ts test/window-lifecycle.test.ts test/mcp-shutdown.test.ts
git commit -m "feat(core): own multi-device coordinator in runtime"
```

On a hardening tree where Task 1 proves Core composition already moved out of `src/main/index.ts`, substitute that one existing successor composition file for `src/main/index.ts` in this command. Do not modify both composition roots.

---

### Task 11: Extend the existing seven MCP tools with device management and explicit targeting

**Files:**
- Modify: `src/main/mcp/tools-core.ts` for `read`, `apply_patch`, and `exec_command` targeting adapters
- Modify: `src/main/mcp/session-tool.ts` for device-management actions; preserve every session/execution action already present on the Task 1 hardening baseline
- Modify: `src/main/mcp/kernel.ts` only as required by the `ToolContext.multiDevice` facade from Task 10
- Modify: `src/main/mcp/surfaces.ts` only if descriptive text needs updating; Core tool names/count remain unchanged
- Modify: `test/mcp.test.ts`
- Create: `test/multidevice-mcp.test.ts`

**Interfaces:**
- `session` adds these actions to its existing action union:

```text
device_list
device_pairing_create
device_revoke
```

- `device_revoke` requires exact `device_id` and refuses the persisted local device.
- `read`, `apply_patch`, and `exec_command` add optional `device_id: string`.
- Omitted `device_id` resolves to `ToolContext.multiDevice.localDeviceId()` when the facade is available; if multi-device management is disabled/unavailable, omission follows the existing local path exactly.
- Remote `exec_command` rejects PTY/interactive usage in the MVP.
- `write_stdin` remains local-only and receives no `device_id` field.

- [ ] **Step 1: Write RED discovery/schema tests**

Assert the Core tool-name set remains exactly:

```ts
['agents', 'apply_patch', 'exec_command', 'read', 'session', 'view_image', 'write_stdin']
```

For hardening configurations where permission gating hides some tools, compare the declared Core surface set separately from the permission-filtered live list; never add an eighth name.

Also assert:

```text
session action enum contains all pre-existing Task 1 actions plus device_list/device_pairing_create/device_revoke
read schema accepts optional device_id
apply_patch schema accepts optional device_id
exec_command schema accepts optional device_id
write_stdin schema does not accept device_id
```

- [ ] **Step 2: Write RED behavior tests with a typed facade double**

Use this minimal facade fixture rather than mocking WebSockets in MCP tests:

```ts
import { vi } from 'vitest';
import type { MultiDeviceToolFacade } from '../src/main/multidevice/coordinator.js';

export function fakeMultiDevice(): MultiDeviceToolFacade {
  return {
    localDeviceId: () => 'dev_local',
    listDevices: () => [],
    createPairingTicket: () => ({
      pairingId: 'pair_1',
      code: 'PAIRING_CODE_FOR_TEST_ONLY',
      expiresAt: '2026-09-05T10:10:00.000Z'
    }),
    revokeDevice: vi.fn().mockResolvedValue({ deviceId: 'dev_remote', status: 'REVOKED' }),
    execute: vi.fn().mockResolvedValue({ ok: true, result: { marker: 'routed' } })
  } as MultiDeviceToolFacade;
}
```

Cover:

```text
session device_list returns stable public device metadata
session device_pairing_create returns code + expiry but no key/token/private material
session device_revoke forwards only the exact remote device_id and rejects local device_id
read without device_id targets dev_local through the router adapter when multi-device facade is active
read with remote device_id targets only that ID
apply_patch with remote device_id requires filesystem.write through router policy
exec_command with remote device_id requires terminal.exec through router policy
unknown device_id returns DEVICE_NOT_FOUND
remote tty:true returns INVALID_REQUEST before remote dispatch
write_stdin remains current local behavior and cannot target remote sessions
search/read recording actions still return the existing session-recording disabled result when recording is off
```

- [ ] **Step 3: Verify RED**

```powershell
npx.cmd vitest run test/multidevice-mcp.test.ts test/mcp.test.ts
```

- [ ] **Step 4: Extend `session-tool.ts` without bypassing its existing action validation**

Keep one discriminated/validated schema. Add only the fields needed by device actions:

```text
device_id: required only for device_revoke
```

Handler ordering:

```text
if action is a recording/search/read action -> apply the existing sessionToolsLive gate and existing behavior unchanged
if action is device_list -> require ctx.multiDevice, return listDevices()
if action is device_pairing_create -> require ctx.multiDevice, return createPairingTicket()
if action is device_revoke -> require ctx.multiDevice + device_id, reject local ID, await revokeDevice(device_id)
otherwise -> preserve the current hardening branch's existing execution/session actions exactly
```

Do not gate device-management actions on session recording being enabled. If the current hardening branch registers `session` only when recording is enabled, broaden the registration condition so the same `session` tool remains present when `ToolContext.multiDevice` exists. Do not create another tool.

Because `device_revoke` and pairing creation are mutations, the `session` tool must not claim `readOnlyHint: true` after these actions are added. Preserve a conservative non-read-only annotation already present on the hardening branch, or change the browserless read-only annotation to `readOnlyHint: false`. Do not falsely advertise a mixed read/write tool as read-only merely to avoid confirmation UI.

- [ ] **Step 5: Adapt the three remote-capable tool handlers**

For each handler:

```text
validate existing local arguments + optional device_id
if no multiDevice facade -> run the exact existing local implementation and reject a supplied device_id as unavailable
resolve target = device_id ?? localDeviceId()
apply the existing live Core permission gate before either route (remote capability never elevates Core permission)
if target is local -> use LocalProvider/extracted operation so behavior remains equivalent and live roots/caps are re-read
if target is remote -> build the corresponding protocol payload and call facade.execute(target, operation, payload)
format normalized provider result back into the existing tool's model-facing response shape
```

Do not put WebSocket, key, registry persistence, or filesystem implementation code into `tools-core.ts` or `session-tool.ts`.

- [ ] **Step 6: Verify GREEN, annotations, and tool-count compatibility**

```powershell
npx.cmd vitest run test/multidevice-mcp.test.ts test/mcp.test.ts
npm.cmd run typecheck
npm.cmd run build
```

Expected: declared Core tool names still total exactly seven; no eighth `devices`/`node` tool exists.

- [ ] **Step 7: Commit**

```powershell
git add src/main/mcp/tools-core.ts src/main/mcp/session-tool.ts src/main/mcp/kernel.ts src/main/mcp/surfaces.ts test/mcp.test.ts test/multidevice-mcp.test.ts
git commit -m "feat(mcp): target enrolled devices explicitly"
```

---

### Task 12: Add Node Agent build/run entrypoint without turning it into a Windows service yet

**Files:**
- Modify: `package.json`
- Create: `scripts/run-node-agent.mjs`
- Modify: `electron.vite.config.ts` so `src/node-agent/main.ts` is emitted as a second Node-compatible main entry
- Test: `test/node-agent-build.test.ts`

**Interfaces:**
- Produces an npm command that launches the built Node Agent with a config path:

```powershell
npm.cmd run node-agent -- --config C:\COS-MultiDevice-Test\node-agent.json
```

- Does not install Task Scheduler or a Windows Service in the MVP.

- [ ] **Step 1: Write RED build smoke test**

```ts
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Node Agent production entrypoint', () => {
  it('is emitted by the normal build and --help has no runtime side effects', () => {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { stdio: 'pipe' });
    const entry = 'out/main/node-agent/main.js';
    expect(existsSync(entry)).toBe(true);
    const help = execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
    expect(help).toContain('node-agent --config');
  }, 120_000);
});
```

The `--help` code path from Task 8 must return before config/identity/socket initialization, so this smoke test proves it can execute safely without network setup.

- [ ] **Step 2: Verify RED**

```powershell
npx.cmd vitest run test/node-agent-build.test.ts
```

- [ ] **Step 3: Extend existing build system minimally**

Modify `electron.vite.config.ts` to keep `src/main/index.ts` as the Electron main entry and add `src/node-agent/main.ts` as a second Rollup input. Use the exact input keys below so the built path is deterministic:

```ts
main: {
  plugins: [externalizeDepsPlugin()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/main/index.ts'),
        'node-agent/main': resolve(__dirname, 'src/node-agent/main.ts')
      }
    }
  }
}
```

If Task 1 proves the hardening branch already changed the main input path, preserve that verified existing main entry and add only the `'node-agent/main'` input beside it. Do not introduce a parallel compiler.

- [ ] **Step 4: Add package command and launcher**

Add to `package.json`:

```json
"node-agent": "node scripts/run-node-agent.mjs"
```

Implement `scripts/run-node-agent.mjs` as a thin exit-code-preserving launcher:

```js
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const entry = resolve('out/main/node-agent/main.js');
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
});
child.on('error', (error) => {
  console.error(`node-agent launcher failed: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`node-agent exited by signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
```

Arguments after `npm run node-agent --` are forwarded verbatim. The launcher contains no endpoint, token, key, pairing code, or machine-specific path.

- [ ] **Step 5: Run GREEN**

```powershell
npm.cmd run build
npx.cmd vitest run test/node-agent-build.test.ts
node .\out\main\node-agent\main.js --help
```

The known browserless build emits under `out/main`; configure the second input to emit `out/main/node-agent/main.js`, assert that exact path in the smoke test, and make the package script launch that exact file.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json electron.vite.config.ts scripts/run-node-agent.mjs test/node-agent-build.test.ts
git commit -m "build(node): package the Windows node agent"
```

---

### Task 13: Add loopback end-to-end tests for pairing, remote read/patch/command, disconnect, and revocation

**Files:**
- Create: `test/multidevice-e2e.test.ts`
- Modify test utilities only if required for free-port allocation/temp roots

**Interfaces:**
- Test launches Coordinator transport and Node Agent client in-process/on loopback with temp state directories.
- Uses the same protocol, pairing, identity, policy, router, providers, and executor used in production.

- [ ] **Step 1: Write RED end-to-end test for enrollment and listing**

Flow:

```text
create Coordinator temp state
create pairing ticket
start Node with temp identity + pairing code
wait for authenticated ONLINE state
list devices
assert exactly one local + one remote stable device record
```

- [ ] **Step 2: Add remote filesystem read test**

Create a file inside the Node temp approved root, route `filesystem.read`, and assert exact content. Then attempt an outside-root path and assert `ROOT_DENIED`.

- [ ] **Step 3: Add remote patch test**

Patch a file inside the approved root with `filesystem.write` enabled and verify actual filesystem content. Remove capability and assert `CAPABILITY_DENIED` without file change.

- [ ] **Step 4: Add remote command test**

Execute a deterministic Windows command such as:

```text
powershell -NoProfile -Command "Write-Output COS_REMOTE_OK"
```

through the same command operation path and assert exit code 0 plus stdout containing `COS_REMOTE_OK`.

- [ ] **Step 5: Add disconnect/reconnect and non-reroute tests**

Close the Node socket, assert registry becomes `OFFLINE`, target the remote device and assert `DEVICE_OFFLINE`, then reconnect the same identity and assert the same stable `device_id` returns `ONLINE`. Assert no request executes on LocalProvider during the outage.

- [ ] **Step 6: Add revocation test**

Revoke the remote device, reconnect using the valid old key, and assert it remains rejected with `DEVICE_REVOKED` until a fresh enrollment decision creates a different trusted enrollment.

- [ ] **Step 7: Run the complete E2E test GREEN**

```powershell
npx.cmd vitest run test/multidevice-e2e.test.ts
```

- [ ] **Step 8: Commit**

```powershell
git add test/multidevice-e2e.test.ts
git commit -m "test(core): verify multi-device flow end to end"
```

---

### Task 14: Run full security/regression verification and perform a real two-Windows-node smoke test

**Files:**
- Create: `docs/testing/multi-device-windows-smoke.md`
- Modify production/test files only for defects proven by failing tests during this task

**Interfaces:**
- Produces repeatable acceptance evidence for the approved MVP.

- [ ] **Step 1: Run targeted multi-device suite**

```powershell
npx.cmd vitest run `
 test/multidevice-protocol.test.ts `
 test/device-registry.test.ts `
 test/multidevice-pairing.test.ts `
 test/multidevice-policy.test.ts `
 test/multidevice-audit.test.ts `
 test/multidevice-router.test.ts `
 test/multidevice-transport.test.ts `
 test/node-agent-identity.test.ts `
 test/node-agent-executor.test.ts `
 test/remote-provider.test.ts `
 test/multidevice-coordinator.test.ts `
 test/multidevice-mcp.test.ts `
 test/node-agent-build.test.ts `
 test/multidevice-e2e.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run existing Core regression gates**

```powershell
npm.cmd test -- test/mcp.test.ts
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

Then run the repository’s full verification command from `package.json` discovered in Task 1. If both `verify` and `verify:ci` exist, run `verify` locally first and run `verify:ci` when its known environment prerequisites are satisfied. Do not reinterpret an unrelated historical privacy failure as a multi-device regression.

- [ ] **Step 3: Security-focused manual/automated checks**

Verify all of these explicitly and record results:

```text
forged device_id -> DEVICE_NOT_FOUND or auth rejection
replayed pairing secret -> PAIRING_INVALID
expired pairing secret -> PAIRING_EXPIRED
wrong signature -> AUTHENTICATION_FAILED
revoked identity reconnect -> DEVICE_REVOKED
path traversal -> ROOT_DENIED
Windows reparse-point escape -> ROOT_DENIED
missing capability -> CAPABILITY_DENIED
remote PTY request -> INVALID_REQUEST
transport loss during command -> no automatic retry
remote failure -> never executes locally
wildcard production listen host -> startup rejection
```

- [ ] **Step 4: Perform the real second-Windows-device smoke over Tailscale**

Before this live smoke, **do not** launch a second test Core beside the user's installed Core while the normal Chrome extension is polling its fixed Core ports. Use the isolated strategy established in the existing browserless tests: a disposable Core user-data directory and, if a ChatGPT-facing browser smoke is required, a disposable Chrome profile/worktree extension so the installed session cannot attach to the wrong Core. If that isolation cannot be proven, perform the transport/E2E smoke through the in-repo harness and record the ChatGPT-facing live smoke as blocked rather than disturbing the installed session.

On the Coordinator PC, in the isolated feature worktree:

```powershell
$tailscaleIp = (& tailscale.exe ip -4 | Select-Object -First 1).Trim()
if (-not $tailscaleIp) { throw 'No Tailscale IPv4 address found' }
$env:CHAT_ON_STEROIDS_NODE_LISTEN_HOST = $tailscaleIp
$env:CHAT_ON_STEROIDS_NODE_LISTEN_PORT = '8788'
$env:COS_DEV_USER_DATA = 'C:\COS-MultiDevice-Test\coordinator-user-data'
npm.cmd run dev
```

Using the isolated feature Core connector, create one pairing ticket with `session(action="device_pairing_create")`. Copy only the short-lived pairing code to the second PC; never place it in docs or logs.

On the second Windows PC, use the same feature commit/build. Set `$coordinatorIp` to the Coordinator's actual Tailscale IPv4 and `$pairingCode` to the one-time value just returned by the isolated Core, then create the local-only config without printing it:

```powershell
$coordinatorIp = (& tailscale.exe ip -4 | Select-Object -First 1).Trim() # Replace with the Coordinator PC's Tailscale IPv4 if this machine returns its own address.
$pairingCode = Read-Host 'Paste the one-time Chat On Steroids pairing code'
$configPath = 'C:\COS-MultiDevice-Test\node-agent.json'
New-Item -ItemType Directory -Force C:\COS-MultiDevice-Test\workspace | Out-Null
@{
  coordinator_url = "ws://${coordinatorIp}:8788"
  friendly_name = 'Ibrahim Laptop Test'
  state_dir = 'C:\COS-MultiDevice-Test\node-state'
  capabilities = @('filesystem.read', 'filesystem.write', 'terminal.exec')
  approved_roots = @('C:\COS-MultiDevice-Test\workspace')
  pairing_code = $pairingCode
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
Set-Content -LiteralPath C:\COS-MultiDevice-Test\workspace\marker.txt -Value 'COS_REMOTE_FILE_OK'
npm.cmd run node-agent -- --config $configPath
```

Do not echo `$pairingCode`, commit the config, or copy the generated config into the smoke document. After successful enrollment, verify the Node Agent atomically removed `pairing_code` from that local config file.

Then from ChatGPT/Core verify:

```text
device_list shows local + remote ONLINE
remote read succeeds inside approved root
remote patch succeeds inside approved root
remote command prints a deterministic marker
outside-root read fails
remove terminal capability and command fails
disconnect Node and status becomes OFFLINE
restart Node and the same device_id returns ONLINE
revoke Node and reconnect is rejected
```

- [ ] **Step 5: Write the repeatable smoke document**

`docs/testing/multi-device-windows-smoke.md` must contain prerequisites, exact config fields, pairing steps, expected statuses, negative security checks, cleanup, and the final observed pass/fail results. Do not include live pairing codes, private keys, bearer tokens, or secret URLs.

- [ ] **Step 6: Final verification after any smoke-discovered fixes**

```powershell
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

Re-run every test touched by a smoke-discovered defect and the full multi-device suite.

- [ ] **Step 7: Commit documentation and verified fixes**

```powershell
git status --short
git add docs/testing/multi-device-windows-smoke.md
git commit -m "test(core): validate two-device Windows MVP"
```

If the smoke exposes a product defect, fix it in a separate RED→GREEN task-sized commit before this documentation commit. Do not hide production changes inside the smoke-documentation commit.

---

## Acceptance Checklist

Before declaring the feature complete, all items below must be evidenced by tests or the real two-PC smoke:

- [ ] Core lists the persistent local device and at least one enrolled remote Windows device.
- [ ] Local and remote devices have stable opaque IDs.
- [ ] Friendly names can duplicate without changing identity semantics.
- [ ] Existing local `read`, `apply_patch`, and `exec_command` calls without `device_id` still work.
- [ ] Explicit remote `device_id` routes only to that device.
- [ ] Unknown/offline/revoked devices return deterministic errors.
- [ ] Remote filesystem read cannot escape approved roots, including Windows reparse-point escape.
- [ ] Remote patch requires `filesystem.write` and remains root-confined.
- [ ] Remote command requires `terminal.exec` and an approved working directory; acceptance evidence explicitly states that arbitrary command content is full user-context execution, not an approved-root filesystem sandbox.
- [ ] Remote PTY/interactive continuation is rejected explicitly for the MVP.
- [ ] Pairing is single-use and expires after 10 minutes.
- [ ] Reconnect authenticates by persisted Ed25519 identity.
- [ ] Revoked identity cannot reconnect.
- [ ] No privileged operation silently falls back to another device.
- [ ] Ambiguous transport loss does not trigger automatic command/write replay.
- [ ] Audit events exist for privileged operations and contain no secrets/full output.
- [ ] Node transport is disabled unless an explicit private/Tailscale listen host is configured.
- [ ] Production listener rejects wildcard bind addresses.
- [ ] Core public tool count remains exactly seven.
- [ ] Browserless/Core-runtime lifecycle remains green.
- [ ] Typecheck, production build, targeted tests, and repository regression verification pass or any unrelated pre-existing failure is separately evidenced.
- [ ] Real two-Windows-device Tailscale smoke passes.

## Deferred Follow-Up After MVP

The following are deliberately excluded from this implementation plan and should receive separate specs/plans rather than being folded into this branch:

```text
remote view_image
remote interactive PTY + write_stdin
Desktop observe/control
clipboard
Linux/macOS Node packaging
Windows service/Task Scheduler auto-start for Node
cloud relay/NAT traversal
automatic workload placement
multi-user RBAC
background file synchronization
management dashboard
```

