# Agent System 3.0 — Orchestration Architecture Design

Date: 2026-09-02
Status: Approved design
Repository: `Inmerson/chat-on-steroids`

## 1. Purpose

Agent System 3.0 turns the existing multi-agent broker into a coordinated execution system. The user gives one goal to the Prime agent. Prime creates a plan, a dedicated Manager agent converts that plan into a dependency-aware task graph, execution workers handle independent tasks in parallel, reviewers verify worker outputs, an integration controller combines approved work, and verification gates prove the integrated result before Prime reports completion.

The design deliberately separates model reasoning from deterministic state management:

> LLMs decide where judgment is required. The orchestration kernel owns state, invariants, limits, retries, ownership, lifecycle transitions, and evidence.

A second foundational rule is:

> An agent is a durable conversation identity, not a browser tab.

Browser tabs are temporary transport resources. Normal worker and reviewer tabs are opened only long enough to deliver work or inspect a conversation, then closed as soon as the handoff is durably proven.

## 2. Goals

Agent System 3.0 must:

- decompose a Prime plan into dependency-aware task nodes;
- run all safely independent nodes in parallel within configured worker capacity;
- assign one Manager agent to orchestrate the run;
- reuse suitable sleeping workers before opening unnecessary new conversations;
- isolate coding workers in separate Git worktrees;
- require review before a worker task can be integrated;
- use a shared reviewer pool for ordinary work and specialist reviewers for high-risk work;
- integrate only approved task outputs in a dedicated integration workspace;
- require fresh execution evidence before a run can be reported complete;
- keep browser tab usage bounded even when the run owns many workers;
- close normal agent bootstrap/revival tabs after durable handoff;
- survive app restarts, Chrome crashes, lost tabs, and Manager replacement without losing run identity;
- keep user-owned browser tabs outside automatic agent cleanup;
- prevent unbounded retry, review, or spawn loops;
- expose a compact Control Center centered on runs and tasks rather than a wall of worker chats.

## 3. Non-goals

Version 3 does not attempt to build a general distributed compute platform, a cross-machine scheduler, or an unbounded autonomous deployment system. It does not bypass provider rate limits. It does not allow recovery logic to invent new product or architecture decisions. It does not grant the system authority over browser tabs it did not create and register as agent-owned resources.

## 4. High-level architecture

```text
USER
  |
  v
PRIME
  |
  v
MANAGER AGENT
  |
  +--> Task Graph / DAG Scheduler
  +--> Worker Allocator
  +--> Reviewer Router
  +--> Recovery Controller
  +--> Tab Lease Manager
  +--> Integration Controller
  |
  +--> Worker A ---- worktree A --+
  +--> Worker B ---- worktree B --+--> Reviewer System
  +--> Worker C ---- worktree C --+       |
                                           v
                                  Integration Controller
                                           |
                                           v
                                  Verification Engine
                                           |
                                           v
                                    System Reviewer
                                           |
                                           v
                                         PRIME
                                           |
                                           v
                                          USER
```

### 4.1 Prime

Prime is the only user-facing orchestration participant. It translates the user's goal and constraints into a plan and receives final run status from Manager. Prime does not manually count worker slots, manage tab ownership, or enforce retry budgets.

### 4.2 Manager agent

Manager is the orchestration brain. It makes judgment-heavy decisions such as task decomposition refinements, worker specialization, re-planning, escalation, and whether a new specialist task is justified.

Manager does not directly own deterministic correctness rules. The kernel validates every requested transition and action.

### 4.3 Orchestration kernel

The kernel owns:

- DAG state and dependency readiness;
- worker/reviewer capacity;
- worker and task state machines;
- worktree ownership;
- tab leases and tab budget;
- retry and review-round counters;
- durable event recording;
- recovery and reconciliation;
- verification freshness;
- policy and approval boundaries.

## 5. Task graph and scheduling

Prime's plan is stored as a directed acyclic task graph rather than an ordered list. A task is schedulable only when all required dependencies are satisfied.

Example:

```text
T1 Database ----> T2 API ----> T4 Auth --+
                                        +--> T5 Integration --> T6 Release
T3 UI ----------------------------------+
```

The scheduler rule is:

