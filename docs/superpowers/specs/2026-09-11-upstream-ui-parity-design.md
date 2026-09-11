# Upstream UI Parity Design

## Goal

Restore the visual and navigational shell of the upstream Chat On Steroids 2.0.9 desktop app while preserving the current 2.2.0 runtime, security model, tools, Agent System 3.0, Control Center, Plugins, Fleet/Devices, Persistent Core, browser/model discovery, durable sessions, and recovery behavior.

The user-provided 2.0.9 screenshot and the upstream `v2.0.9` renderer are the visual reference. This is not a rollback to upstream runtime code.

## Non-negotiable constraints

- Keep `port/upstream-2.0.9` as the implementation branch and keep a single physical project checkout at `C:\Users\exprt\Project Inmersion\Inmersion MCP\Chat On Steroids`.
- Do not replace current 2.2.0 Core authority, browser bridge authority, session schema, permission model, tool surfaces, or release pipeline with upstream equivalents.
- Preserve every current renderer control that changes 2.2.0 behavior, even if it moves to a different visual container.
- Preserve existing stable element IDs wherever possible so renderer modules and tests keep one control authority.
- Do not reintroduce the upstream local Projects catalog/sidebar grouping. Current exact-chat workspace learning remains authoritative.
- Do not expose macOS/Linux Desktop automation; current platform policy remains Windows-only.
- No horizontal scrolling at the default application window size.
- Conversation/session actions remain exact-session scoped; no UI relocation may weaken conversation identity or stale-response fencing.

## Target shell

### Default Chat screen

The default window follows the upstream 2.0.9 posture:

- a left conversation sidebar with the Chat On Steroids brand, a `New chat` action, recorded conversation rows, and a bottom `Settings` entry;
- a slim top header over the main content, showing the selected chat title on the left and connection/theme controls on the right;
- the main content shows the current conversation/session view rather than an Overview dashboard;
- connection status remains visible without opening Settings;
- the sidebar remains collapsible and resizable, preserving the current keyboard shortcut and persisted width behavior.

The desktop app remains a local control/viewer surface rather than pretending to be a second ChatGPT web client. Existing timeline, handoff, input, Goal, worker, and session controls retain their semantics.

### Settings mode

Pressing `Settings` switches the left sidebar from the conversation list to the upstream-style settings navigation. A `Back to chat` affordance returns to the default Chat screen.

Settings navigation maps current 2.2.0 capabilities as follows:

- **Workspace**: permissions, approved roots, local status, Fleet/Devices summary, and current Home/Overview diagnostics.
- **Agents & automation**: Agent System 3.0 controls, Goal/automation settings, Control Center entry, worker limits, and orchestration-related controls.
- **Plugins**: current Plugins workspace unchanged in behavior.
- **Setup**: tunnel, extension, browser selection, pairing, secure-storage/API-key setup, and platform setup.
- **Activity**: current structured log/activity surface.
- **Usage**: only if the current branch already exposes an authoritative usage surface; no heuristic provider billing is introduced by this UI work.

Control Center remains a first-class 2.2.0 feature. It may be opened from Agents & automation and may use the whole main content region; it does not need a permanent top-level left-rail item in default Chat mode.

### Header

The header returns to the upstream visual hierarchy:

- selected conversation/title is the primary left label in Chat mode;
- Settings panels show `Chat On Steroids` plus a concise panel subtitle;
- theme, connection state, detail, and connect/disconnect remain at the right edge;
- current update/reminder notices stay below the header and above the scrolling main region.

## Information architecture mapping

The current 2.2.0 panels remain the implementation authority. This project changes navigation and presentation, not backend ownership.

| Current 2.2.0 surface | New location |
| --- | --- |
| `chat` | Default main screen |
| `home` | Settings → Workspace |
| `control` | Settings → Agents & automation → Control Center |
| `plugins` | Settings → Plugins |
| `setup` | Settings → Setup |
| `activity` | Settings → Activity |
| Fleet/Devices widgets | Settings → Workspace, with deep link/section as needed |
| Browser/model discovery | Existing chat/settings controls; no duplicate model authority |

No panel is deleted merely because it is no longer a permanent navigation item.

## Renderer ownership and state

The shell gets one explicit mode: `chat` or `settings`.

- Default startup mode is `chat` unless setup is incomplete and the current application already requires setup to be surfaced.
- Selecting a conversation never implicitly changes to Settings mode.
- Selecting a Settings destination never changes or deletes the selected conversation.
- Returning to Chat restores the previous selected session and its timeline view.
- Async panel loads keep their existing generation/identity fences.
- Sidebar collapse/resize state works in both modes; resizing never changes selected panel/session.

## Visual parity rules

The upstream screenshot and `v2.0.9` styles establish the intended density and hierarchy:

- dark theme uses the upstream near-black page/card palette and subtle separators;
- left sidebar is visually dominant navigation, not a dashboard rail;
- typography is compact, with small metadata and restrained icon sizing;
- cards and controls use low-radius, low-contrast treatment rather than large dashboard tiles;
- selected navigation uses understated fill/edge treatment;
- the main conversation surface gets the largest share of window area;
- responsive/collapsed sidebar behavior keeps primary actions reachable.

Exact pixel cloning is not required where current controls need more room, but the structural silhouette and hierarchy must match the upstream app.

## What is explicitly not being restored

- upstream local Projects catalog/grouping;
- upstream runtime/Core ownership;
- upstream release workflow;
- duplicate context/agent panes already superseded by current Agent System 3.0 / Control Center;
- heuristic billing presented as authoritative usage;
- macOS Desktop automation.

## Testing strategy

TDD applies to every behavioral/structural change.

Required regression coverage includes:

- default shell has brand, New chat, conversation list, Settings, and current selected chat region;
- settings navigation is hidden in Chat mode and replaces conversation navigation in Settings mode;
- every current 2.2.0 destination remains reachable;
- Control Center remains reachable without becoming the default screen;
- connection/theme controls remain visible in both modes;
- selected session survives Chat → Settings → Chat;
- sidebar resize/collapse controls remain present and no horizontal-scroll contract regresses;
- existing session header, timeline, settings, plugin, setup, Control Center, and state-management tests stay green.

## Completion criterion

The work is complete when the installed application visually follows the upstream 2.0.9 shell in normal Chat mode, every current 2.2.0 feature remains reachable and functional, focused renderer tests pass, `npm run typecheck` passes, `git diff --check` passes, and the full CI verification remains green before packaging.
