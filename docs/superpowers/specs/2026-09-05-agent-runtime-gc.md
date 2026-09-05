# Agent Runtime Garbage Collector Specification

## Goal

Add a safe garbage collector for runtime resources owned by Chat On Steroids agents without deleting reusable worker history.

## Approved lifecycle policy

- A sleeping worker keeps its ChatGPT conversation, transcript/history, worktree/workspace association, inbox, agent identity, and `revivable=true` state.
- Runtime cleanup is separate from broker/history cleanup.
- A sleeping worker becomes eligible for runtime cleanup only after 30 minutes.
- Eligibility is measured from the later of the worker's `sleptAt` and the runtime process's `lastUsed` timestamp.
- `active`, `detached`, `invited`, and `waking` workers are never cleaned by the periodic GC.
- The periodic GC must never terminate a process whose exact ChatGPT conversation ownership is unknown.
- Process names (`node.exe`, `codex.exe`, browser names, etc.) are never used as ownership evidence.
- The GC is initially limited to processes created and tracked by `UnifiedExecProcessManager`.
- Existing browser-tab lease/lifecycle behavior is not replaced by this feature.

## Ownership authority

The exact ChatGPT `conversationId` is the runtime ownership key. Friendly ids such as `worker-1` are presentation identifiers only and are not globally unique across parked Prime histories.

The existing `codex/ownership.ts` registry remains the source of `processId -> conversationId` attribution. A process is eligible only when:

1. the live UnifiedExec session is present,
2. its owner is a non-empty exact conversation id,
3. that conversation still belongs to a worker,
4. the worker is still `sleeping` and `revivable`,
5. the worker has been sleeping for at least 30 minutes, and
6. the process has not been used within the last 30 minutes.

The manager must re-check process activity under its existing per-process interaction lock immediately before termination. A busy or recently-used session is skipped rather than killed.

## Explicit clear behavior

An explicit user clear is stronger than the periodic retention policy.

- Clearing one worker: after the broker mutation is made durable, terminate only UnifiedExec sessions whose exact owner is that worker conversation.
- Clearing the visible Prime row/run: after the clear is durable, terminate sessions owned by conversations in that visible run only.
- `Clear swarm`: capture all exact agent-owned UnifiedExec targets before destroying broker history; after the reset is durable, terminate only those captured targets whose ownership has not changed.
- A failed durability barrier must not trigger runtime cleanup.

## Periodic maintenance

Run a coarse process-lifetime maintenance timer every 30 seconds. It must be `unref()`'d so it cannot keep Electron alive. Only one sweep may be in flight at once. Stop the timer when final Electron shutdown begins; the existing app-wide `terminateAllProcesses()` remains the final shutdown authority.

## Safety invariants

1. **No proven owner, no kill.** Unknown or null ownership is always skipped.
2. **No process-name inference.** Ownership comes only from the existing registry.
3. **No history deletion.** Periodic GC never mutates the agent broker state.
4. **No active-worker GC.** Periodic cleanup applies only to `sleeping + revivable` workers.
5. **Recent use wins.** A later `write_stdin`/poll refreshes `lastUsed` and postpones cleanup.
6. **Busy session wins.** If the interaction lock is held, periodic GC skips the process.
7. **Ownership is revalidated.** Explicit-clear cleanup rechecks that a captured process still belongs to the captured conversation before terminating it.
8. **Shutdown remains authoritative.** The new GC does not replace the existing shutdown process-tree cleanup.

## Out of scope for this tranche

- CPU/RAM measurement per worker.
- Windows Job Objects.
- Killing arbitrary orphan `node.exe`/browser/MCP processes not created by UnifiedExec.
- Control Center GC buttons or configurable retention UI.
- Dynamic worker scheduling.

