# Serialized Autonomous Swarms

**Status:** proposed — awaiting user review before implementation  
**Date:** 2026-09-10

## Purpose

Let one initial user instruction drive a multi-part, long-running computer task to
completion without repeatedly asking whether to continue. Keep ChatGPT browser traffic
deliberately small and serialized enough to avoid bursts: two app-originated ChatGPT
turns may be active globally, while work awaiting a model turn remains durable in a
fair queue.

This is not a promise to bypass provider limits or platform rules. It deliberately
reduces automated traffic, backs off on provider errors, and never treats a rate limit
as a reason to create another account, tab, or request path.

## Current state and gap

The existing `agents.ts` broker creates worker conversations and reuses sleeping worker
chats, but owns one active prime run globally. `maxWorkers` is a per-run live-worker
limit, presently constrained to 1..8. `goal.ts` can continue one non-worker
conversation after a settled response, but it explicitly does not drive worker chats.
`execution.ts` persists one approved desktop-execution plan and already supports an
`infinite` mode, but is not a multi-prime, six-worker scheduler.

The requested behavior needs a common scheduling layer rather than independent
per-prime loops:

- many user conversations may have durable autonomous jobs at once;
- at most six owned worker conversations exist across all of them;
- each prime may own at most two worker conversations;
- at most two app-originated ChatGPT turns are awaiting completion globally;
- a worker never receives a second message until the browser has proven its preceding
  turn settled; and
- an accepted top-level goal continues through its whole task graph without seeking a
  routine "continue?" confirmation after each part.

## User-visible contract

### Starting and finishing one goal

The user gives one initial objective. The app records a durable autonomous goal with
its scope and acceptance conditions, then the manager decomposes it into a task DAG.
When a leaf completes, its evidence unlocks the next eligible leaf; the scheduler sends
the next needed instruction automatically. Completion is reported only after every
required leaf is verified, not after a worker's optimistic prose says it is done.

There is no app-level cumulative-token ceiling for an accepted goal. There are still
bounded request bodies, message records, tool outputs, browser waits, retry intervals,
and provider-imposed quotas. This preserves resource safety without arbitrarily ending a
legitimate long task because it has needed many turns.

The app asks the user only when it needs authority or information it cannot safely infer:

- an external, paid, destructive, publish/deploy, credential, or privacy-sensitive
  action;
- an unresolved ambiguity that changes the requested outcome;
- an unrecoverable technical block; or
- a provider/rate-limit suspension that requires waiting beyond automatic backoff.

Routine completed leaves, ordinary test failures, and safe technical choices do not
pause the goal for confirmation.

### Capacity and fairness

The defaults and hard limits for this feature are:

| Limit | Value | Meaning |
| --- | ---: | --- |
| Global active ChatGPT turns | 2 | At most two app-dispatched messages may be waiting for ChatGPT to settle. |
| Global worker conversations | 6 | At most six app-owned worker chats are retained/created across every prime. |
| Worker conversations per prime | 2 | One user conversation cannot monopolize all six chats. |
| Pending tasks | durable/unbounded | Waiting work uses no ChatGPT slot or worker-chat capacity. |

The scheduler uses round-robin selection among eligible primes. With four active prime
goals and capacity for six worker chats, each demanding prime receives one worker before
any prime receives a second, then remaining capacity is assigned to eligible queues in
round-robin order. A prime never receives a third worker. An idle worker may be reused
only by its owning prime; it is not silently pointed at another user's conversation.

Manual user messages are not intercepted or delayed. The two-turn limit governs only
messages the app itself is about to type into conversations it created and owns.

### Long-running behavior

Each goal has checkpoints after task-state changes, browser dispatch, verified tool
effects, retry decisions, and terminal state changes. Restart restores the task graph,
worker ownership, queue order, and the exact prior conversation binding before any new
message is sent. A browser tab or conversation is a replaceable view of durable state,
not the state authority.

The scheduler automatically advances from a verified leaf to the next eligible leaf. It
does not send a bare "continue"; every continuation names the remaining task(s), known
failures, current workspace, and required evidence. It does not expand scope merely to
keep working. `infinite` remains an explicitly selected product mode; standard goals stop
at their accepted objective.

## Scheduling design

### State model

Introduce a durable autonomous-swarm record keyed by a generated `goalRunId`, separate
from a browser conversation id. It contains:

- owner prime conversation id and its exact binding epoch;
- the immutable initial objective plus a versioned accepted task graph;
- each task's state, dependencies, assignment, evidence reference, and retry state;
- up to two worker slots owned by that prime, each bound to one exact worker conversation;
- a global queue entry for every eligible worker dispatch;
- global dispatch leases, each with command id, worker id, target conversation id, and
  browser/turn epoch; and
- safe operational counters: dispatch/retry timestamps and typed terminal reason, never
  hidden reasoning or raw secrets.

Existing durable orchestration/task records should be extended or adapted rather than
creating a competing second DAG. Existing `execution.ts` remains the durable control-plane
owner for desktop execution state; the new swarm record links an execution when a goal is
launched from `session.execution_start`.

### Dispatch state machine

