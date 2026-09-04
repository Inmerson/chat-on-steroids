# Control Center Canvas — Implementation Plan

Date: 2026-09-03
Branch: `feat/control-center-canvas`
Worktree: `.worktrees/chat-on-steroids-control-center-canvas`

## Task 1 — Lock the baseline

- Preserve the user's source V3 worktree untouched.
- Capture its current dirty WIP as the feature branch baseline.
- Reconcile the stale `agents` action-count test so the inherited V3 contract is green.
- Verify Agent System 3.0 focused tests before feature code.

## Task 2 — Define and test the read projector

Files:
- `src/shared/control-center.ts`
- `src/main/orchestration/control-center.ts`
- `test/control-center.test.ts`

RED first:
- idle projection;
- dependency + assignment + review edges;
- role aggregation for Manager/reviewer/worker;
- synthetic durable agent when broker row is absent;
- verification freshness/failure summary;
- safe worktree projection excludes `realPath`;
- conservative blockers/attention;
- browser budget reports unavailable telemetry rather than guessing.

Then implement the smallest pure projector and a loader over recovered orchestration/workflow/swarm state.

## Task 3 — Add the narrow IPC/preload read path

Files:
- `src/main/ipc.ts`
- `src/preload/index.ts`
- `src/main/index.ts` if orchestration store initialization is not already wired
- `test/ipc.test.ts`

RED first:
- `control-center:get` is registered and returns an idle serializable projection;
- preload exposes exactly `getControlCenter`;
- orchestration store is initialized before the renderer can invoke the endpoint.

Then wire the named read-only channel only. No generic method and no renderer-supplied path/input.

## Task 4 — Build and test the canvas renderer

Files:
- `src/renderer/control-center.ts`
- `src/renderer/index.html`
- `src/renderer/styles.css`
- `src/renderer/main.ts`
- `test/control-center-renderer.test.ts`
- `test/renderer-layout.test.ts`

RED first:
- deterministic dependency-depth layout;
- Control nav/panel structure;
- unique ids/no horizontal-scroll invariant;
- agent/task buttons and inspector anchors exist;
- stale refresh generation is rejected by the refresh controller/pure seam.

Then render:
- summary strip;
- agent lane + task graph + SVG relations;
- selected-node inspector;
- idle/degraded states;
- visibility-gated polling and swarm-triggered refresh.

## Task 5 — Focused integration review

Run:
- `npx vitest run test/control-center.test.ts test/control-center-renderer.test.ts test/ipc.test.ts test/renderer-layout.test.ts test/renderer-state.test.ts`
- `npm run typecheck`
- `git diff --check`

Review specifically for:
- native-path leakage;
- renderer authority expansion;
- stale async repaint;
- false browser-ownership inference;
- task/agent identity collisions;
- CSS overflow regression.

Fix findings with a regression before changing production code where applicable.

## Task 6 — Full verification and build

- `npm run verify`
- `npm run build`
- inspect final diff/status and commit only files owned by this feature.
- leave the user's original V3 worktree and main checkout untouched.
