# Chat On Steroids 2.2.0 — Selective Upstream Feature Port Design

**Date:** 2026-09-10
**Target release:** 2.2.0
**Baseline entering retarget:** `889b69d8206ad8c10e68d264ee3a5d6c3d8d03ba`

## Decision

The work originally scoped as 2.1.5 is retargeted to **2.2.0** because it is a substantial backwards-compatible feature expansion rather than a patch-sized maintenance release. The completed Plugins platform remains part of this release and its historical 2.1.5 design/implementation documents remain as audit evidence.

## Architecture and protected boundaries

Upstream remains a source of individual capabilities, not an integration authority. Do not merge/rebase/reset onto `origin/main`. Every remaining feature is classified and selectively adapted to the fork. On conflicts, the fork wins for persistent Core Host/supervisor, Agent System 3.0 DAG, Manager authority, Control Center, durable execution, Infinite Loop/scoped recovery, managed browser/five-tab lifecycle, terminal continuation, multi-device coordinator/node/device registry, `device_id` routing, updater lineage, privacy, sandbox, capabilities and permissions.

Renderer code gains no direct filesystem/network/process authority. Browser/model/input/artifact features must route through the existing Core/main/preload boundaries. Remote-device authority must never be implied by a local feature.

## Execution model

The 34 not-yet-executed tasks from the seven detailed 2.1.5 plans are collapsed into four reviewable tranches:

1. **Workspace & Input** — browser/model discovery + attachments/artifacts + workspace UI refinements.
2. **Runtime Resilience** — recovery/lifecycle + platform hardening.
3. **Upstream Delta Closure** — re-audit latest upstream and close only remaining `NEEDS_PORT`; mark `ALREADY_PORTED`, `SUPERSEDED`, `REJECT` explicitly.
4. **2.2.0 Finalization** — preservation gate, version bump, changelog/release notes, exact-HEAD verification and local Windows x64 packaging.

Each tranche uses TDD for production behavior changes, focused tests during development, one tranche-level review rather than one review per historical task, then the release-wide full verification gate. Version stays 2.1.4 until finalization.

## Success criteria

2.2.0 is complete only when the selected upstream browser/model/input/artifact/UI/recovery/platform capabilities are present or explicitly classified as already better/superseded/rejected, protected fork capabilities remain intact, all focused and full verification gates pass, version metadata is 2.2.0, release notes/changelog are present, and a local Windows x64 package is built and inspected. No public push, tag or GitHub release is authorized by this design.
