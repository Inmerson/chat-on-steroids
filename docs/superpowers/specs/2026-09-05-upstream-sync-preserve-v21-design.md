# Upstream Synchronization Without Regressing the 2.1 Line

Date: 2026-09-05

## 1. Purpose

The `Inmerson/chat-on-steroids` fork has intentionally diverged from `totec448-spec/chat-on-steroids` to add Agent System 3.0, Control Center, durable autonomous execution, Infinite Loop, managed browser execution, and related reliability work. Upstream has continued to move at the same time.

This synchronization must recover useful upstream fixes and historical release provenance **without replacing, flattening, or silently weakening the fork's 2.1.x architecture**.

The synchronization is therefore a selective port, not a branch merge.

## 2. Non-negotiable safety constraints

1. `origin/main` is the protected behavioral reference for the fork.
2. Do not merge `upstream/main` wholesale into `origin/main`.
3. Do not reset, rebase, force-push, checkout over, or clean shared work.
4. Do not replace fork implementations merely because an upstream patch touches the same file.
5. Every upstream candidate must be classified before any production edit as one of:
   - `ALREADY_PORTED` — the behavior is already present in the fork;
   - `SAFE_MANUAL_PORT` — the behavior is missing and can be adapted without removing fork behavior;
   - `TEST_ONLY_PORT` — no production behavior changes, but the test strengthens determinism;
   - `SUPERSEDED` — the fork has a newer or broader implementation, so the upstream patch must not be replayed;
   - `REJECT` — incompatible with the fork's architecture or would regress a fork invariant.
6. Production ports use TDD. The regression must fail against the fork baseline before the fix is applied and pass afterwards.
7. The final integration diff must contain only intentionally selected upstream behavior plus release-history documentation.
8. The final integration is not release-ready until focused tests, adjacent boundary tests, `npm run verify`, and `git diff --check` pass on an isolated worktree.

## 3. Protected 2.1.x capabilities

The following fork capabilities are explicitly protected and must survive synchronization unchanged unless a later user-approved design changes them:

- Agent System 3.0 task DAG and durable orchestration journal;
- Manager authority, Manager plans, worker allocation and worktree provisioning;
- completion review / verification workflow;
- Control Center graph, inspector, filters, search, blockers and browser lease telemetry;
- durable autonomous desktop execution and execution control through the existing Core/session surface;
- managed Execution and Agent browser windows and exact conversation binding;
- Infinite Loop / scoped recovery / decision delegation behavior;
- worker tab lifecycle, durable sleep/finish boundaries and five-tab budget;
- authenticated Core terminal continuation;
- fork-specific updater/release channel, 2.1.x versioning and release pipeline;
- fork-specific public-history privacy behavior;
- current permission, sandbox, recovery and browser identity invariants.

If an upstream patch conflicts with any item above, the fork behavior wins and the useful part of the upstream change must be re-derived manually or rejected.

## 4. Current repository topology

At audit time:

- upstream repository: `totec448-spec/chat-on-steroids`;
- fork repository: `Inmerson/chat-on-steroids`;
- upstream `main`: `dbff15b7296358102ee3e141f183e89a4a8d1e0e`;
- fork `origin/main`: `f2b6b342c3940ca8ca90f6db53c61991f74078c2` (`v2.1.1`);
- upstream package version: `2.0.5`;
- fork package version: `2.1.1`.

The raw merge-base comparison reports many commits on both sides because both histories contain independent merges and rewrites. Patch-equivalence is the useful measure for synchronization. `git cherry origin/main upstream/main` reduces the currently meaningful upstream-only patch set to seven commits.

## 5. Release-history repair

The fork's public release-note directory currently jumps from `v2.0.2.md` to `v2.1.0.md`, while upstream contains historical `v2.0.3.md`, `v2.0.4.md`, and `v2.0.5.md` notes.

The missing historical notes must be restored **as provenance**, not as a claim that the fork published those exact upstream artifacts.

Required documentation behavior:

1. Add upstream historical note files for 2.0.3, 2.0.4 and 2.0.5 under a clearly historical/upstream framing, preserving their factual upstream release record.
2. Update `CHANGELOG.md` so the fork does not visually imply a direct `2.0.2 -> 2.1.0` lineage with no upstream development in between.
3. Keep the fork's actual release sequence and tags unchanged. Do not create fake `v2.0.3`, `v2.0.4` or `v2.0.5` fork tags.
4. Add an explicit lineage note for the 2.1.x line: it derives from upstream 2.0.x work plus selected later upstream fixes, then adds the fork's Agent System 3.0 / Control Center / autonomous-execution architecture.
5. Do not copy an upstream release note verbatim into a fork release note if it would falsely state that a fork artifact was published or validated in a way the fork did not perform.

