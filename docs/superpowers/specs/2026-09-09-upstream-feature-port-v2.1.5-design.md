# Chat On Steroids 2.1.5 — Selective Upstream Feature Port Design

Date: 2026-09-09
Target release: 2.1.5
Fork baseline: `c8f609e` (`release: finalize 2.1.4 multi-device coordinator`)
Upstream source: `totec448-spec/chat-on-steroids` `origin/main`

## 1. Objective

Bring the useful capabilities currently present in upstream `origin/main` into the Inmerson 2.1.x fork as release 2.1.5 without replacing or weakening the fork-specific architecture introduced across 2.1.x.

This is a selective, subsystem-by-subsystem feature port. It is not a wholesale merge, rebase, reset, or replay of upstream history.

## 2. Why selective porting is required

At design time the histories are materially divergent: the merge-base comparison reports 356 fork-only commits and 101 upstream-only commits, with changes spanning hundreds of files. Upstream no longer contains several fork-owned subsystems, including persistent Core, Agent System 3.0 orchestration, Control Center, and the 2.1.4 multi-device stack. A direct merge could therefore delete or regress fork capabilities even if upstream tests pass.

The 2.1.5 integration must preserve fork behavior first, then adapt upstream features to those interfaces.

## 3. Protected 2.1.4 capabilities

The following are non-negotiable preservation boundaries:

- persistent Core Host and supervisor lifecycle;
- Agent System 3.0 DAG orchestration;
- Manager authority, plans, worker allocation, review, and verification flows;
- Control Center and its orchestration/browser telemetry surfaces;
- durable autonomous execution and execution control;
- Infinite Loop and scoped recovery semantics;
- managed Execution and Agent browser windows with exact conversation binding;
- worker sleep/finish boundaries and five-tab budget;
- authenticated terminal continuation;
- 2.1.4 multi-device coordinator/node architecture;
- durable device registry, pairing, resume credentials, presence, and revocation;
- explicit `device_id` remote routing for supported MCP tools;
- fork updater/release channel and 2.1.x version lineage;
- fork public-history privacy rules;
- current sandbox, capability, permission, and trust-boundary invariants.

If an upstream implementation conflicts with any protected boundary, the fork implementation wins. The useful upstream behavior must be re-derived manually or rejected.

## 4. Integration strategy

All work will occur on the isolated integration line `integrate/upstream-2.1.5` or a dedicated worktree based on the 2.1.4 baseline. Production ports follow TDD: a focused regression or capability test must fail against the fork baseline before the implementation is changed, then pass after the minimal adapted port.

Each subsystem is a separate reviewable slice and commit. No public push, tag, release, or installer publication is part of the implementation unless explicitly authorized later.

## 5. Subsystem A — Plugins platform

Port the upstream Plugins workspace while retaining fork Core ownership and MCP boundaries.

Scope:

- plugin catalog and metadata;
- plugin manager and lifecycle;
- plugin installer;
- plugin exposure into model-visible MCP surfaces;
- plugin refresh workflow;
- OAuth/service authorization support where upstream already provides it;
- custom MCP server configuration and MCPB import where supported upstream;
- upstream-supported integrations such as Blender, Memory, Playwright, Fetch, Unity, and hosted-service connectors;
- Plugins renderer workspace and icons;
- plugin-related preload/IPC contracts;
- third-party notices, plugin license inventory, and compliance documentation required by imported code/assets.

Constraints:

- plugins must not bypass existing Core capability checks;
- secrets remain stored through the fork secret-management boundary;
- plugin install/enable actions must be explicit user actions;
- remote/multi-device execution must not be implicitly granted to plugins;
- plugin tooling must coexist with existing Core, Desktop, session, and multi-device MCP surfaces.

## 6. Subsystem B — Browser and model discovery

Port upstream browser-selection and ChatGPT model-discovery improvements, adapting them to the fork managed-browser lifecycle.

Scope:

- Chrome, Edge, and Brave selection where supported upstream;
- browser preference storage and UI;
- browser startup/wake behavior;
- window placement/layout improvements;
- reduced unnecessary tab creation;
- model catalog and picker-state discovery from the live ChatGPT UI;
- multilingual/nested model/version menu handling;
- reasoning-option discovery;
- startup wake/recovery needed to inspect model state reliably.

Constraints:

- the fork five-tab budget remains authoritative;
- managed Agent/Execution window binding remains authoritative;
- upstream tab-revival code may not replace fork worker lifecycle semantics;
- browser identity, scoped recovery, and conversation ownership checks remain intact.

## 7. Subsystem C — Attachments and artifacts

Port upstream file/image input and artifact handling into the fork durable session model.

Scope:

- input attachments;
- input images;
- startup input handling;
- input history where useful;
- artifact target resolution;
- artifact fetch/download;
- MCP image attachment handling;
- transcript/file rendering required to expose completed artifacts safely.

Constraints:

- durable session/recorder ownership remains fork-native;
- file access must stay inside approved roots or explicitly authorized destinations;
- attachments must not broaden sandbox authority;
- remote-device paths must never be confused with local filesystem paths;
- artifact download must validate destination and overwrite semantics before mutation.

## 8. Subsystem D — UI and workspace modernization

Adapt upstream renderer improvements around, not instead of, the 2.1.4 workspace.

