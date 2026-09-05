---
type: ai-handoff
memory_zone: session
source_type: distilled-session
status: active
updated: 2026-09-05T15:02:07+02:00
---

# Current Handoff

## Project

**Chat On Steroids**

## Last Session Summary

Core Plan 3 is functionally complete on the Inmerson 2.1 line and its final worker-lifecycle regression is merged on `origin/main`.

The final defect was not an unproven lifecycle theory: the installed Chrome companion had a stale `extension/background.js` that still called `chrome.tabs.remove(source.tab)` immediately after a worker bootstrap `sent` acknowledgement. The other lifecycle files already matched the hotfix worktree. The stale file was replaced with the verified hotfix copy, the extension was reloaded, a fresh authenticated worker smoke passed, and the production fix was merged through PR #5 as `dfd6114 fix(agents): keep worker tab until safe lifecycle release (#5)`.

The current fork `origin/main` therefore contains the Plan 3 worker-tab fix. The already-published 2.1.1 artifacts predate `dfd6114`; do not claim that the published 2.1.1 companion extension contains this fix.

## Verified Evidence

### Local final verification

- Focused worker-tab regression: `npx vitest run test/extension.test.ts` -> **94/94 passed**.
- Full `npm run verify:ci` on the rebased hotfix branch -> **91/91 main test files**, **2,039 passed**, **18 skipped**, **0 failed**; dedicated shutdown suite -> **2/2 passed**.
- Typecheck, public-history privacy verification, and `git diff --check` passed in the same final verification flow.
- The 18 suite skips are recorded as test-run skips; they are not reclassified here as environment-only skips without per-test evidence.

### Cross-platform CI and merge

- PR #5: `https://github.com/Inmerson/chat-on-steroids/pull/5`.
- PR CI run `33966925423` passed on **Linux x64**, **macOS arm64**, and **Windows x64**.
- PR #5 merged at `2026-09-05T12:49:04Z` as `dfd6114d5c9613dbf87cf6769804242f2687cbc2`.
- Post-merge `main` CI run `33967116353` also passed on **Linux x64**, **macOS arm64**, and **Windows x64**.

### Live authenticated remote-execution lifecycle smoke

Recorded session `2026-09-05-4d70e3cb` contains the successful harmless lifecycle smoke.

- Execution: `9f789734-3fc5-41ff-a8f4-edb32c65641c` (`Plan3 harmless live smoke`).
- The plan explicitly prohibited file, repository, settings, account, network-resource, external-data, and command mutations.
- `execution_start` returned a durable execution id and starting state.
- `execution_pause` moved the run to **paused** and bound it to exact conversation `6a9be450-01a4-83eb-92bd-3e933cf0f5a8`.
- `execution_status` confirmed **paused** on that same conversation.
- `execution_resume` was accepted for browser publication and retained the same exact conversation id.
- `execution_stop` moved the run to **stopped**.
- Final `execution_status` confirmed **stopped** with the same conversation id.
- A later status read from another recorded session still returned that same durable stopped execution and conversation binding, proving cross-chat durable control/status.

### Exact-URL recovery controlled seam

Plan 3 explicitly permits a controlled seam instead of waiting for a random production stall. The current `origin/main` recovery contract was re-run after the worker hotfix:

- `npx vitest run test/extension.test.ts -t "reopens the exact Chrome-owned conversation URL|offers recovery only to the exact target and closes the source only after that target is ready|resets the consecutive counter on genuine target progress"` -> **3 passed**, 91 unrelated tests skipped by the filter.
- The three focused assertions prove: the replacement receives the exact Chrome-owned source URL without Chat On Steroids recovery parameters; unrelated/wrong targets cannot claim the transfer and the source remains open until exact-target `recovery_ready`; genuine target progress resets the consecutive recovery counter.
- `npx vitest run test/content-script.test.ts -t "Loop recovery transfer startup|recovery progress"` -> **9 passed**, 287 unrelated tests skipped by the filter. This verifies semantic Loop-state restoration in the replacement document and recovery-progress publication.

No random production stall was induced for this gate; the controlled-seam path is the intentionally safer verification mode allowed by the approved plan.

### Live managed-worker smoke after the final hotfix

- Fresh worker: `worker-58`.
- Exact worker conversation: `6a9c0c06-a494-83eb-b3dd-4c350f31981b`.
- The app recorded the worker as active, then recorded its bootstrap as `committed`.
- After that committed ACK, the worker remained alive and made two real `agents` MCP calls attributed as `[worker-58]`; there was no immediate detach.
- Only after the worker became durably **sleeping** did its exact Chrome tab disappear.
- Unrelated ChatGPT/worker/execution tabs remained present, so cleanup was scoped to the test worker.

