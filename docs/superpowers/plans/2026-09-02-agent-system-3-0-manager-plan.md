# Agent System 3.0 — Manager Plan Acceptance Slice

Date: 2026-09-02
Status: Implementation plan
Spec: `docs/superpowers/specs/2026-09-02-agent-system-3-0-design.md`

## Goal

Add the first Manager-facing orchestration command without creating a second agent broker. A proven Manager conversation will eventually call this kernel API after the existing broker has created/bound that Manager worker. This slice only accepts and durably materializes the Manager's initial task graph.

## Invariants

1. The existing multi-agent broker remains the source of conversation identity, spawn/wake semantics, and worker durability.
2. Manager supplies judgment-heavy task decomposition; kernel supplies deterministic task defaults, transition rules, DAG validation, retry budgets, and durable event ordering.
3. The complete graph is validated before the first journal mutation. Missing dependencies, duplicate ids, self-dependencies, and cycles write nothing.
4. `planId` is the stable idempotency key. An exact retry of the already accepted initial plan returns the existing state without duplicating events.
5. A different initial `planId` cannot replace an accepted plan. Graph growth/replanning will use separate bounded commands in later slices.
6. Task contracts include allowed scope, acceptance criteria, expected verification, forbidden/user-owned actions, dependencies, and risk class.
7. Manager cannot choose or reset deterministic retry counters. The kernel owns their initial value.
8. Root tasks become `READY`; dependency-bearing tasks remain `PLANNED` until their dependencies are verified.
9. A batch of initial-plan events receives one contiguous sequence range and is appended through one store queue operation.

## TDD sequence

### RED

Add `test/orchestration-manager-plan.test.ts` covering:

- valid two-node graph -> run/manager/task events + root READY;
- invalid cyclic graph -> no journal writes;
- exact `planId` retry -> no duplicate events;
- different second `planId` -> refusal with no extra events.

### GREEN

Implement only what the tests require:

- extend `TaskRecord` with the missing Task Contract fields;
- extend orchestration state with `managerAgentId` and `managerPlanId`;
- add `MANAGER_ASSIGNED` reducer/event support;
- add serialized batch append to the orchestration store;
- add `manager-plan.ts` validation/materialization API.

### Verification

Run the repository's full `verify:ci` matrix. Existing v2 broker, extension, bridge, and content-script suites must remain green. No MCP schema is changed in this slice.

## Not in this slice

- spawning the Manager;
- exposing Manager commands through `agents`;
- worker allocation/reuse;
- review routing;
- worktree creation;
- full Tab Lease budget;
- integration or verification gates.