Scope:

- collapsible/resizable sidebar behavior;
- improved Markdown, table, link, file, and tool-result rendering;
- agent communication/panel improvements that do not replace Control Center;
- context meter and usage presentation where compatible;
- timeline scroll/focus behavior;
- folder-management discoverability after setup;
- bounded native tool activity disclosures;
- Plugins workspace integration;
- browser/model preference controls.

Preserve and integrate:

- Control Center;
- Fleet/Devices and pairing UI;
- Core Health presentation;
- coordinator status;
- orchestration canvas;
- existing 2.1.4 navigation destinations.

The resulting renderer is a composition of upstream usability improvements with fork control surfaces, not an upstream renderer replacement.

## 9. Subsystem E — Recovery and lifecycle hardening

Evaluate and selectively port current upstream lifecycle/recovery fixes that strengthen invariants without replacing fork orchestration.

Candidate behaviors include:

- continuation and handoff fixes;
- `destinationLost` propagation;
- Project conversation route handling;
- blocked-chat handling;
- silent/open-turn recovery;
- browser wake/replacement hardening;
- worker revival fixes compatible with fork worker authority;
- tunnel readiness/restart ownership fixes;
- input/artifact/continuation regression fixes;
- request/turn attribution corrections;
- helper-generation/desktop reply provenance where still missing.

Each candidate is classified as `ALREADY_PORTED`, `SAFE_MANUAL_PORT`, `TEST_ONLY_PORT`, `SUPERSEDED`, or `REJECT` before production edits.

## 10. Subsystem F — Current upstream hardening and platform fixes

Port small, high-value upstream improvements that remain missing after the larger subsystem work.

Examples to audit:

- multilingual access/rate-limit classification;
- RTL rendering for Arabic/Hebrew answers;
- standard Windows `uv` discovery;
- modern MCP JSON response handling;
- Windows swapped mouse-button handling;
- browser readiness/tunnel lifecycle fixes;
- platform-specific packaging and runtime hardening;
- deterministic tests that replace timing assumptions.

These are not automatically copied. Each is verified against current fork behavior first.

## 11. Versioning and release policy

The integration target is **2.1.5**.

Version files are not changed at the start of integration. The version bump occurs only after all selected subsystem ports have passed the final preservation and verification gates. Release notes and changelog will describe 2.1.5 as a selective upstream capability import layered on top of the 2.1.4 multi-device architecture.

No upstream version number supersedes the fork release line. Upstream release notes may be preserved for provenance but may not falsely claim fork artifacts were published or validated.

## 12. Testing strategy

Every production slice uses red-green verification. The expected test layers are:

- focused tests for the exact imported behavior;
- adjacent subsystem suites;
- protected fork contract suites;
- TypeScript typecheck;
- extension/renderer build where shipping UI changes are involved;
- full `npm run verify:ci` or the current equivalent comprehensive verification command;
- `npm run build`;
- `git diff --check`;
- privacy/public-history verification;
- package/release invariant tests;
- explicit structural preservation checks for Core, orchestration, Control Center, execution, worker lifecycle, updater, and multi-device files.

A green upstream-style test is not sufficient if a protected 2.1.x invariant disappears.

## 13. Feature-preservation gate

Before 2.1.5 can be considered complete, verify all of the following:

1. persistent Core Host/supervisor remains present and tested;
2. no `src/main/orchestration/**` subsystem is removed or replaced wholesale;
3. Control Center remains present and functional;
4. durable execution remains controllable through the fork Core/session surface;
5. Infinite Loop/scoped recovery remains intact;
6. five-tab and worker lifecycle behavior remains intact;
7. updater/release repository/channel remains the fork's;
8. version lineage remains 2.1.x and ends at 2.1.5;
9. multi-device registry/transport/protocol remain present and tested;
10. explicit `device_id` routing remains functional for supported tools;
11. permissions/sandbox authority is not broadened unintentionally;
12. no imported plugin or attachment path bypasses existing trust boundaries.

Failure of any item blocks the release regardless of aggregate test status.

## 14. Integration order

Recommended order:

1. establish an isolated 2.1.5 integration worktree and baseline verification;
2. Plugins platform and compliance files;
3. browser/model discovery;
4. attachments/artifacts;
5. UI/workspace modernization;
6. recovery/lifecycle hardening;
7. current upstream small fixes/platform hardening;
8. final upstream re-audit for commits added during implementation;
9. preservation gate and full verification;
10. bump version to 2.1.5, update changelog/release notes, build/package locally;
11. final exact-HEAD verification.

The ordering keeps major functional surfaces independently reviewable and postpones release/version mutations until behavior is stable.

## 15. Success criteria

2.1.5 is successful when:

- all selected upstream features are available through the fork's architecture;
- Plugins, modern model/browser discovery, attachments/artifacts, and renderer improvements are integrated;
- current upstream lifecycle/platform hardening has been explicitly audited and relevant fixes ported;
- no protected 2.1.4 capability is lost or weakened;
- multi-device coordinator/node and remote routing still pass their contracts;
- imported code complies with applicable third-party notice/license requirements;
- the full verification, build, privacy, and package-invariant gates pass on the exact final commit;
- the integration history remains reviewable as selective ports rather than a destructive wholesale merge.