This is the decisive regression proof for the fix: bootstrap acknowledgement alone no longer authorizes destructive tab closure.

### Runtime / bridge identity observed during final verification

- Bridge protocol generation is **10** in both `extension/background.js` and `src/main/version.ts` on `origin/main`.
- The currently running app processes were observed from the isolated `upstream-sync-20260905` unpacked runtime, not the Programs install path:
  `C:\Users\exprt\Project Inmersion\Tools\chat-on-steroids-sync\.worktrees\upstream-sync-20260905\release\win-unpacked\Chat On Steroids.exe`.
- That executable reports product version **2.1.1.0**.
- The live companion extension was manually synchronized to the verified worker-tab hotfix `background.js` and reloaded before the successful worker-58 smoke.

## Decisions

- Worker-tab destructive close authority belongs to the dedicated agent-tab lifecycle. A durable bootstrap `sent` ACK is transport evidence only; it is not close eligibility.
- Exact-URL recovery remains service-worker/document scoped. Source-tab retirement occurs only after exact-target readiness; genuine recovered progress resets the bounded consecutive recovery counter.
- The successful remote execution lifecycle smoke in `2026-09-05-4d70e3cb` is the authoritative Plan 3 execution evidence. The older `worker-49` attempt was a separate misattributed/limited-tool-context attempt and is not the successful lifecycle smoke.
- Do not represent 2.1.1 as containing `dfd6114`. The currently running machine is safe only because the companion extension was hot-synchronized and reloaded.
- Do not force the Plan 3 autonomous/recovery stack directly onto `totec448-spec/chat-on-steroids` 2.0.5. That upstream line lacks the fork's v2.1 Agent System/autonomous-execution prerequisites, so a direct port would sweep broad prerequisite architecture outside this plan.

## Release / Contribution State

- `origin/main`: `dfd6114d5c9613dbf87cf6769804242f2687cbc2` at the Plan 3 worker-tab fix boundary.
- Published 2.1.1 tag predates `dfd6114`, so reinstalling the existing 2.1.1 companion artifact may restore the stale immediate-ACK-close behavior.
- A separate clean worktree/branch already exists at `release/2.1.2`, commit `f2d371a584ce912eff09dbb4a597723ff8391628` (`release: prepare 2.1.2`), based on `dfd6114`.
- That branch bumps app/extension version to 2.1.2 and includes `CHANGELOG.md` plus `docs/release-notes/v2.1.2.md`, including the worker lifecycle fix and bridge protocol generation 10.
- At the time of this handoff update, `release/2.1.2` had **no PR and no branch CI run**. Treat it as prepared but not yet independently verified/published by this Plan 3 closeout.

## Next Actions

1. Review the existing `release/2.1.2` commit/range against `origin/main`; do not recreate or overwrite that concurrent worktree.
2. Run fresh release-branch verification, including `npm run verify:ci`, `git diff --check`, version/tag/release-note consistency, and the repository's release preflight/package gates appropriate before publication.
3. If green, open the verified 2.1.2 PR against `Inmerson/chat-on-steroids`, wait for all required CI jobs, merge, then publish/tag only through the established release workflow.
4. After publication, verify the published Windows x64 installer and `Chat-On-Steroids-Extension.zip` checksums/artifact identity, update the local app/extension from that published pair, and rerun a minimal worker safe-close smoke so the live machine no longer depends on the manual extension hot-sync.
5. Keep any future original-upstream contribution as a separate prerequisite-aware port; do not widen this Plan 3 closeout into an upstream 2.0.5 architecture migration.

## Risks / Warnings

- **Release consistency:** published 2.1.1 does not contain the final worker-tab fix even though current `main` does. A normal reinstall/update to the old artifact can regress the live companion unless 2.1.2 (or a later verified release) is published and installed.
- **Concurrent work:** `release/2.1.2` already exists and is pushed. Preserve it and review it rather than creating a competing release branch.
- **Runtime provenance:** the active desktop runtime observed during final verification is an unpacked 2.1.1 build from the `upstream-sync-20260905` worktree, while the companion extension was manually hot-synchronized. Do not use that hybrid runtime as final packaged-release evidence.
- **Shared checkout:** the original repository checkout contains unrelated user WIP and remains out of bounds for Plan 3 mutations.

Source: Core Plan 3 final verification and live-smoke evidence, 2026-09-05.