## 6. Seven-patch audit

### 6.1 `13f9402` — Require macOS 13 Ventura

**Classification: `ALREADY_PORTED` / `SUPERSEDED`.**

Upstream changed the macOS package floor from 12.x to Ventura 13 because of the pinned tunnel client. Fork 2.1.1 already contains the same required result:

- `electron-builder.yml` declares `minimumSystemVersion: "13.0"`;
- `scripts/packaging-versions.mjs` pins tunnel-client `v0.0.14`;
- packaging tests assert Ventura 13;
- `CHANGELOG.md` and `docs/release-notes/v2.1.1.md` document Ventura 13 and tunnel-client 0.0.14.

Do not replay this commit. Restore only the missing historical upstream 2.0.3 release-note provenance.

### 6.2 `a797054` — Test POSIX sandbox paths as native

**Classification: `ALREADY_PORTED` with a small assertion delta to review.**

The fork already has a dedicated `describe.runIf(!IS_WINDOWS)('a native POSIX path', ...)` block covering:

- absolute native paths inside approved roots;
- approved-root identity;
- native traversal refusal;
- outside-root refusal;
- POSIX filename semantics;
- backslash as a filename character;
- virtual/native ambiguity.

The upstream patch mainly adjusted expected wording for a nested outside-root path. This must not be cherry-picked blindly. If the fork's current refusal wording is intentionally different because of its newer sandbox/path guidance, retain the fork behavior. Add only a missing deterministic assertion if current behavior matches the upstream invariant.

### 6.3 `376efd5` — Release 2.0.5 updater behavior

**Classification: `SUPERSEDED` / `ALREADY_PORTED`.**

The fork's 2.1.1 updater already implements the material 2.0.5 behavior and extends it:

- digest-verified staging;
- versioned staging directories;
- persisted staged artifact reuse across restarts;
- explicit Install action;
- Windows installer handoff;
- AppImage replacement/relaunch behavior;
- renderer state and Install UI;
- fork-specific GitHub release channel and extension recovery.

Do not replay upstream production code or version files. Add upstream 2.0.5 release history only as provenance.

### 6.4 `07d4196` — Preserve Desktop reply provenance across helper replacement

**Classification: `SAFE_MANUAL_PORT` — high priority reliability fix.**

The fork already stamps UI refs with `helperGeneration` and rejects obviously stale refs, but replies themselves are not transport-owned. A helper can answer, asynchronous image/materialization work can yield, a replacement helper can start, and the old reply can then be associated with the newer global generation.

The upstream fix closes that identity gap by tying each successful reply to the helper generation that produced it and by requiring frames, refs, crop operations and dispatch to remain on that exact active generation.

The fork's Desktop implementation is not structurally identical to upstream's current cross-platform implementation, so the upstream commit must **not** be cherry-picked. Port only the Windows/helper-generation invariant into the fork's existing `src/main/computer/index.ts`.

Required fork behavior after the manual port:

- each live helper runtime has its own immutable generation;
- each successful helper reply carries transport-owned generation metadata outside the native JSON protocol;
- a frame remembers the generation that produced it;
- a UI ref is minted from the reply generation, not from whatever global generation exists later;
- a frame/ref becomes stale immediately when its generating helper exits or is replaced;
- crop and coordinate operations re-check the source generation at dispatch;
- local waits/clipboard steps cannot bridge a stale frame/ref into a replacement helper;
- no upstream macOS-specific implementation is introduced merely to port this invariant.

Regression tests must specifically cover replacement during asynchronous materialization and replacement during a local wait before native dispatch.

### 6.5 `ccb3e18` — Native disclosures for activity tool rows

**Classification: `SAFE_MANUAL_PORT` — medium priority UI feature.**

The fork does not currently contain upstream's `streamToolDetails` / native `<details>` disclosure behavior. The feature is useful because it exposes bounded, app-owned metadata such as tool name, outcome, duration and changed-file counts while deliberately excluding raw arguments/results.

However, the fork's `extension/content.js` has diverged substantially due to scoped recovery, autonomous execution and other 2.1 work. The patch does not apply cleanly and must not replace the fork renderer.

Manual-port requirements:

- preserve all current stream identity, scoped recovery and repaint rules;
- disclosure state is scoped to the exact rendered conversation/turn;
- only bounded activity metadata is shown;
- raw tool arguments/results, credentials and private payloads remain absent;
- DOM content is created with text nodes / `textContent`, never untrusted HTML;
- expansion and keyboard focus survive a repaint for the same call only;
- reused call ids in another conversation do not inherit expansion state.

### 6.6 `4b482ec` — Keep folder access editable after setup