> Every ready independent task may receive a worker, subject to worker capacity and resource policy.

If five plan nodes are genuinely independent and capacity permits, Manager may run five workers in parallel. If a node depends on another unfinished node, it remains blocked even if an idle worker exists.

The graph may grow during execution. A worker may report a newly discovered dependency or specialist requirement, but it cannot silently expand its own scope. It requests a graph change; Manager decides whether to create a subtask.

## 6. Worker allocation and reuse

Workers have capability metadata such as backend, React, database, testing, security, or deployment experience. Capability metadata is advisory; deterministic ownership remains task- and conversation-based.

Allocation preference:

1. reuse a suitable sleeping worker that retains useful project context;
2. otherwise wake or create a worker that fits the task;
3. create a specialist only when the task justifies it;
4. never create replacement workers merely because a transient transport problem occurred.

`MAX_ACTIVE_WORKERS` limits simultaneous working workers. Sleeping workers remain members of a run but do not consume an active worker slot.

## 7. Task contracts

Each worker receives a structured Task Contract containing:

- task id and title;
- goal;
- allowed scope;
- explicit dependencies;
- acceptance criteria;
- risk class;
- expected verification;
- forbidden or user-owned actions.

A worker may not expand its scope autonomously. If necessary work exceeds the contract, it sends a scope-change or blocker report to Manager.

## 8. Worker completion package

A worker does not finish a task by merely saying "done" in prose. It submits a structured Completion Package that includes:

- task id;
- ready-for-review status;
- changed files or worktree revision;
- verification commands actually run;
- known risks or limitations;
- integration notes.

The preferred lifecycle signal is an explicit `agents.finish`-style protocol recorded by the broker. Page observation may provide supporting evidence but is not the sole completion mechanism.

## 9. Reviewer architecture

Review uses a hybrid model.

### 9.1 Shared reviewer pool

Ordinary tasks enter a shared reviewer queue. Idle reviewers take the next compatible task.

### 9.2 Specialist reviewers

High-risk work may receive a dedicated reviewer. Examples include authentication/security, database migrations, permissions, release/deployment, or similarly consequential changes.

### 9.3 Review outcomes

A review has exactly three operational outcomes:

- `APPROVED`
- `CHANGES_REQUESTED`
- `BLOCKED`

`CHANGES_REQUESTED` returns the task to the same worker when practical so retained context is reused. `BLOCKED` returns control to Manager for dependency or plan evaluation.

`MAX_REVIEW_ROUNDS` prevents infinite worker-review loops. The initial default is 3. Exhaustion requires Manager to choose a specialist replacement, re-plan the task, or escalate through Prime.

## 10. Worktree isolation

Each coding worker receives a dedicated Git worktree/branch. Workers do not share a mutable coding workspace.

A worker's review approval means only that its task is acceptable within its own scope. It does not authorize direct modification of `main` or equivalent production branches.

Approved work enters an integration queue and is applied in a dedicated integration worktree under Integration Controller ownership.

## 11. Integration controller

The Integration Controller:

- applies approved task revisions in dependency-safe order;
- detects textual Git conflicts;
- flags semantic overlap risk;
- requests an Integration Specialist when resolution requires judgment;
- invalidates stale verification evidence after any integrated code change;
- never treats a task-level approval as project-level approval.

An Integration Specialist receives a bounded integration package: relevant task intents, changed files/diffs, acceptance criteria, review findings, and failing checks. It does not need every worker transcript by default.

## 12. Verification and completion

A run is not complete because workers or reviewers claim success. Verification must be based on recorded execution evidence tied to the current integrated revision.

A `VerificationRecord` includes at minimum:

- gate name/command;
- exit status or equivalent result;
- start and finish times;
- exact workspace revision;
- bounded output digest or evidence reference.

A verification result is stale when its tested revision differs from the current integration revision.

Project-specific gates may include targeted tests, full tests, typecheck, build, lint, browser smoke tests, migration validation, or other required checks.

Large runs end with a System Reviewer that evaluates the original user goal, integrated result, task graph, acceptance criteria, review results, and fresh verification evidence.

A run may enter `RUN_VERIFIED` only when all required tasks are approved and integrated, no unresolved conflicts remain, all required verification gates are fresh passes, and final system review is approved.

