---
type: ai-session
memory_zone: session
source_type: distilled-session
confirmed_by: agent
project: Chat On Steroids
session_id: session
created: 2026-09-08T08:58:51+02:00
---

# Chat On Steroids — Session session

## Summary

Fixed normal-page scroll retention: Devices, Permissions, Health, Releases, Plugins, and Setup now reset to top on tab navigation; chat and activity keep their timeline position.

## Decisions

- None recorded.

## Reusable Learnings

- The renderer-state regression reproduces a panel reopening at scrollTop 640 and asserts it resets to zero.

## Next Actions

- Package/install only after confirmation because the shared worktree contains unrelated changes.

## Risks / Warnings

- Source tests and build are verified; the installed app has not been replaced.
