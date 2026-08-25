# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`,
`src/main/mcp/tools-desktop.ts` and `test/mcp.test.ts` should agree with this file.

## Connectors

Chat On Steroids publishes two independent MCP connectors. They are separate discovery and
permission boundaries and use separate secret tokenized local paths.

| Connector | Purpose | Possible tools |
| --- | --- | --- |
| **Chat On Steroids Core** | Approved files, patches, terminal, recorded-session lookup, workers | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents` |
| **Chat On Steroids Desktop** | Screen, windows, mouse/keyboard and clipboard | `observe`, `computer` |

The Desktop connector is optional. Core is the main connector.

On a fresh 1.9.4 config, all tool permissions, session recording and multi-agent mode are
enabled, while read-only mode is off. Existing configs keep explicit choices during upgrades;
missing legacy permissions are not silently widened.

With the fresh all-on capability snapshot, Core advertises seven schemas:
`read`, `view_image`, `apply_patch`, `exec_command`, `write_stdin`, `session`, and `agents`.
`find` is the search fallback for a snapshot where search is enabled and command execution is
unavailable. Tool exposure is monotonic within a running connector instance, so a permission
changed mid-conversation can leave a previously exposed name listed; its handler still enforces
the current permission.

## Core tools

### `read`

Reads approved paths. It accepts one or more paths, lists a directory one level deep, expands
bounded globs, supports line ranges for one text file, and can return supported image content.
Path resolution and result-size limits are enforced by the app.

### `view_image`

The dedicated Codex-compatible image tool. It is a real Core tool, separate from `read`, and
is gated by the read capability. Image transport and decode checks remain bounded.

### `find`

Search fallback used when search is enabled and command execution was unavailable when the
surface snapshot was built. It covers filename/glob and text search without granting a shell.

### `apply_patch`

The text mutation primitive. It uses the V4A patch envelope and preflights a multi-file patch
before writing. Create, edit, move and delete-file permissions are checked independently.
Directory deletion and arbitrary binary writes are deliberately not hidden patch operations.

### `exec_command`

Runs a command in a real Windows shell. This permission is **not** confined to approved
folders. Long-running commands return an opaque `session_id` that `write_stdin` can continue.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool.

### `session`

Available while session recording is enabled. It has exactly two actions:

- `search` lists the 30 newest recordings when `query` is omitted, or searches titles, exact
  authored messages, errors, agent messages and recorded tool arguments/results across sessions.
  Its ordinary response is bounded to roughly 3,000 estimated tokens and continues by cursor.
- `read` requires an explicit `session_id`. It returns exact user/assistant text, compact tool
  headlines with short session-local `T…` references, and selected errors/agent messages. Read
  pages and expanded tool calls are bounded to roughly 5,000 estimated tokens and continue
  losslessly by cursor; authored messages are never summarized or ellipsized.

`read` also returns an `update_cursor`. Passing that cursor later returns only activity recorded
after the reader's checkpoint. An unfinished assistant message that only grew returns its exact
new suffix; a real rewrite is labeled as a replacement. Session lookup never guesses the calling
chat and never waits for browser identity evidence. Calls to `session` itself remain durably
auditable but are omitted from this projection so reading or polling a recording cannot recursively
copy its previous transcript result into the next one.

Compact & Resume is app/browser orchestration. There is no model-visible `save_handoff` or
`resume_session` tool.

### `agents`

Available while multi-agent mode is enabled. It has exactly five actions:

- `spawn` creates worker chats from one shared context plus per-worker tasks.
- `message` sends one message or an all-or-nothing batch.
- `status` reports the run and workers.
- `finish` is the worker's terminal handoff to the prime.
- `investigate` asks the bounded local Antigravity Flash fast lane for read-only repository reconnaissance. A deterministic router declines trivial lookups, mutation/release work and final verification before any workspace resolution or Antigravity process starts. Returned evidence is advisory; Prime independently verifies it.

There is no model-supplied agent credential or `agent_key`. Worker/prime identity is bound to
the ChatGPT conversation using extension evidence; control calls fail closed when that identity
cannot be proven.

## Desktop tools

### `observe`

Reads desktop state without moving focus: screenshots, windows and UI-control information.
Screen access is independent from mouse/keyboard control.

### `computer`

Executes a bounded batch of desktop actions. The current action set is:
`click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
`focus`, `wait`, `read_clipboard`, and `write_clipboard`.

Each step is checked against the current screen/control/clipboard permissions. Read-only mode
can keep observation available while disabling state-changing desktop actions.

## Permission and discovery invariants

- A tool call is checked against current permissions even if its schema was exposed earlier.
- Core and Desktop do not forward or alias each other's tools.
- A connector token for one surface does not authorize the other surface.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution or desktop control.
- Tool results and validation errors are bounded; large structured or binary payloads must not
  grow without an explicit cap.

## Compatibility notes

Older conversations can retain a cached MCP schema after an upgrade. Refresh/review the app in
ChatGPT, or recreate it if your workspace requires that, then start a new conversation when the
connector's exposed tool shape changes. The current extension pairs automatically with the local
bridge; there is no pairing code to enter.

## Tests that protect the surface

`test/mcp.test.ts` checks exact surface membership, cross-surface rejection, discovery-size
budgets, permission gating, retired names and schema shape. Native image parity has additional
coverage in `test/codex-view-image-parity.test.ts`.

When changing the public tool surface, update the implementation, the surface declarations,
the tests and this document together. Do not add a permanently exposed tool for a workflow
that can be expressed safely through the existing primitives.