**Classification: `SAFE_MANUAL_PORT` — low-risk usability fix.**

The fork currently lacks `wizManageFolders` and the tidy-wizard exception that keeps folder controls visible after onboarding. This is a navigation/usability change and does not grant access by itself.

Manual-port requirements:

- retain the existing fork Home / Setup layout and Control Center additions;
- expose a Manage folders path after setup is tidy;
- navigating to folder management must not add a root, change permissions, or reconnect anything;
- keyboard focus should land on the existing Add folder action;
- existing shared-root summary remains visible.

### 6.7 `2a8a8e3` — Synchronize bridge drain test on request acceptance

**Classification: `TEST_ONLY_PORT`.**

This changes no production behavior. It replaces a timer-subtraction assumption with an explicit HTTP `100 Continue` acceptance barrier before asserting that bridge shutdown waits for the accepted request to finish.

The fork retains the same shutdown-drain regression but still uses timing as the synchronization mechanism. Port the deterministic test structure manually into the fork's current `test/bridge.test.ts` without changing production code.

## 7. Recommended integration order

Apply the selected work as independent, reviewable slices:

1. **Release-history provenance only** — restore historical 2.0.3/2.0.4/2.0.5 documentation and lineage wording. No production code.
2. **Bridge drain deterministic test** (`2a8a8e3`) — test-only hardening.
3. **Desktop reply-generation provenance** (`07d4196`) — highest-priority production reliability port, TDD and focused Desktop tests.
4. **Folder management discoverability** (`4b482ec`) — narrow renderer change with state/permission negative assertions.
5. **Activity tool disclosures** (`ccb3e18`) — separate extension UI feature after the reliability ports are stable.
6. Re-run the seven-patch audit against the latest upstream `main` immediately before final integration, because upstream may move again during this work.

This order deliberately keeps documentation and deterministic tests separate from behavior changes and keeps the highest-risk extension UI port last.

## 8. Validation strategy

Each production slice follows red-green verification against the fork baseline.

### Documentation slice

- `git diff --check`
- release-note/link/path checks already present in packaging/release tests where applicable
- verify no version/tag files changed unless explicitly required

### Bridge test slice

- focused bridge shutdown test
- full `test/bridge.test.ts`

### Desktop provenance slice

- new focused generation-provenance regression suite
- existing `test/computer*.test.ts` suites relevant to frame/ref identity
- MCP Desktop boundary tests if model-visible behavior changes

### Folder-management slice

- focused `test/renderer-state.test.ts`
- renderer layout/state adjacent tests

### Activity-disclosure slice

- focused new disclosure tests
- full `test/content-script.test.ts`
- extension tests if activity payload handling crosses the background/content boundary

### Final gate

- `npm run verify:privacy`
- `npm run verify`
- `npm run build` if any shipping extension, renderer bundle or package-sensitive code changes
- `git diff --check`
- compare protected 2.1.x smoke/contract tests before and after the sync branch

## 9. Feature-preservation gate

Before the synchronization branch may be proposed for `origin/main`, compare the branch against the protected 2.1.x reference and explicitly confirm:

1. No `src/main/orchestration/**` file was removed or replaced by upstream history.
2. No Control Center source or test was removed.
3. No autonomous-execution control surface or managed-browser binding was removed.
4. No Infinite Loop / scoped recovery behavior was replaced by an older upstream implementation.
5. No worker lifecycle or five-tab budget regression was introduced.
6. No updater repository/channel was changed back to the upstream repository.
7. No fork version was downgraded from the 2.1.x line.
8. No permissions or sandbox authority was broadened as a side effect of synchronization.

The synchronization is rejected if any protected capability disappears even when the upstream test suite is green.

## 10. Branch and integration policy

All work occurs on the isolated `integrate/upstream-2.0.5` worktree or a successor isolated synchronization branch based on the current `origin/main`.

Commits remain narrow and ordered by the slices above. The branch is never force-pushed over `origin/main`. Final integration into the fork occurs only after the entire preservation gate and validation gate pass.

Upstream contribution PRs remain separate from fork synchronization commits. A fix intended for upstream should be based on upstream `main`; a fork synchronization port should be based on fork `origin/main`. Mixing the two histories would make both review and provenance harder.

## 11. Success criteria

The synchronization is successful when:

- missing upstream release history is represented accurately;
- all seven current upstream-only patches have an explicit classification;
- useful missing behavior is manually ported without replacing 2.1.x architecture;
- superseded upstream changes are documented rather than replayed;
- protected fork capabilities remain present and tested;
- the final isolated branch passes the full verification gates;
- the final diff is reviewable as selected ports, not a wholesale upstream merge.
