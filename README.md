# ChatGPT Local Files

A small Windows utility that gives ChatGPT access to folders **you** approve, over MCP, from your own PC.

It is only a bridge and a permission manager. It has no chat interface of its own: you keep using ChatGPT, and this app decides what ChatGPT is allowed to touch.

- Approve one or more folders. Nothing outside them is reachable.
- ChatGPT sees short virtual paths like `/project`, never your real Windows paths.
- Optionally let it see the screen and drive the mouse and keyboard.
- Read-only by default. Writing, controlling and running commands are separate opt-ins.
- Optionally record a long coding session locally, show what each tool call actually did, and [compact it into a handoff](#compaction-and-resuming-a-session) you can resume in a fresh chat.
- Runs quietly in the tray once it is set up.

## Requirements

- Windows 10 or 11, 64-bit
- A ChatGPT account/workspace where **Developer mode** and custom MCP apps are available on the web. Plan availability and whether custom MCP tools may perform write/modify actions are controlled by ChatGPT and can change during rollout; check the current OpenAI Developer mode documentation if the option is missing.

The installer ships the version of [`tunnel-client`](https://github.com/openai/tunnel-client/releases) that was current when it was built, so the recommended method works out of the box. A copy you installed yourself takes precedence: the app checks your explicit choice first, then `PATH`, then the usual install locations, and only then its own copy. For a Cloudflare quick tunnel you need [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/); for your own HTTPS tunnel you need nothing.

## Installation

Download and run `ChatGPT-Local-Files-Setup-<version>.exe`, or build it yourself (see [Building](#building)).

The installer is per-user and never asks for administrator rights. The app itself runs as an ordinary user and never elevates.

## Connecting it to ChatGPT

The **Setup** tab walks through this step by step and ticks each step off as it is done. The exact wording in the ChatGPT settings has moved around; the app shows the current steps for the method you picked. In outline:

### OpenAI Secure MCP Tunnel (recommended)

1. Approve a folder. The tunnel will not start with nothing to serve.
2. In [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), create a tunnel — in the **same workspace you use in ChatGPT**, or it will not appear later — and copy its ID (`tunnel_…`).
3. In [Platform → API keys](https://platform.openai.com/settings/organization/api-keys), create a **Restricted** key with **Tunnels: Read** and **Use**, and nothing else.
4. Paste both into the Setup tab and press **Connect**.
5. In ChatGPT, turn on **Developer mode** in Settings. It currently sits under *Security and login*; some accounts show it under *Apps → Advanced*.
6. Go to **Settings → Connectors**, create an app, choose **Tunnel** as the connection, pick your tunnel, and — at the very bottom of the authentication list — choose **No authentication**. The connector is protected by a secret address, not a login.

### Cloudflare quick tunnel

1. Press **Connect** and copy the URL the app shows.
2. Turn on **Developer mode** in ChatGPT, then go to **Settings → Connectors**.
3. Create an app, paste the URL, and choose **No authentication**.

The URL is public, and the random path in it is the only thing protecting your files, so treat it like a password. It changes every time the app restarts.

### Run your own tunnel

Press **Connect**, point your own HTTPS tunnel at the loopback URL shown on the **Connection** tab, and give ChatGPT the public equivalent — including the secret path.

After changing permissions, the app shows a reminder that ChatGPT may still have the conversation's older tool snapshot. Start a **new ChatGPT conversation** to guarantee that the changed tool list is loaded; refreshing the connector may also help, but the app does not pretend it can force an already-running conversation to refresh.

## The permission model

Access is granted per folder. There is no "allow everything" switch.

- Each approved folder becomes a **virtual root**: `C:\Users\you\code\my-app` might become `/my-app`.
- Every path from ChatGPT is validated in code before any file is touched: `..`, absolute paths, `\` and `/` mixing, `:` (alternate data streams and drive-relative paths), reserved device names (`CON`, `NUL`, `COM1`, …), trailing dots and spaces, control characters and null bytes are all rejected.
- Paths are canonicalised with `realpath` and re-checked, which rejects a **symlink, junction or other reparse point** that already escapes an approved folder. This is a static namespace check: ordinary Node path APIs cannot close a same-user process swapping an ancestor after validation, so concurrent reparse mutation remains a documented Windows limitation until file operations are handle-relative.
- Comparisons are case-insensitive on Windows, and a root named `C:\Root` never matches `C:\RootEvil`.
- Network (UNC) paths and whole drives cannot be approved, and roots may not overlap each other.

None of this is left to the model to respect. It is enforced before every operation.

## Tools

The tools are published across **two connectors**: **Core** (files, search, commands, sessions, agents) and **Desktop** (screen and input). Each is its own MCP server with its own URL, so a coding chat never pays for the desktop schemas. `docs/tool-surface.md` is the decision record for that split and for the shape of every tool below.

Core declares eight possible names but exposes at most **seven** at once; `find` and the `exec_command`/`write_stdin` pair are mutually exclusive. Desktop adds at most **two**, for a combined maximum of **nine**. Approved folders are described in the server instructions rather than by a tool, so nothing has to be called to discover them. On a fresh connection a tool appears only when a permission that uses it is on. During one running connector session the exposed tool surface is deliberately monotonic: if you later revoke a permission, an already-exposed tool stays registered but returns `TOOL_DISABLED`. This avoids stale ChatGPT tool caches turning a permission change into an `UNKNOWN` transport failure while still enforcing the live permission on every call.

| Capability | Tool | Notes |
| --- | --- | --- |
| Browse folders | `read` | Lists a folder one level deep; recursion is a glob |
| Read files | `read` | Bounded line ranges, up to 20 paths at once; PNG/JPEG/GIF/WebP come back as images |
| View one image | `view_image` | Separate Codex-shaped image contract with structural decode and pixel/wire bounds |
| File metadata | `read` | Size, timestamps and line count, without returning contents |
| Search files | `read`, `find` | Globs expand inside `read`; `find` searches by name or by text and appears only while **Run commands** is off |
| Create files | `apply_patch` | `*** Add File:` — parent folders are created as a side effect; an empty folder on its own needs **Run commands** |
| Edit files | `apply_patch` | `*** Update File:` with `@@` context, preflighted and rolled back as one transaction across every file the patch touches |
| Move / rename | `apply_patch` | `*** Move to:` — both ends must be inside approved folders |
| Delete files | `apply_patch` | `*** Delete File:` — permanent, no Recycle Bin. Deleting a folder needs **Run commands** |
| Run commands | `exec_command`, `write_stdin` | PowerShell or `cmd`, including long-running and interactive sessions; see the warning below |
| See the screen | `observe` | Screenshot, window list and UI Automation controls, without bringing anything to the front |
| Control mouse and keyboard | `computer` | Batched actions with optional `captureAfter`; see the warning below |
| Read clipboard | `computer` | `read_clipboard` action — text only, capped and separately permissioned |
| Write clipboard | `computer` | `write_clipboard` action — replaces clipboard text without synthesizing keystrokes |
| Continue a session | `session` | `history` · `status`. Only with [session recording](#session-history-and-the-chrome-extension) on |
| Coordinate agents | `agents` (`spawn` · `message` · `status` · `finish`, plus `join` for recovery) | Only with [multi-agent mode](#multi-agent-mode-experimental) on |

One tool per concept is deliberate: eleven mutation tools were eleven chances to pick the wrong one, and a wrong pick costs a retry worth far more than the schema it saved. Anything that used to be its own tool — git inspection, launching an app, opening a URL, killing a process tree, saving an image — is now a use of one of these primitives, described in the server instructions rather than exposed as a permanent tool.

Output is bounded everywhere. `read` caps the whole call and reports which lines you got and where to continue; listings, globs and searches report when they stopped early, and searches have a time budget. Ordinary binary files return metadata and the reason they were not decoded, rather than being dumped as mojibake, while supported PNG/JPEG/GIF/WebP structure is validated before it is returned as native MCP image content for vision.

`apply_patch` is the only way text changes. It takes Codex's V4A envelope verbatim — `*** Begin Patch`, `*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:`, `@@` context — because that format carries more model training mass than any alternative, and it matches on context rather than line numbers, which is what stops the accidental whole-file rewrites that line-number edits invite. One patch may touch several files: every path and hunk is preflighted, replacements are staged beside each target, and a commit-time failure triggers a guarded reverse rollback. This deliberately does **not** claim filesystem-wide ACID atomicity across unrelated files; a process or OS crash during the short commit window is still outside what ordinary NTFS file primitives can guarantee.

Permissions stay independent where they were independent, even though one tool now carries them all: a patch that only moves a file needs Move, not Edit; one that also carries hunks needs both. A patch is refused whole if any part of it needs a permission that is off.

Writing raw bytes is the one genuine gap in `apply_patch`. It does **not** bridge ChatGPT's private image-generation environment into Windows either way: a generated image is only writable when the model is given its bytes or another transferable file representation, and the connector cannot manufacture access to an artifact ChatGPT does not expose to it.

### Computer use

Two capabilities, off by default and independent of each other. Both live on the **Desktop** connector.

**See the screen** adds `observe`, which answers with the active window, a window list, one window's state, or the UI Automation controls on screen, and can wait until a matching window appears instead of forcing the model to poll with blind sleeps. Screenshots come back in the same coordinate space used by pointer actions. `observe` never requires a window to be in front and never fails for lack of focus — reading a known window is something Windows permits without activation.

**Control mouse and keyboard** adds `computer`, which takes a list of actions performed in order: `click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`, `focus`, `wait`, plus the two clipboard actions. Coherent actions can be batched and `captureAfter` can return the next screenshot in the same tool call, avoiding an extra round trip. The vocabulary deliberately matches OpenAI's computer-use tool; coordinates are pixels in the most recent screenshot, so pointing before looking is refused rather than guessed at. `focus` is the one action allowed to fail for lack of foreground, and it names the window it found there when it does.

Both run through a single PowerShell helper that uses `SendInput` and GDI. Input is synthesised as the ordinary user — it cannot click anything you could not click yourself, and it cannot touch an elevated window.

`control` is a write capability and read-only mode forces it off. `screen` is not, because looking at the screen changes nothing; if you want ChatGPT to look but never touch, leave read-only mode on and enable **See the screen**.

Screenshots capture whatever is on screen, including windows that have nothing to do with the folders you approved. This is the one capability the folder sandbox does not constrain.

### Read-only mode

Read-only mode is on by default. While it is on, every writing, command and control capability is forced off no matter what the individual checkboxes say, and those tools do not appear to ChatGPT at all.

Read tools are marked `readOnlyHint` so ChatGPT does not interrupt you for each one; writing and deleting tools are marked destructive so it asks before running them. Read what it shows you before approving.

### Running commands — please read

`exec_command` and `write_stdin` let ChatGPT **execute code on your PC as you**. They are one permission — **Run commands** — off by default, and they should stay off unless you actually need them. While that permission is off, `find` takes their place for the read-only work they used to be asked to do: it searches by name or by text and cannot accept shell text at all. This also gives ChatGPT a safer fallback when its own tool-safety layer refuses an unnecessarily broad execution request before it ever reaches this app.

When enabled:

- commands *start* in an approved folder — a `cwd` outside your approved roots is refused, and every result states which folder it actually ran in — but the command itself is **not** confined to that folder the way file operations are,
- they run as the ordinary user, with no elevation and without bypassing PowerShell's execution policy,
- PowerShell is passed with `-EncodedCommand` and a fixed UTF-8 `InputEncoding`, so the text never reaches a command-line parser and output does not arrive as mojibake,
- Windows `.cmd`/`.bat` shims such as `npm` go through a fixed PowerShell launcher with the command and argv passed through environment variables, rather than being interpolated into a command line,
- output and runtime are bounded: `exec_command` yields after `yield_time_ms` and returns a `session_id` only while the process is still alive,
- `write_stdin` continues that session — writing bounded text, polling with an opaque cursor so it gets only new output, closing stdin, or sending `signal: 'int'` (Ctrl-C on a tty, stdin close on a pipe) or `signal: 'kill'` to force-terminate the whole tree,
- both accept a small bounded map of explicit environment overrides; values are never logged and `CLF_*` names are reserved for connector internals,
- known credential environment variables — this app's own tunnel and API keys among them — are removed from the inherited child environment. A value is present only if the caller explicitly supplies an override for that name,
- managed sessions are cleaned up when this app quits.

On Windows, managed-process shutdown uses the built-in process-tree termination path and does not ship a native Job Object binding. A normal app quit therefore cleans managed jobs up, but a hard crash or forced kill of the Electron process can still leave an already-started child alive. Adding `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` would close that gap, but doing it reliably requires native Windows handle/job APIs; this project intentionally avoids adding a native dependency solely for that edge case.

That is still arbitrary code execution. Treat it as such.

## Session history and the Chrome extension

A long coding session in ChatGPT is hard to review: the tool calls collapse into identical `Called tool` rows, progress lines scroll away, and when the conversation finally runs out of room there is nothing to carry into the next one.

**Chat → Record this session** fixes both halves of that. It is **on for a new config**; an existing config keeps the choice you already made. While it is off, nothing about conversations is written to session history on disk. Multi-agent mode can still start the browser bridge when recording is off, but it does not silently enable session recording.

With it on:

- Every MCP call this app runs is recorded **as it executes** — the real tool name, the real arguments, the real result, timing, and edit metadata such as which files changed and by how many lines. It is not reconstructed from log strings, and it does not depend on reading anything back out of the ChatGPT page.
- The **Chat** tab lists your recent sessions and shows the current one as a single chronological timeline: your messages, ChatGPT's visible replies, its progress lines, and every tool call in the order they happened.
- The small in-memory **Activity** log is unchanged. It stays redacted, capped and off-disk; the recorder is a separate, explicitly enabled feature with its own storage.

The optional Chrome extension in [`extension/`](extension/) adds the browser half: what you typed, what ChatGPT said, its live progress, and whether a turn finished, failed, was stopped or was interrupted. It also **relabels ChatGPT's tool-call blocks** with what the call actually did — `Edited src/main/mcp/tools.ts +18 −4`, `Read tools.ts · lines 200–420`, `Searched "registerTool" · 30 matches`, `Ran npm run verify ✓ 4.8s` — and restores full legibility to the live progress/reasoning containers it observes instead of leaving them at ChatGPT's faint secondary opacity. A page reload or close while ChatGPT is still generating is recorded as an unknown browser detach rather than a fake interruption; if the same chat later reveals the final assistant message, the recorder reconciles that turn to completed. Known ChatGPT transport-failure markdown such as a delivery timeout is recorded as an error instead of assistant prose. The complete recorded arguments/results remain available from the Chat timeline and `session_history`; the relabel itself does not claim to reconstruct data the page did not render.

### Installing the extension

It is not on the Chrome Web Store; load it directly.

1. Leave **Chat → Record this session** on, or enable it if your existing config has it off. The local bridge also runs when experimental multi-agent mode is enabled, because workers need the extension even if session recording is off.
2. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick the `extension` folder.
3. Click the extension's toolbar icon. It discovers the loopback bridge and pairs silently.
4. If you previously chose **Disconnect browser**, use the popup's reconnect action once.

The extension only runs on `chatgpt.com` and `chat.openai.com`, and only talks to `127.0.0.1` on the five ports the app may use (8765–8769). Pairing provisions a bearer token directly between the extension service worker and the loopback app; no code or token enters the ChatGPT page.

### What is written, and where

Sessions live under `%APPDATA%\chatgpt-local-files\sessions\<id>\`:

```
events.jsonl      one JSON event per line, appended and never rewritten
messages/         canonical user/assistant messages, one replaceable shard per stable identity
messages.json     legacy canonical map, read during lazy migration of older sessions
meta.json         the summary the Chat tab lists (rewritten atomically)
assets/<sha256>   large payloads — screenshots, images — stored once by content hash
handoffs/<id>.json  compaction results
```

The event log is the source of truth and is **append-only**. Compacting never rewrites or deletes it. A crash mid-write can cost the one event that was being appended; the next open seals the torn line rather than gluing the next event onto the damage.

Recording is *more* revealing than the Activity log, because that is the point — it keeps what a summary would need. Environment-variable values, clipboard contents and live agent credentials are still redacted. Large message/tool fields are bounded inline and, where supported, spilled into local session assets so recovery does not quietly lose the rest. Old sessions are deleted after **30 days** by default (**Chat → Settings**; `0` keeps everything), except that the session behind the newest handoff is always kept so a resume never dangles.

## Compaction and resuming a session

When a session gets long, the Chat tab shows a local **estimate** of its size. New configs warn around **300k** estimated tokens, treat **400k** as the observed limit, and arm automatic Compact & Resume on the completed turn that crosses **300k**; existing explicit settings are preserved. That estimate is ours, computed from messages and tool input/output; transient live progress/reasoning captions are deliberately excluded because they frequently restate work that later appears again. ChatGPT's own context counter is private, so the app does not pretend to know it, and it does not label every unexplained stop as an output limit — a turn is reported as completed, failed, stopped by you, apparently interrupted, stalled, or simply unknown, according to what was actually observed.

**The chat writes its own handoff.** Compaction asks the ChatGPT conversation being compacted for a brief written for a coding agent rather than a reader: the original task and every later correction, exact paths and versions, what is definitely done versus only discussed, files changed, command and test results, unresolved failures, what remains, and what must not be repeated. It leans on tool evidence rather than on the assistant having said it planned to do something. Nothing is sent to any other model or service, and there is no API key to configure: the participant that did the work is the one that describes it.

**Compact & resume** is pressed in the ChatGPT tab, from the **+** composer submenu. What happens next is one transaction the app owns end to end:

1. The page asks the app to start a compaction; the app hands back the brief instruction, exactly once per transaction, so a second press or a reloaded tab cannot start a second one.
2. ChatGPT writes the brief as its answer. The page watches that exact generation, so a retry or an unrelated later answer cannot be mistaken for the brief.
3. The brief is stored locally and the app opens one fresh ChatGPT chat itself, with a correlation marker in the URL. Only the page holding that marker is given the brief, and only once.
4. When that page reports which conversation it became, the app **rebinds the same local session** onto the new chat — its history, its workspace, its swarm — and only then retires the old one.

Every failure leaves the session exactly where it was, in the chat you are already in. The brief is typed into the fresh chat as an ordinary first message; there is no handoff id to quote and no tool for the new chat to call before it can start. `session_history` remains available for a narrow slice of the original recorded events — a specific tool call, a search, a range — when the brief is not enough. The raw history stays available; the brief never replaces it.

The desktop window shows the stored handoff and can copy it, but it cannot start a compaction: the brief is written by the chat, so the button lives where the chat is.

## Multi-agent mode (experimental)

**Off by default, and worth leaving off unless you want it.** Several ChatGPT tabs editing the same files at once is a genuine hazard, and this is the least settled part of the app.

When enabled under **Chat → Settings**, the chat you are in becomes the **prime** agent by calling `agents` with `action='spawn'`. There is one tool, with five actions: `spawn`, `message`, `status`, `finish` and — for one specific failure only — `join`.

Spawning opens a fresh ChatGPT tab per worker, **with that worker's task as the first message**. Nothing else is asked of it: the extension tells the app which conversation it opened for which slot, and that report is what makes the chat a worker, before the model in it has read a word. So a worker starts working immediately, and everything it does afterwards is attributed by the conversation it is in.

- The hierarchy is enforced, not merely suggested: **workers talk only to the prime, and the prime talks to individual workers. Worker-to-worker messages are refused.**
- Messages are delivered by riding along on authenticated tool results, so an agent that is working picks up whatever was said to it without polling. Delivery is at-least-once: an offered message is retired only when that agent makes its next authenticated call, so a dropped connector response causes a repeat rather than silent loss.
- Routing, pending messages and swarm state survive app restarts. The extension only opens the fresh chats and types the first message; worker ↔ prime messages themselves stay in the MCP broker.
- **Agent identity is the conversation, and nothing else.** No agent holds a credential, no tool has a key field, and a caller-supplied agent id is never accepted as proof. The prime is the chat that spawned, bound from that chat's own proven conversation; a worker is the chat the app opened for its slot. A control call the app cannot place in a conversation is refused by name rather than guessed at — and ordinary file and command calls from chats that have nothing to do with a run keep working exactly as before.
- **One press opens one chat.** A bootstrap is delivered once, to the one page the app opened for it, under a 90-second deadline. If that page never reports back, the worker slot is failed and the prime is told, or the compaction stays in the chat it started in. There is no background retry loop and no periodic queue poll: work is never re-offered as a tab that opens minutes after everyone stopped expecting it.
- `agents(action='join')` exists only to recover a worker chat whose binding never arrived. It needs a one-time key the app mints on an explicit click in the desktop window, for you to paste; the key is spent on use and cannot move a worker that is already bound. In a run that works, nobody ever calls it.
- Authenticated recorded tool calls and Activity rows are attributed to their agent, and the Activity tab gains an All / Prime / per-worker filter. Calls that cannot be proven to belong to an agent stay explicitly unattributed rather than being guessed into the wrong worker. With no swarm running, that view is exactly as it was.
- Multi-agent mode is off by default. When enabled, workers are capped at two by default and eight maximum, and the app warns when two agents are working on the same file.

## Privacy and security

- **Your files stay on your PC.** The app sends nothing anywhere by itself; ChatGPT receives exactly what a tool call returns.
- **The local server binds to `127.0.0.1` only**, never `0.0.0.0`, on a random port. Nothing on your network can reach it.
- Requests must carry a **32-byte secret path token**, regenerated on every app start and compared in constant time. The `Host` and `Origin` headers must be loopback, so a web page cannot drive the endpoint, and oversized bodies are rejected.
- **Credentials are stored with Windows DPAPI** through Electron's `safeStorage`, in a separate file from the settings — never in the JSON config, never in logs, never exposed to the UI process. The API key is passed to the tunnel through the environment, never on a command line.
- **The extension bridge is a second loopback server with a deliberately tiny surface**, and it runs only while session recording or experimental multi-agent mode needs it. It binds `127.0.0.1`, offers no filesystem, command or configuration route at all, and every route except the identifying `/hello` and local provisioning `/pair` needs a bearer token. `/pair` silently provisions that token to the extension service worker; it is never handed to a content script or the page. The bridge rejects every `http(s)` origin, so no web page — including chatgpt.com itself — can reach it; only an extension can. Browser commands are narrowly limited to opening a fresh ChatGPT chat and inserting its first message, delivered to exactly one page under a deadline, so a failed tab ends the job visibly instead of silently consuming it.
- **Logs stay in memory**, are capped at 500 entries and are never written to disk. File contents and command output are not logged, and anything shaped like a key or token is masked as a backstop. `CLF_DEBUG=1` echoes the same redacted lines to stderr for troubleshooting.
- The UI runs with context isolation on, Node integration off, the sandbox on and a strict CSP. It has no filesystem or network access of its own and talks to the app through a fixed list of named IPC channels, each validated on arrival. External links are limited to a fixed allowlist of documentation URLs.
- **Session recording is on for new configs; existing configs keep their explicit choice.** Turning it off stops conversation history from reaching disk, although enabled multi-agent mode can still keep the loopback browser bridge running. Nothing sends recorded content off this PC: compaction is written by the ChatGPT conversation itself, so there is no second provider and no API key for it.
- Settings live in a small JSON file in `%APPDATA%\chatgpt-local-files\` (Electron's `userData` folder for this package). It is re-validated on load, so a corrupted or hand-edited file cannot widen permissions, and it survives uninstalling and reinstalling the app.
- The endpoint answers **JSON and nothing else**, including for 404s, so a client performing OAuth discovery against it never has to parse a plain-text body. It serves RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource<secret-path>` only — never at the bare well-known root, which would disclose the secret path to an unauthenticated caller.

## Troubleshooting

**"Tunnel unavailable" / it cannot find the tunnel program.** Use **Browse…** under *Setup → Advanced* to point at `tunnel-client.exe` or `cloudflared.exe`.

**"Authentication failed".** The API key or tunnel ID is wrong, the key lacks **Tunnels: Read** and **Use**, or the tunnel belongs to a different workspace than the one you use in ChatGPT.

**"No internet".** This PC cannot reach OpenAI right now — the tunnel program itself is fine and keeps retrying, so the status goes back to *Connected* on its own once the network returns. The status comes from the tunnel's own log, not from a reachability test of ours: nothing is sent anywhere to produce it.

**It says connected but ChatGPT cannot reach it.** The app watches the tunnel's own readiness endpoint every 15 seconds and restarts it with backoff when it stops answering, so a tunnel that dies quietly — after a sleep or a reboot, say — recovers on its own; the **Activity** tab shows the reason it reported. If ChatGPT itself answers `This conversation does not support developer MCPs`, that is ChatGPT-side and no request ever reaches this app (the **Activity** tab stays empty, which is how you can tell them apart): start a new conversation with the connector enabled.

**ChatGPT does not show the new tools, or still shows one you disabled.** Permission changes take effect in the app immediately, but ChatGPT can cache an older MCP schema. Reconnect/reload that connector in ChatGPT, then start a new conversation so it discovers the current surface. This connector refresh is separate from reloading or pairing the browser extension; the desktop app itself does not need restarting.

**ChatGPT cannot see a file.** Check the folder is approved on **Home**, and that the relevant read capability is on. Build and dependency folders (`node_modules`, `.git`, `dist`, `build`, …) are skipped by searches unless you ask for them explicitly — the model can pass its own exclude list, including an empty one.

**A file comes back truncated.** That is deliberate. Use `startLine`/`endLine`, or follow the resume hint in the response.

**Nothing works and the window is blank.** Run the app from a terminal with `CLF_DEBUG=1` set and check the output, or open the **Activity** tab and press **Copy**.

**The extension says "app not found".** The bridge listens while **Chat → Record this session** or experimental multi-agent mode is on. Turn on the feature you intend to use, then reopen the extension popup.

**Calls land in Unattributed or a worker says identity was lost.** The app did not receive exact ChatGPT request-id evidence for those calls. Reload the extension once so both the isolated recorder and MAIN-world Fiber helper are current; do not manually assign those calls to the active-looking chat. If it persists, capture the Activity/session evidence because timing or the active tab is intentionally never used as an ownership guess.

**Reload makes the transcript jump, duplicate, or close the wrong chat.** Reload is not a conversation close. Update to the current extension files and reload the unpacked extension, then reload the ChatGPT page once. If it repeats, preserve the session and service-worker evidence: the relevant identity is the browser document/navigation generation, not merely the tab id or conversation URL.

**The extension is paired but tool blocks are not relabelled.** Relabelling is deliberately all-or-nothing per logical turn: if the number of tool blocks ChatGPT rendered does not match the number of calls recorded for that `data-turn-id`, or a call could not be attributed to a turn with confidence, the original ChatGPT UI is left exactly as it is rather than guessing. The adapter groups split assistant sections that share one turn id, reads assistant prose from the current `.markdown` shape when no assistant `data-message-id` exists, and scans multiple progress/interruption sections. Multi-agent prime calls are rebound to the prime's ChatGPT conversation when that mapping is provable; a restored authenticated agent can also self-heal its recording target when exactly one conversation is generating. The Chat tab still shows the full timeline. ChatGPT can change this private markup at any time; an unrecognised shape should degrade by leaving the page alone rather than relabelling a guess.

**Overwrite disappears, sticks, or shows stale activity.** Overwrite only replaces a turn when the local stream completely and exactly represents the page-model calls it would hide. A new unrecorded call, missing request correlation, or incomplete activity page deliberately restores ChatGPT's native UI instead of inventing a complete stream. Use the Chat tab to distinguish missing local activity from a presentation-only mismatch.

**Compaction fails.** The button in the ChatGPT composer shows the actual error. The usual causes are the extension not being paired, the chat being interrupted while it was writing the brief, or the fresh tab never coming up. Nothing is deleted when it fails, no new chat is opened unless the handoff was saved, and the session stays in the chat it is already in.

**Settings vanished after reinstalling.** They should not: everything lives in `%APPDATA%\chatgpt-local-files\` and the uninstaller is configured to leave it alone.

## Development

```sh
npm install
npm run dev        # run the app with hot reload
npm run verify     # typecheck + tests
npm test           # tests only
```

The code is deliberately small and direct. Layout:

```
src/main/          privileged process: sandbox, filesystem, search, exec, MCP server, tunnel
src/main/mcp/      MCP server, tool definitions, server instructions, per-call context
src/main/session/  append-only session store, recorder, summaries, compaction
src/main/tunnel/   connection adapters (OpenAI tunnel, cloudflared, manual)
src/main/computer/ screenshots and input, and the PowerShell helper they drive
src/main/bridge.ts loopback server the Chrome extension pairs with
src/main/agents.ts multi-agent broker: membership, routing, delivery
src/preload/     the entire renderer-facing API surface
src/renderer/    the UI — no Node, no filesystem, no network
src/shared/      types shared across the boundary
extension/       the Chrome extension (MV3, load unpacked)
test/            vitest suites
```

`src/main/sandbox.ts` is the security core; every filesystem tool goes through it. The tests in `test/sandbox.test.ts` cover traversal, Windows path tricks and a real NTFS junction escape, and `test/mcp.test.ts` drives the actual MCP endpoint over HTTP in both protocol eras. `test/bridge.test.ts` drives the extension bridge over real HTTP — origins, pairing, tokens, and the routes it must not have — and `test/session.test.ts` and `test/agents.test.ts` cover the store's durability and the agent hierarchy.

The extension has no build step: it is plain ES modules, loaded unpacked. All of its HTTP lives in the service worker, all of its ChatGPT-specific selectors live in `extension/chatgpt-dom.js`, and everything there is written to return nothing rather than throw when ChatGPT's markup moves.

## Building

```sh
npm run dist       # Windows installer in release/
npm run dist:dir   # unpacked build, no installer
```

`npm run dist` regenerates the icons — `scripts/make-icon.mjs` draws the app `.ico` and the extension PNGs from the same code, so both share one mark. The extension PNGs are kept in `extension/icons/` as part of the directly loadable unpacked extension; the build-time `.ico` remains generated under ignored `build/`. The command also downloads and checksum-verifies the current `tunnel-client` release into `resources/tunnel` (`scripts/fetch-tunnel-client.mjs`, cached between builds), builds the three bundles with electron-vite, and packages an NSIS installer with electron-builder. `tunnel-client` is Apache-2.0 and ships with its licence.

## Licence

MIT.
