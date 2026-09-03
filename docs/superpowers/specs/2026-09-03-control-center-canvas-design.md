# Control Center Canvas — Design

Date: 2026-09-03
Status: Approved by user; implementation authorized without further confirmation

## Goal

Add a first-class **Control Center** surface to the Chat On Steroids desktop app where a user can understand an Agent System 3.0 run at a glance: which agents exist, which tasks they own or review, which tasks depend on which other tasks, what is blocked, and what has been verified.

The surface is deliberately **read-only in its first release**. Existing MCP, orchestration, broker, worktree, review, and verification state remain authoritative. The renderer only projects that state.

## Product shape

The app gains a fifth bottom-navigation destination, **Control**. Its main body is a canvas-like graph plus a bounded inspector.

The graph contains two node classes:

- **Agent nodes** — Prime, Manager, workers, task reviewers, and System Reviewer role badges can coexist on one agent.
- **Task nodes** — title, machine state, risk, assigned worker/reviewer, review round, worktree branch, and verification summary.

Edges show:

- task dependency → dependent task;
- assigned worker → task;
- reviewer → task.

Selecting any node opens its full read-only detail in the right inspector. The summary strip shows run health, verified task progress, active agent count, blockers, genuine user-attention items, and browser-agent tab budget telemetry.

## Authoritative data

The renderer must not reconstruct orchestration truth from chat text or Activity prose. A new main-process read projector combines:

1. `recoverOrchestrationState()` — run, Manager, tasks, assignments, worktrees;
2. `workflowStateForRun()` — completion packages, reviews, integration, verification, System Review;
3. `swarmState()` — current broker-visible agents and liveness;
4. no browser guesses.

No native filesystem path is sent to the renderer. Worktree data is reduced to id, branch, and virtual path.

## Renderer wire contract

Create a shared serializable `ControlCenterStatus` contract with:

- `version`, `observedAt`;
- `run` — id, plan id, Manager, orchestration/workflow status, health and verified/total progress;
- `tasks` — task identity, state, risk, dependencies, ownership/review, safe worktree identity, changed files, verification summary, blocker summary and last activity;
- `agents` — id, label, liveness state, role tags, bound/reviewed task ids, chat-bound flag and broker counters;
- `edges` — dependency, assignment and review relations;
- `blockers`;
- `needsAttention`;
- `browser` — hard budget plus nullable measured usage/queue and telemetry status.

`needsAttention` must be conservative. A generic blocked task is not automatically a user decision. Until a durable user-authority reason exists, it remains a blocker only.

## Browser telemetry honesty

Agent-tab lease usage currently lives inside the extension and is not exported as authoritative Core state. The first Control Center release therefore reports:

- hard budget: `5`;
- used: `null`;
- queued: `null`;
- status: `unavailable`;
- an explicit note that user ChatGPT tabs are never inferred as agent usage.

This avoids conflating all ChatGPT tabs, bridge command queues, or stale browser observations with lease ownership.

## Layout

The graph is deterministic and responsive:

- agents occupy a left lane;
- tasks are grouped into dependency-depth bands to the right;
- vertical placement expands the canvas height instead of introducing horizontal scrolling;
- SVG edges sit behind DOM nodes;
- the inspector sits at the right at normal widths and moves below the canvas on narrow windows.

The existing application rule remains: **no horizontal scrollbars**.

The visual language follows the current monochrome system. Green is reserved for verified/successful state, red for blocked/failed state, and neutral ink/washes distinguish active/review/planned states.

## Refresh and stale-result safety

The Control Center is intentionally cheap while hidden. When visible it polls the single read-only IPC endpoint at a modest interval and refreshes immediately on broker/swarm pushes.

Every async load carries a monotonically increasing generation. A response from an older generation is discarded, preserving the repository-wide async-selection invariant.

## IPC/security boundary

The renderer receives exactly one new named method:

`getControlCenter() -> control-center:get`

There is no generic IPC method, path input, command input, or mutation. Main process owns all reads and projection. The renderer remains sandboxed and networkless.

## Empty and degraded states

- No orchestration run: show an idle canvas rather than an error.
- Orchestration run without live broker agents: synthesize presentation-only agent nodes for durable Manager/worker/reviewer ids so ownership remains visible; mark their liveness `unknown` rather than guessing.
- Missing workflow evidence: show `none`/`pending`, never manufacture success.
- Browser telemetry unavailable: show `— / 5`, never infer usage.

## Accessibility and interaction

- Graph nodes are real buttons, keyboard-focusable and screen-reader labelled.
- Selection is not conveyed by color alone.
- The inspector repeats machine state and role text.
- Refresh is explicit as well as automatic.

## Non-goals for this change

- drag-to-rewire dependencies;
- editing plans/tasks from the canvas;
- killing or pausing agents from graph nodes;
- exporting extension tab lease telemetry;
- resolving existing tab-lifecycle races;
- replacing the existing Chat/Swarm settings view.

Those can build on the read-only projector once its truth model is stable.

## Acceptance criteria

1. Control appears as a normal app panel without changing the current Home/Setup/Chat/Activity behavior.
2. A V3 run renders task dependency, assignment, and review edges from durable state.
3. Clicking an agent/task node shows its details.
4. Verification, blockers, worktree branch/virtual path, review rounds and run progress are visible.
5. Missing live agents and missing browser telemetry degrade honestly.
6. The renderer gets no native worktree paths and no new mutation authority.
7. Stale async replies cannot repaint a newer refresh.
8. Existing no-horizontal-scroll and unique-id layout contracts continue to pass.
9. Targeted projector/IPC/renderer tests, full `npm run verify`, and `npm run build` pass before completion is claimed.
