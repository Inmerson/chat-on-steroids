# Current MCP Tool Surface Audit → Android Mapping

Product/code audit was read-only. This worker-owned brainstorm note is the only file changed, per the later user clarification relayed by prime.

## Surface + kernel architecture

The current app has **two real MCP discovery boundaries**. `src/main/mcp/tools.ts` builds a separate `McpServer` for `core` or `desktop`; `src/main/mcp/surfaces.ts` is the declared allowlist and `buildServer()` warns if a registrar leaks a tool across that boundary. Core declares `read`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents`; Desktop declares `observe`, `computer`. Core is intentionally **max 6 tools at once** because `find` and the `exec_command` + `write_stdin` pair are mutually exclusive. Desktop is max 2.

`src/main/mcp/kernel.ts` is the common dispatch/result/security layer. Every handler returns `ToolResult = { content: (text|image)[], isError? }`; there is no separate structured result channel. It centralizes friendly errors, call recording, connector health clocks, per-chat workspace resolution, agent inbox delivery and capability refusals. `src/main/mcp/server.ts` rebuilds from live config but keeps **monotonic exposure** for an endpoint lifetime: once a tool/schema has been exposed it does not disappear under ChatGPT's cached `tools/list`; the live handler instead returns `TOOL_DISABLED` / `FEATURE_DISABLED`. A fresh app/server start resets exposure. `find` exposure is frozen separately so enabling command mid-run cannot make it disappear.

Permissions are model-facing capabilities, not tool names (`src/shared/types.ts`). Current capability keys are `browse`, `search`, `read`, `metadata`, `create`, `edit`, `move`, `deleteFile`, `command`, `screen`, `control`, `clipboardRead`, `clipboardWrite`. `src/main/config.ts::effectiveCapabilities()` is the first read-only gate: global read-only forces `create/edit/move/deleteFile/command/control/clipboardWrite` false; `screen` and `clipboardRead` remain. Handlers gate again.

Two old permissions were deliberately removed during consolidation. `powershell` + `command` became one `command` permission because the single `exec_command` can run either PowerShell or cmd and two checkboxes could not be honestly enforced. `deleteFolder` was removed because the patch grammar cannot delete a directory; folder deletion now requires command execution.

`src/main/connection.ts::toolsFor()` mirrors the current advertisement rules in setup/status. Desktop exists only if one of screen/control/clipboard permissions is useful. On Windows the split earns its setup cost because Desktop is large and optional; in OpenAI-tunnel mode it also costs a second tunnel id.

## Core tools

### `read`

**Role / merge rationale.** One primitive replaces the old read-file, read-many, list-directory, file-info, image-view and roots-style round trips. The model asks one question, “what is at this path?”: a directory lists, a text file returns numbered lines, a supported image returns image content, and other files return metadata/explanation. Roots themselves are placed in server instructions rather than requiring a tool call.

**Registration + permissions.** `src/main/mcp/tools-core.ts:118-230`. Exposed if any of `read|browse|metadata` was enabled. Live handler refuses only if all three are off, then gates per target: directory listing requires `browse`; file contents/image decode require `read`; a regular file without `read` can still return metadata. Every path goes through `kernel.ts::resolveIn()` → `sandbox.ts::resolvePath()` with virtual roots, `..` validation, canonical containment and symlink/junction protection. Real Windows paths are never model-facing.

**Backend.** `fsops.ts::{statInfo,listDirectory,readTextFile,readImageFile}`, `tools-core.ts::{expandGlob,readOne}`, `sandbox.ts`, `workspace.ts`. Bounds: 64 KiB default text read, 512 KiB whole-call cap, 40 expanded targets, 20 glob matches, 200 directory entries. Direct image formats: PNG/JPEG/GIF/WebP.

**Input/result.** `{paths[1..20], start_line?, end_line?, max_bytes?}`. A line range is valid only if expansion resolves to one file. Result is text sections with path/header/line metadata; image targets additionally append MCP image content `{type:'image', data:base64, mimeType}`. One bad target is embedded as an error section instead of failing useful siblings.

**Android.** **KEEP** if user-selected files are a v1 capability. Back it with virtual roots over Android document/storage APIs and keep bounded reads. Port the capability contract, not `node:fs` or Windows path semantics.

### `find`

**Role / merge rationale.** Built-in name/content search for configurations where arbitrary commands are unavailable. It is deliberately absent when `exec_command` exists because shell/ripgrep is more capable and a duplicate seventh Core schema would hurt retrieval.

**Registration + permissions.** `tools-core.ts:233-331`; endpoint-frozen `reg.findExposed`, initially `!command && search`; live calls use `reg.guarded('search')`.

**Backend.** `search.ts::{search,searchOneFile}`. Name search uses a bounded walker. Content search uses a discovered ripgrep binary when available, otherwise a bounded JS scanner. Hard bounds include 40k files, 10 s, 2 MiB/file, max 500 requested results; generated/dependency folders are excluded by default.

**Input/result.** `{query,path?,mode:'name'|'content'?,include?,exclude?,case_sensitive?,regex?,max_results?}`. Plain text result: `path` or `path:line: text`, plus folder-search metadata (`files_scanned`, `elapsed_ms`, `results_returned`, explicit truncation reason).

**Android.** **KEEP only if file search is real v1 scope.** Android should not have a fake general shell, so this becomes the actual search primitive rather than a command-off fallback. Keep it separate from `read`; folding search query/mode into `read` makes the latter less coherent. If v1 is strictly phone-control, omit the whole file subsystem rather than carry dead schemas.

### `apply_patch`

**Role / merge rationale.** The only model-facing file mutation tool. It collapses create/edit/move/delete into one Codex-style multi-file patch transaction. Add creates missing parent folders. There is deliberately no standalone empty-directory creation and no directory deletion.

**Registration + permissions.** `tools-core.ts:333-443`. Exposed if any `create|edit|move|deleteFile` was enabled. Parsed operations are checked individually against live caps: add → `create`; delete → `deleteFile`; content change → `edit`; move → `move`; move + hunks needs both. Global read-only already zeros all four.

**Backend.** `patch.ts::{parsePatch,applyTextPatch}` + `patch-files.ts::applyResolvedPatch` + editable-text codecs in `fsops.ts` + `sandbox.ts`. Full preflight resolves all hunks before the first target change, stages writes, checks collisions/stale files, and conservatively rolls back commit failures. Batch budget is 32 MiB. Patch paths are validated before any normalization could erase traversal intent.

**Input/result.** `{patch: string <= 1,000,000 chars, cwd?}`. Plain text `Applied patch to N file(s)` plus `A`, `D`, `M`, `M→` rows with line deltas and optional placement notes. Backend result is `{kind,path,destination?,delta:{added,removed,approximate},bytes,hunks,warnings?}`.

**Android.** **DEFER for a lean computer-use-first v1 unless editable document trees are explicitly required.** Porting the current “atomic across files” promise onto arbitrary Android document providers is not automatically honest. If added later, keep one patch primitive and describe exactly what the chosen backend can enforce; do not explode it back into four permanent mutation tools.

### `exec_command`

**Role / merge rationale.** One terminal primitive replaces PowerShell/run-command plus procedure-like launch/open/repo tools. Git/npm/build/test/etc. are procedures over this primitive, not schemas. Separate PowerShell/executable permissions were merged because one handler can run either.

**Registration + permissions.** `tools-core.ts:447-524`; registered with `write_stdin` whenever `command` has been exposed; live `reg.guarded('command')`. Only `cwd` is constrained to an approved virtual root. The command string is intentionally handed to PowerShell/cmd unchanged and can access anything the Windows account can. A stray `/virtual/root/...` inside `cmd` is refused because the shell cannot translate it.

**Backend.** `process-manager.ts::{startManagedShellProcess,waitManagedProcess}`, `exec.ts`, `sandbox.ts::{strayVirtualPath,resolveCwd}`. Supports pipes or optional real-console PTY; no wall-clock process lifetime cap; bounded output buffers; max 16 running processes; max 30 s yield per MCP call.

**Input/result.** `{cmd,cwd?,shell:'powershell'|'cmd'?,env?,tty?,cols?,rows?,yield_time_ms?,max_lines?}`. Plain text includes resolved virtual cwd, process id/pid/state/duration, bounded stdout/stderr (or interleaved terminal), cursor, and `session_id` if still running. Non-zero exit is data rather than protocol failure.

**Android.** **DELETE from the normal APK surface.** A normal Android app does not have a Windows-equivalent arbitrary user shell over the device; an app-UID shell would look much stronger than it really is. Android platform operations belong in explicit native primitives, mainly `computer`. A future rooted/developer edition would be a distinct security mode, not a silent fallback.

### `write_stdin`

**Role / merge rationale.** Continuation half of `exec_command`; old process/status/input tools collapse into one operation that sends raw input, polls output, closes stdin, interrupts or kills. It exists because long-lived/interactive terminal sessions are first-class.

**Registration + permissions.** `tools-core.ts:526-601`; same monotonic exposure and live `command` gate as exec.

**Backend.** `process-manager.ts::{getManagedProcess,writeManagedProcess,waitManagedProcess,stopManagedProcess}`. Managed status contains id/pid/command/running/stopping/exit/signal/duration/stdout/stderr/truncation/cursor/pending-lines/stop mode/TTY geometry. Cursor mode returns only unseen output.

**Input/result.** `{session_id,chars?,yield_time_ms?,max_lines?,cursor?,close?,signal:'int'|'kill'?}`. Same formatted process-status text. On pipe sessions `int` honestly closes stdin instead of pretending Ctrl-C was delivered.

**Android.** **DELETE with `exec_command`.** Without a real process-session primitive there is no reason for a second schema.

### `session`

**Role / merge rationale.** Model-visible forensics over the app's local recording, so a long/compacted chat can recover an exact old call/error instead of guessing. It lives on Core instead of a one-tool connector because the recording is part of the working loop and another connector would be setup cost with no retrieval win.

**Current-state correction.** The **current handler only supports `history | status`** (`tools-core.ts:617-747`). Its own comments explicitly say there is **no `resume` and no `save_handoff`** now: Compact & Resume is app-owned end-to-end and the replacement chat is opened with the handoff already injected. Older docs/prose implying those are session actions are stale.

**Registration + permissions.** Feature-gated by session recording, not a capability. Exposure is monotonic; if recording is turned off after exposure the handler returns `FEATURE_DISABLED`. Global read-only does not disable it. Current MCP annotation is `readOnlyHint:false` although both current actions are observational.

**Backend.** `session/recorder.ts::{sessionIdForConversation,sessionTokens,awaitFreshCallOrigin}`, `session/store.ts::readEvents`, `kernel.ts::{describeEvent,expandStored,chunkText}`, and `process-manager.ts::listManagedProcesses`. Current-session resolution depends on conversation attribution from page/request-id evidence. Long stored call payloads can be recovered from overflow assets; one expansion is chunked at 24 KiB per result.

**Input/result.** `{action:'history'|'status',part?,session_id?,query?,kind?,call_id?,from?,limit?}`. `status` returns session id, explicitly-labelled local token estimate/pressure and running commands. `history` returns compact event lines or one stored tool call's exact args/result in numbered parts. Plain text only.

**Android.** **Do not blindly port the MCP `session` tool in v1; KEEP the user-visible Activity timeline regardless.** Windows gets per-conversation identity from the paired browser extension/request-id correlation. An Android connector without an equivalent page observer cannot honestly know which ChatGPT conversation an otherwise stateless MCP request belongs to. If Android gets a stable caller/session identity from transport/host, keep this flat `history|status` tool. Otherwise log Activity in-app but omit fake “current chat session” semantics.

### `agents`

**Role / merge rationale.** One experimental flat orchestration schema replaces separate agent lifecycle/message tools. Identity is deliberately *not* a model-supplied bearer key: a worker is the ChatGPT conversation opened/bound by the extension, and prime identity is proven from exact current-call page/request-id evidence. `join` is recovery-only if automatic worker binding was lost. Routing is strict star topology: prime ↔ workers, never worker ↔ worker.

**Registration + permissions.** Whole-feature gate, default off. Monotonic feature exposure; after toggle-off handler returns `FEATURE_DISABLED`. Global read-only does not disable the broker itself. Schema actions are `spawn|join|message|status|finish`.

**Backend.** `agents.ts::{spawn,join,sendMessage,identify,finishAgent,swarmState}`, `tools-core.ts::callerNow`, `session/recorder.ts::awaitFreshCallOrigin`, common delivery/recording in `kernel.ts`. Messages are appended at-least-once to later tool results and acknowledged only by later authenticated activity. Worker task/message/result max 4,000 chars; label max 60.

**Input/result.** Plain text. `spawn` names run + created worker ids; `join` returns recovered identity/task; `message` returns message id; `status` prints role/state/pending/result summaries; terminal `finish` confirms result delivery and is idempotent on retry. Shared `AgentInfo` includes id/role/label/task/state/timestamps/result/pending+ack counts/conversationId.

**Android.** **DEFER / DELETE for v1.** The present broker depends on a browser extension that can open a ChatGPT worker tab, bind its conversation id before the model speaks, and supply exact page identity evidence. Do not port the broker and replace proof with timing guesses. Multiple agents concurrently driving one phone also complicate global frame/UI state. Reintroduce only after Android has an equally strong conversation/worker-launch identity primitive.

## Desktop tools

### `observe`

**Role / merge rationale.** One read-only perception primitive replaces screenshot, window list/active state, UI Automation inspection/search and window wait. It is deliberately separate from `computer`: looking never requires foreground focus and remains the recovery path when focus is wrong; touching is the only place allowed to demand control.

**Registration + permissions.** `src/main/mcp/tools-desktop.ts:90-260`; exposed under `screen`, live `reg.guarded('screen')`.

**Backend.** `computer/index.ts::{activeWindow,listWindows,getWindowState,findUi,waitForWindow,screenshot}` backed by one long-lived PowerShell/Win32/UIA helper using newline-delimited JSON. Desktop operations share an exclusive lock. UI refs are state/generation-scoped; screenshots have frame ids. `getWindowState` acquires screenshot + UI under one lock so geometry belongs to the same moment.

**Input/result.** `{what:'active'|'windows'|'window'|'ui'?,window?,match?,wait_for?,timeout_ms?,screenshot?,max_width?,max_elements?}`. Window lists are text rows. UI results contain refs/name/role/automation id/bounds/image centers. Active/window normally returns text + base64 PNG MCP image content; if there is no foreground window it can return the primary monitor instead of failing. A window screenshot says when focus could not be obtained so possible occlusion is explicit.

**Android.** **KEEP as the primary perception tool.** Preserve the logical result: foreground/app/window identity where available, screenshot frame, accessibility/UI nodes with stable short refs, and wait/search over UI. Replace Win32/UIA/PowerShell with Android-native accessibility/window/screenshot primitives. Preserve the key invariant that observation itself does not depend on control/focus and that screenshot + node geometry are one coherent state.

### `computer`

**Role / merge rationale.** One batched action primitive for all interaction. Clipboard was folded into it because clipboard is part of moving text between apps and batching write-clipboard + paste is materially better than extra MCP round trips. It can be exposed for clipboard-only users, while individual actions keep their own live gates.

**Registration + permissions.** `tools-desktop.ts:262-407`; exposed if any `control|clipboardRead|clipboardWrite`. Any non-clipboard action in the batch needs `control`; `read_clipboard` needs `clipboardRead`; `write_clipboard` needs `clipboardWrite`; `captureAfter` additionally needs `screen`. Read-only mode disables control + clipboardWrite but leaves clipboardRead. The cached schema stays stable rather than adding/removing clipboard variants when a checkbox changes.

**Current action union.** Exactly **13 variants** in current code: `click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`, `focus`, `wait`, `read_clipboard`, `write_clipboard`. Up to 20 actions/call.

**Backend.** `computer/index.ts::actAndCapture` → `actLocked` + optional `screenshotLocked`, all under one global exclusive lock. Coordinate actions map image pixels through the last screenshot frame; optional `frameId` yields `STALE_FRAME` if another capture replaced it. UI refs re-resolve live and become `STALE_REF` after helper restart. Clipboard executes in the same ordered critical section. Backend result is `{cursor:{screen,image,frameId,imageSize}, screenshot|null, clipboard:string[]}`.

**Input/result.** `{actions,frameId?,captureAfter?,captureWindow?,captureFull?,captureMaxWidth?,captureCrop?}`. Text lists completed action types, pointer/frame and ordered clipboard reads; optional capture appends a fresh PNG and new frame id.

**Android.** **KEEP as the primary action tool.** Preserve batching, ref-first interaction, stale-state checks and optional verify-after capture. Map vocabulary to Android accessibility/gesture/text/global-action primitives. Drop/redefine Windows-only semantics rather than emulate them badly: e.g. `focus(window)` should exist only if Android has an enforceable target operation. Clipboard stays here only if the platform can honestly provide/gate it under the declared capability.

## Current drift found during audit

1. `tools-core.ts` is authoritative that `session` only supports `history|status`; older `docs/tool-surface.md` / surface prose still reflects the earlier resume/save-handoff design.
2. `instructions.ts:98-100` tells a worker to call `agents action=join to get your task`, but current broker/tool comments say workers are automatically extension-bound before their first model turn and `join` is recovery-only. This server instruction is stale and can provoke unnecessary recovery calls.
3. `surfaces.ts:119` says `computer` carries eleven action variants; current `tools-desktop.ts` schema has thirteen.

Audit finding only; product code was not changed.

## Recommended Android v1 surface

**One connector, one tunnel.** The Windows Core/Desktop split solves a Windows-specific tradeoff: coding is primary while desktop automation is optional/heavy. In the proposed Android product, phone control is primary, so forcing a second connector for the main feature inverts the reason for the split. One surface remains small enough with `observe`, `computer`, optional `read`, optional `find`, and later `apply_patch` only if editable storage is truly supported.

Omit `exec_command` + `write_stdin`; omit `agents` until strong conversation identity/worker-launch exists; expose `session` to the model only if caller identity is provable, while always keeping an app-side Activity timeline.

Preserve the cross-platform invariants that matter: tiny primitives instead of procedure tools; schemas only for capabilities the APK can really enforce; live handler gating plus monotonic schema exposure; global read-only as a derived cap mask; bounded outputs; virtual roots instead of raw device paths/URIs; stale screenshot/ref protection; one serialization point around phone state; and user-visible records of every MCP call/outcome. Kotlin should own these contracts. Platform adapters underneath should be narrow enough that no Windows compatibility layer survives merely for symmetry.
