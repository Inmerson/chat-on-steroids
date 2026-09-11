---
type: ai-session
memory_zone: session
source_type: distilled-session
confirmed_by: agent
project: Chat On Steroids
session_id: session
created: 2026-09-07T20:27:36+02:00
---

# Chat On Steroids — Session session

## Summary

Unified device role setup was added to the main application config and Setup UI: coordinator, node, or independent with a private-network host and port. Core starts coordinator transport only for the coordinator role on next app launch.

## Decisions

- The same app installation is used on every computer; role is a mutable device setting rather than a hardware identity.

## Reusable Learnings

- None recorded.

## Next Actions

- Finish the packaged installer output check, then add authenticated resume/reconnect and per-device MCP endpoints.

## Risks / Warnings

- Changing a role requires app restart because the Core host opens network listeners only at startup.
