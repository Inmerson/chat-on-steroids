# OpenClaw-Compatible MCP Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Chat On Steroids to safely register, probe, and project selected third-party MCP tools.

**Architecture:** A main-process registry owns validated external server definitions and lazy connections. An isolated External MCP surface projects selected discovered tools using deterministic names while the renderer uses fixed Core IPC to manage the registry.

**Tech Stack:** TypeScript, Electron, MCP TypeScript SDK, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-openclaw-compatible-mcp-registry-design.md`

## Global Constraints

- Do not merge third-party schemas into Core, Desktop, or Steromi.
- All registry mutation and execution stays in the main/Core process.
- No secrets, OAuth, shell spawning, automatic enablement, or unbounded server output.
- Use OpenClaw-compatible transport labels and safe `server__tool` projection.

---

### Task 1: External server definition and safety policy

**Files:**
- Create: `src/main/mcp/external-registry.ts`
- Test: `test/external-registry.test.ts`

- [ ] Write tests for canonical transport handling, IDs, safe projected names, explicit enablement, and rejected unsafe endpoints/environment keys.
- [ ] Run the test and confirm it fails because the registry module is absent.
- [ ] Implement bounded Zod validation and pure policy helpers.
- [ ] Rerun the focused test.

### Task 2: Lazy external MCP client manager

**Files:**
- Create: `src/main/mcp/external-client.ts`
- Test: `test/external-client.test.ts`

- [ ] Write tests using injected transport factories for lazy discovery, allowlisted projection, disabled-server refusal, timeout/error isolation, and disposal.
- [ ] Run the test and confirm it fails for the missing manager.
- [ ] Implement the manager with transport adapters and bounded lifecycle ownership.
- [ ] Rerun the focused test.

### Task 3: External surface projection

**Files:**
- Modify: `src/main/mcp/surfaces.ts`
- Modify: `src/main/mcp/tools.ts`
- Create: `src/main/mcp/tools-external.ts`
- Test: `test/mcp-external.test.ts`

- [ ] Write a server-level test proving only the External surface registers namespaced selected tools and built-in surfaces reject them.
- [ ] Run the test and confirm it fails.
- [ ] Register an optional external connector and projection adapter.
- [ ] Rerun the focused test.

### Task 4: Core-authoritative registry UI operations

**Files:**
- Modify: `src/shared/core-protocol.ts`
- Modify: `src/main/core/ui-dispatch.ts`
- Modify: `src/main/core/ipc.ts`
- Test: `test/core-ui-dispatch.test.ts`

- [ ] Write tests for validated list/save/probe/remove operations and malformed payload rejection.
- [ ] Run the test and confirm it fails.
- [ ] Add fixed, typed Core UI operations with sanitized results.
- [ ] Rerun the focused test.

### Task 5: Replace renderer-only custom MCP state

**Files:**
- Modify: `src/renderer/plugins-data.ts`
- Modify: `src/renderer/plugins-view.ts`
- Test: `test/renderer-plugins.test.ts`

- [ ] Write a renderer test that verifies custom server state comes from the typed app API and actual health is displayed.
- [ ] Run the test and confirm it fails.
- [ ] Remove localStorage and simulated-health behavior; connect the screen to main-process registry operations.
- [ ] Rerun the focused test.

### Task 6: Verification

**Files:**
- Test: affected tests plus repository typecheck

- [ ] Run focused registry, client, external-surface, Core IPC, and renderer tests.
- [ ] Run `npm run typecheck` and `git diff --check`.
- [ ] Run the security diff scan and report any remaining limitation, especially OAuth being intentionally deferred.