## 13. Agent lifecycle

The orchestration state machine is independent from browser tab state.

Typical task/worker flow:

```text
CREATED
  -> BOOTSTRAPPING
  -> ACTIVE
  -> READY_FOR_REVIEW
  -> REVIEWING
  -> APPROVED
  -> SLEEPING
```

Review may return the worker to `ACTIVE`, and blockers may move work into `BLOCKED`. Terminal states include unrecoverable failure, retirement, or context exhaustion.

Sleeping workers retain their conversation identity and may be revived later.

Closing a tab never by itself means the worker failed or ended.

## 14. Ephemeral agent tabs and Tab Lease Manager

This is a hard architectural requirement.

> Worker identity and lifecycle must never depend on an open browser tab.

Every automatically managed agent tab has an explicit `TabLease` record with:

- lease id;
- agent id;
- conversation id when known;
- purpose;
- opened time;
- last activity time;
- handoff state;
- close policy;
- ownership marker proving the system created or adopted it as an agent resource.

Lease purposes include:

- `bootstrap`
- `revival`
- `browser_task`
- `inspection`
- `manual_user_view`

Normal close policies:

- bootstrap: close after durable handoff;
- revival: close after the new message is durably accepted;
- inspection: close when inspection completes;
- browser task: remain open only while explicitly required;
- manual user view: never auto-close.

Unknown ChatGPT tabs are user-owned by default and must not be automatically closed.

## 15. Durable handoff before tab close

A normal bootstrap tab may close only after the kernel has evidence equivalent to:

```text
TAB_OPENED
-> CONVERSATION_BOUND
-> BOOTSTRAP_SUBMITTED
-> CHATGPT_ACCEPTED
-> COMMAND_ACK_PERSISTED
-> HANDOFF_DURABLE
-> TAB_CLOSE_ALLOWED
```

The exact implementation may collapse internal steps where existing protocol guarantees are already stronger, but the externally observable invariant is unchanged: a normal bootstrap tab is not closed merely because a click/send attempt occurred.

A rate-limit acknowledgement or transient send failure may use a bounded retry policy. It must not create an infinite retry loop and must not bypass provider rate limits.

If bootstrap permanently fails, the worker enters a bootstrap failure state, Manager is informed, and the owned failed tab is cleaned up rather than left open indefinitely.

## 16. Hard browser tab budget

Agent tab concurrency is controlled independently from worker concurrency.

Initial policy:

- `MAX_AGENT_TABS = 5`

The system may own dozens or hundreds of worker identities while no more than the configured number of agent-managed tabs are simultaneously open.

When the tab budget is full, additional bootstrap/revival requests wait in a lease queue. Releasing a lease makes capacity available for the next request.

## 17. Tab watchdog and recovery

The kernel periodically reconciles registered leases with browser reality.

A stale lease may be safely released when handoff is durable and no browser-bound task remains. A lease without durable handoff enters recovery instead of being silently closed as successful.

On restart or Chrome recovery, the system examines only known agent-owned resources. Unknown tabs remain untouched.

## 18. Failure classification and retry

Manager and kernel distinguish at least four classes:

- transient transport/provider failure;
- task/implementation failure;
- worker/context/workspace failure;
- architecture/plan failure.

Policy:

- transient failure -> bounded retry;
- task failure -> correction by the same worker when appropriate;
- worker failure -> replacement or specialist worker;
- architecture failure -> Manager re-plan or Prime escalation.

Retry counters are deterministic kernel state. A model cannot reset its own exhausted budget.

## 19. Durable state model

Core durable records include:

- `RunRecord`
- `TaskRecord`
- `AgentRecord`
- `ReviewRecord`
- `VerificationRecord`
- `IntegrationRecord`
- `TabLease`

The task state machine uses explicit states such as:

```text
PLANNED -> READY -> ASSIGNED -> ACTIVE -> READY_FOR_REVIEW
-> REVIEWING -> APPROVED -> INTEGRATING -> INTEGRATED -> VERIFIED
```

with controlled alternatives including `CHANGES_REQUESTED`, `BLOCKED`, `FAILED`, `CANCELLED`, and `SUPERSEDED`.

The kernel rejects invalid transitions.