```text
ready task
  -> queued (fair global queue)
  -> leased (one of two global dispatch permits)
  -> browser command claimed
  -> message typed into exact owned worker chat
  -> turn settled by browser evidence
  -> evidence/next task recorded
  -> sleeping worker + next eligible task, completed goal, or safe block
```

A dispatch lease is released only on durable browser receipt plus a proved settled or
terminal outcome. A stale tab, duplicate content script, retry, or A -> B -> A navigation
epoch may not release or reuse a newer lease. A task is never marked complete merely
because the worker's final prose claims success: required tests/tool effects/manager
review are recorded before its dependency edges open.

The global scheduler allocates a permit only when all of these are true:

1. fewer than two permits are active;
2. the chosen prime has fewer than two live or reusable owned workers, or an owned sleeping
   worker is eligible to revive;
3. the exact worker conversation has no unsettled app-originated turn;
4. the task's dependencies have evidence; and
5. the browser identity and worker ownership remain proven.

If no worker slot is available, a ready task remains queued. It does not create an extra
ChatGPT tab.

### Backoff, no-progress, and cancellation

Provider/rate-limit errors pause only the affected dispatch and apply exponential backoff
with jitter. Repeated global provider failures enter a visible global cooldown, so a queue
does not turn an outage into a retry burst. Manual pause/stop is immediate for undispatched
work and prevents future sends; an already-running browser turn is observed rather than
guessed at.

"Unlimited total tokens" does not mean an unobservable infinite loop. The scheduler records
repeated identical continuation requests, absence of a durable task/tool state change, and
repeated same-category failure. After a conservative no-progress threshold it marks the
specific task blocked and reports the evidence instead of silently spending forever. The
parent goal may continue with independent tasks only when doing so cannot invalidate the
blocked task's dependencies.

## Security and privacy invariants

- The MCP server remains the capability authority; the browser bridge only observes and
  delivers app-owned commands. No browser route may gain filesystem, command, configuration,
  or secret access.
- Conversation ownership remains proved through request-id correlation and exact worker
  bindings. No active-tab, timing, or "most recent chat" fallback is permitted.
- Existing sandbox, permission, read-only, external-side-effect, and desktop frame/epoch
  guards apply to every worker exactly as they do to the prime.
- The scheduler persists operational metadata and bounded evidence only. It never stores
  model chain-of-thought, OpenRouter keys, credentials, or raw unbounded tool output.
- Worker output is untrusted evidence, not authority for a mutation or a completion claim.
  The parent/orchestration verifier must re-check required effects.

## UI and model contract

The Chat settings panel replaces the ambiguous single `Sub-agent workers` field with a
clearly labelled autonomous-swarm section:

- `Active ChatGPT turns`: fixed default 2, user-selectable only within the safe hard limit;
- `Total worker chats`: fixed hard cap 6;
- `Worker chats per conversation`: fixed cap 2; and
- a visible queue panel showing goal, owner conversation, worker state, pending task,
  global cooldown, and the exact pause/blocked reason.

The `agents` model-facing contract gains status that distinguishes owned worker chats,
queued tasks, active dispatch leases, and free global capacity. It must not expose a
generic cross-chat send action. The goal/execution prompt says explicitly: complete every
in-scope task and verify it; do not ask the user for routine continuation; never widen the
objective; surface only the defined authority/blocker conditions.

## Migration and compatibility

- Existing `multiAgent.maxWorkers` retains its value as the legacy per-run preference.
  Migration introduces explicit global/per-prime limits without silently increasing any
  user's existing capacity.
- Existing dormant worker histories remain readable and revivable only by their original
  prime. They are not automatically enrolled into an autonomous swarm.
- Existing single execution runs and normal Goal Mode keep their behavior until a user
  starts the new autonomous-swarm mode.
- A deliberate reconnect/restart restores durable queues but sends nothing until exact
  ownership/turn state is verified.

## Acceptance evidence

Implementation is not complete until fresh, reproducible tests prove at least:

1. three primes can own two workers each; a fourth prime cannot exceed the global six but
   receives fair queued progress when capacity becomes eligible;
2. no prime can create a third worker, and no worker can self-spawn;
3. at most two app-originated messages are awaiting settled browser evidence globally;
4. no single worker receives two app-originated messages before the prior turn settles;
5. a single accepted goal proceeds through every verified DAG leaf without a routine
   confirmation message;
6. a restart, duplicate tab, stale browser epoch, or duplicate receipt cannot duplicate a
   send or transfer worker ownership;
7. rate-limit failures back off and do not increase open-tab or active-turn count;
8. blocked external/destructive/ambiguous actions stop only the affected task and surface
   the requested authority boundary;
9. normal sandbox, permission-revocation, read-only, correlation, and cross-prime negative
   tests still fail closed; and
10. telemetry emits safe task/lease/retry/outcome data without secrets or hidden reasoning.

The expected affected test areas are `agents`, `swarm`, `bridge`, `goal`, `execution`,
orchestration scheduler/store/recovery suites, `config`, and renderer state/layout tests.
The implementation plan must add exact tests and Evidence Engine gates after this design is
reviewed.