## 20. Snapshot plus append-only orchestration journal

Agent System 3.0 extends the existing durable store with a hybrid snapshot/event-journal model.

Each important transition is recorded as an append-only orchestration event containing:

- strictly increasing sequence number;
- event id;
- run id;
- timestamp;
- event type;
- actor;
- entity id;
- bounded payload.

Example events include `TASK_READY`, `WORKER_ASSIGNED`, `TAB_LEASE_CREATED`, `CONVERSATION_BOUND`, `TASK_HANDOFF_ACCEPTED`, `COMMAND_ACK_DURABLE`, `TAB_LEASE_RELEASED`, `WORKER_COMPLETION_REPORTED`, `REVIEW_REQUESTED`, `INTEGRATION_INTENT`, and `VERIFICATION_RECORDED`.

Startup recovery loads the latest verified snapshot, replays later journal events, validates the resulting graph, reconciles external resources, and resumes scheduling only after reconciliation.

## 21. Write-before-action and idempotency

Operations with meaningful side effects use the sequence:

```text
DURABLE INTENT
-> SIDE EFFECT
-> DURABLE RESULT
```

Every retryable external operation has a stable operation id. Recovery must determine whether an interrupted operation is known complete, known incomplete, or ambiguous before retrying it.

Ambiguous irreversible operations are never blindly repeated.

## 22. Crash recovery

### 22.1 App restart

The run, graph, workers, reviews, integration state, and pending actions are reconstructed from snapshot plus journal.

### 22.2 Chrome crash

All browser leases may disappear, but worker identity, conversation ids, worktrees, task state, review state, and verification records remain. Lost tabs do not mark workers failed.

### 22.3 App and Chrome crash together

Recovery combines durable orchestration state with command state, session state, Git/worktree reality, and browser state when Chrome returns.

### 22.4 Manager loss

Manager is replaceable. The kernel retains the authoritative graph and run state. A new Manager receives a bounded recovery brief and continues orchestration.

### 22.5 Prime loss

Prime loss does not destroy the run. When a decision requiring the user or Prime is necessary, the run may enter a paused-for-prime condition while already safe deterministic operations settle.

Recovery logic never invents product or architecture decisions.

## 23. Control Center

The main UI is run-centric rather than chat-centric.

Top-level information includes:

- overall progress;
- run health;
- active/sleeping/queued workers;
- reviewer utilization;
- agent tab usage versus budget;
- verification status;
- unresolved blockers;
- user decisions that actually require attention.

### 23.1 Task graph view

Users can inspect live DAG nodes and see status, dependencies, worker ownership, review rounds, files changed, and last activity.

### 23.2 Agent view

Agent state and browser tab state are displayed separately. `ACTIVE` with no open browser tab is a normal state.

### 23.3 Browser resource view

The UI distinguishes system-owned agent tabs from unmanaged user tabs and shows active leases, purpose, age, and budget usage.

### 23.4 Needs Your Attention

Only decisions that genuinely require user authority are promoted, such as requirement choices, destructive data changes, production deployment, or irreversible external operations. Routine retries, reviewer corrections, worker replacement, and ordinary scheduling remain automatic.

### 23.5 Intervention levels

- L0: kernel handles automatically;
- L1: Manager handles automatically;
- L2: Manager re-plans;
- L3: Prime judgment required;
- L4: explicit user approval required.

### 23.6 Pause and emergency stop

Pause stops new scheduling, allows safe current operations to settle, sleeps workers where possible, and releases disposable agent tabs.

Emergency stop cancels pending scheduling/commands where safe, prevents new writes, releases managed agent tabs, and records interrupted operations for recovery. It never closes unmanaged user tabs.

### 23.7 Inspect worker

Opening a worker conversation for inspection creates a temporary inspection lease. If the user chooses to keep that tab open, ownership changes to `manual_user_view`, after which automatic cleanup is disabled for that tab.

### 23.8 Evidence and decision views

The Control Center exposes real verification evidence and a Manager decision log so the system is inspectable rather than a black box.

## 24. Safety and authority boundaries

Agent System 3.0 may autonomously manage reversible project-local orchestration such as task creation, worker allocation, review routing, worktrees, local commits, tests, retries, and integration candidates.

Push, deploy, production data changes, destructive operations, and other user-owned irreversible boundaries are governed by explicit policy gates and may require user approval.

No component may silently broaden those permissions because a task is blocked.

## 25. Required invariants

Implementation tests must protect these invariants:

1. Worker identity never depends on an open tab.
2. Only proven system-owned tabs may be auto-closed.
3. Durable handoff is required before normal bootstrap/revival close.
4. Failed bootstrap cannot retry forever.
5. Browser-task tabs remain open only while explicitly leased.
6. Closing a tab does not terminate the worker.
7. Sleeping workers retain their conversation identity.
8. `MAX_AGENT_TABS` cannot be exceeded by normal orchestration.
9. A task cannot skip required state transitions.
10. A worker cannot approve its own task for integration.
11. Review approval does not substitute for integration verification.
12. Verification is valid only for the exact integrated revision it tested.
13. No acknowledged task disappears after restart.
14. No completed task is silently rerun after restart.
15. Lost ACKs do not create duplicate workers.
16. Losing Manager does not lose the run.
17. Ambiguous irreversible operations are not blindly retried.
18. Recovery does not make architectural decisions.
19. Unknown browser tabs are user-owned by default.
20. Every irreversible operation has durable intent before execution.

## 26. Testing strategy

Implementation should use test-driven development around state transitions and failure boundaries.

Required test families include:

- DAG readiness and dependency scheduling;
- parallel worker allocation and capacity limits;
- worker reuse versus new spawn;
- task contract scope-change handling;
- reviewer pool and specialist routing;
- bounded review rounds;
- worktree isolation and integration ordering;
- verification freshness invalidation;
- bootstrap, revival, and inspection tab lease behavior;
- `MAX_AGENT_TABS` under high concurrency;
- user-owned tab non-interference;
- bounded transient retries, including rate-limit acknowledgement handling;
- app restart after each critical durable transition;
- crash between durable intent and side effect;
- crash between side effect and durable result;
- command/ACK loss without duplicate worker creation;
- Manager replacement;
- Chrome tab loss while workers remain active;
- System Reviewer completion gates;
- pause, resume, and emergency stop.

Integration tests should exercise the app, extension, broker, and durable store together for the browser handoff and recovery paths that cannot be proven by isolated unit tests.

## 27. Migration strategy

Version 3 should be introduced incrementally on top of the existing broker rather than replacing all agent behavior at once.

The existing conversation identity, sleeping/wake semantics, durable command ACK handling, and durable file store remain foundations. New orchestration records and events should be versioned so existing v2 state can be loaded safely and upgraded without guessing missing V3 fields.

A V2 worker that lacks V3 task/review metadata must never be silently treated as V3-verified work. Migration should classify legacy state explicitly and require new V3 verification before it participates in a V3 completion gate.

## 28. Recommended implementation order

The implementation plan should preserve vertical slices and verification checkpoints. At a high level the dependency order is:

1. V3 state types and durable orchestration journal;
2. task DAG and deterministic state transitions;
3. Manager-facing orchestration commands;
4. worker allocation/reuse and task contracts;
5. Tab Lease Manager plus hard tab budget;
6. explicit completion packages and reviewer routing;
7. worktree/integration controller;
8. verification freshness and System Reviewer gate;
9. crash reconciliation and Manager replacement;
10. Control Center UI;
11. full end-to-end recovery and concurrency verification.

This order is directional only. The implementation plan must split each stage into test-first, reviewable increments against the actual repository structure.

## 29. Final design summary

Agent System 3.0 is a durable orchestration layer built around a Prime, one Manager, parallel workers, hybrid reviewers, isolated worktrees, a controlled integration pipeline, fresh verification evidence, ephemeral leased browser tabs, and deterministic crash recovery.

The design intentionally supports many durable agent identities without many browser tabs. Normal bootstrap and revival tabs are temporary resources that close after durable handoff. Workers continue through conversation/session identity and broker state, not because their ChatGPT page remains open.

The system is autonomous where actions are reversible and policy-controlled, but user-owned irreversible boundaries remain explicit. Completion is evidence-based, recovery is replay-and-reconcile rather than guesswork, and every important state transition is inspectable from the Control Center and durable event history.
