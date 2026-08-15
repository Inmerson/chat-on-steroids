# ChatGPT Local Files

A small Windows utility that gives ChatGPT access to folders **you** approve, over MCP, from your own PC.

It is only a bridge and a permission manager. It has no chat interface of its own: you keep using ChatGPT, and this app decides what ChatGPT is allowed to touch.

- Approve one or more folders. Nothing outside them is reachable.
- ChatGPT sees short virtual paths like `/project`, never your real Windows paths.
- Optionally let it see the screen and drive the mouse and keyboard.
- Read-only by default. Writing, controlling and running commands are separate opt-ins.
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
- Paths are then canonicalised with `realpath` and re-checked, which is what stops a **symlink, junction or other reparse point** inside an approved folder from reaching outside it. A link that stays inside the folder keeps working.
- Comparisons are case-insensitive on Windows, and a root named `C:\Root` never matches `C:\RootEvil`.
- Network (UNC) paths and whole drives cannot be approved, and roots may not overlap each other.

None of this is left to the model to respect. It is enforced before every operation.

## Tools

`list_roots` is always available so the model can see what exists. On a fresh connection, everything else appears only when you enable it. During one running connector session the exposed tool surface is deliberately monotonic: if you later revoke a permission, an already-exposed tool stays registered but returns `TOOL_DISABLED`. This avoids stale ChatGPT tool caches turning a permission change into an `UNKNOWN` transport failure while still enforcing the live permission on every call.

| Capability | Tools | Notes |
| --- | --- | --- |
| Browse folders | `list_directory` | Optional recursion; skips heavy build folders |
| Search files | `search_files` | By name or by content, with glob filters |
| Read files | `read_file`, `read_files`, `view_image` | Bounded text ranges/batches; PNG/JPEG/GIF/WebP can be returned directly to vision |
| File metadata | `file_info` | Size, timestamps, line count, optional SHA-256 |
| Create files and folders | `create_file`, `create_directory`, `write_binary_file` | Binary writes accept bounded base64; new files require Create permission |
| Edit files | `edit_file`, `write_file`, `append_file`, `write_binary_file` | `edit_file` replaces exact snippets; binary overwrite requires Edit permission |
| Move / rename | `move_path` | Both ends must be inside approved folders |
| Delete files | `delete_file` | Permanent — no Recycle Bin |
| Delete folders | `delete_directory` | Refuses to delete an approved root itself |
| Run PowerShell | `run_powershell` | See the warning below |
| Run executable | `run_command`, `launch_app`, `process`, `open_url` | Direct execution/launch plus managed long-running processes; see the warning below |
| See the screen | `screenshot`, `list_windows`, `get_active_window`, `find_ui`, `wait_for_window` | Screen/window capture plus semantic UI/window discovery |
| Control mouse and keyboard | `computer` | Batched actions with optional `captureAfter`; see the warning below |
| Read clipboard | `read_clipboard` | Text only, capped and separately permissioned |
| Write clipboard | `write_clipboard` | Replaces clipboard text without synthesizing keystrokes |

Output is bounded everywhere. Reads are capped and report which lines you got and where to continue; listings and searches report when they stopped early; searches have a time budget. Ordinary binary files are refused rather than dumped as mojibake, while `view_image` intentionally returns supported local images as native MCP image content for vision.

`edit_file` is the preferred way to change a file. It replaces exact text and fails if the snippet is ambiguous or missing, rather than guessing — which avoids the accidental whole-file rewrites that line-number edits invite. There is intentionally no cross-file `edit_files` transaction yet: ordinary filesystem primitives cannot make unrelated file replacements truly atomic, and a fast batch API is not worth leaving a repository half-written after a crash.

`write_binary_file` can save bytes that ChatGPT actually has as base64, but it does **not** bridge ChatGPT's private image-generation environment into Windows by itself. A generated image is only directly writable when the model is given its bytes or another transferable file representation; the connector cannot manufacture access to an image-generation artifact that ChatGPT does not expose to it.

### Computer use

Two capabilities, off by default and independent of each other.

**See the screen** adds `screenshot`, `list_windows`, `get_active_window`, `find_ui` and `wait_for_window`. `screenshot` captures the main monitor, every monitor, a crop, or one window and returns a PNG in the same coordinate space used by pointer actions. `list_windows` and `get_active_window` expose window state cheaply; `find_ui` uses Windows UI Automation to find semantic controls; `wait_for_window` blocks inside one tool call until a matching window/state appears instead of forcing the model to poll with blind sleeps.

**Control mouse and keyboard** adds one tool, `computer`, which takes a list of actions performed in order: `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`, `focus` and `wait`. Coherent actions can be batched and `captureAfter` can return the next screenshot in the same tool call, avoiding an extra round trip. The vocabulary deliberately matches OpenAI's computer-use tool; coordinates are pixels in the most recent screenshot, so pointing before taking a screenshot is refused rather than guessed at.

Both run through a single PowerShell helper that uses `SendInput` and GDI. Input is synthesised as the ordinary user — it cannot click anything you could not click yourself, and it cannot touch an elevated window.

`control` is a write capability and read-only mode forces it off. `screen` is not, because looking at the screen changes nothing; if you want ChatGPT to look but never touch, leave read-only mode on and enable **See the screen**.

Screenshots capture whatever is on screen, including windows that have nothing to do with the folders you approved. This is the one capability the folder sandbox does not constrain.

### Read-only mode

Read-only mode is on by default. While it is on, every writing, command and control capability is forced off no matter what the individual checkboxes say, and those tools do not appear to ChatGPT at all.

Read tools are marked `readOnlyHint` so ChatGPT does not interrupt you for each one; writing and deleting tools are marked destructive so it asks before running them. Read what it shows you before approving.

### Running commands — please read

`run_powershell` and `run_command` let ChatGPT **execute code on your PC as you**. They are off by default and should stay off unless you actually need them.

When enabled:

- commands run only in an approved folder,
- they run as the ordinary user, with no elevation and without bypassing PowerShell's execution policy,
- output and runtime are capped for synchronous commands, and the process tree is killed on timeout,
- PowerShell scripts are passed with `-EncodedCommand`, so the text never reaches a command-line parser,
- `run_command` starts the executable without interpreting model-supplied shell syntax; Windows `.cmd`/`.bat` shims such as `npm` use a fixed PowerShell launcher with command and argv passed through environment variables,
- `process` uses that same literal-argument path for long-running jobs, keeps bounded in-memory stdout/stderr tails, reports PID/exit status, stops the process tree on request, and cleans up managed jobs when this app quits,
- `launch_app` only confirms that Windows accepted the spawn; it deliberately does not claim the program kept running successfully afterward,
- known credential environment variables are removed from the child process.

That is still arbitrary code execution. Treat it as such.

## Privacy and security

- **Your files stay on your PC.** The app sends nothing anywhere by itself; ChatGPT receives exactly what a tool call returns.
- **The local server binds to `127.0.0.1` only**, never `0.0.0.0`, on a random port. Nothing on your network can reach it.
- Requests must carry a **32-byte secret path token**, regenerated on every app start and compared in constant time. The `Host` and `Origin` headers must be loopback, so a web page cannot drive the endpoint, and oversized bodies are rejected.
- **Credentials are stored with Windows DPAPI** through Electron's `safeStorage`, in a separate file from the settings — never in the JSON config, never in logs, never exposed to the UI process. The API key is passed to the tunnel through the environment, never on a command line.
- **Logs stay in memory**, are capped at 500 entries and are never written to disk. File contents and command output are not logged, and anything shaped like a key or token is masked as a backstop. `CLF_DEBUG=1` echoes the same redacted lines to stderr for troubleshooting.
- The UI runs with context isolation on, Node integration off, the sandbox on and a strict CSP. It has no filesystem or network access of its own and talks to the app through a fixed list of named IPC channels, each validated on arrival. External links are limited to a fixed allowlist of documentation URLs.
- Settings live in a small JSON file in `%APPDATA%\ChatGPT Local Files\`. It is re-validated on load, so a corrupted or hand-edited file cannot widen permissions, and it survives uninstalling and reinstalling the app.
- The endpoint answers **JSON and nothing else**, including for 404s, so a client performing OAuth discovery against it never has to parse a plain-text body. It serves RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource<secret-path>` only — never at the bare well-known root, which would disclose the secret path to an unauthenticated caller.

## Troubleshooting

**"Tunnel unavailable" / it cannot find the tunnel program.** Use **Browse…** under *Setup → Advanced* to point at `tunnel-client.exe` or `cloudflared.exe`.

**"Authentication failed".** The API key or tunnel ID is wrong, the key lacks **Tunnels: Read** and **Use**, or the tunnel belongs to a different workspace than the one you use in ChatGPT.

**"No internet".** This PC cannot reach OpenAI right now — the tunnel program itself is fine and keeps retrying, so the status goes back to *Connected* on its own once the network returns. The status comes from the tunnel's own log, not from a reachability test of ours: nothing is sent anywhere to produce it.

**It says connected but ChatGPT cannot reach it.** The app watches the tunnel's own readiness endpoint every 15 seconds and restarts it with backoff when it stops answering, so a tunnel that dies quietly — after a sleep or a reboot, say — recovers on its own; the **Activity** tab shows the reason it reported. If ChatGPT itself answers `This conversation does not support developer MCPs`, that is ChatGPT-side and no request ever reaches this app (the **Activity** tab stays empty, which is how you can tell them apart): start a new conversation with the connector enabled.

**ChatGPT does not show the new tools.** Permission changes take effect in the app immediately, but an existing ChatGPT conversation can keep an older tool snapshot. Start a new conversation to guarantee the new surface is loaded. The app itself does not need restarting.

**ChatGPT cannot see a file.** Check the folder is approved on **Home**, and that the relevant read capability is on. Build and dependency folders (`node_modules`, `.git`, `dist`, `build`, …) are skipped by searches unless you ask for them explicitly — the model can pass its own exclude list, including an empty one.

**A file comes back truncated.** That is deliberate. Use `startLine`/`endLine`, or follow the resume hint in the response.

**Nothing works and the window is blank.** Run the app from a terminal with `CLF_DEBUG=1` set and check the output, or open the **Activity** tab and press **Copy**.

**Settings vanished after reinstalling.** They should not: everything lives in `%APPDATA%\ChatGPT Local Files\` and the uninstaller is configured to leave it alone.

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
src/main/mcp/      MCP server, tool definitions, server instructions
src/main/tunnel/   connection adapters (OpenAI tunnel, cloudflared, manual)
src/main/computer/ screenshots and input, and the PowerShell helper they drive
src/preload/     the entire renderer-facing API surface
src/renderer/    the UI — no Node, no filesystem, no network
src/shared/      types shared across the boundary
test/            vitest suites
```

`src/main/sandbox.ts` is the security core; every filesystem tool goes through it. The tests in `test/sandbox.test.ts` cover traversal, Windows path tricks and a real NTFS junction escape, and `test/mcp.test.ts` drives the actual MCP endpoint over HTTP in both protocol eras.

## Building

```sh
npm run dist       # Windows installer in release/
npm run dist:dir   # unpacked build, no installer
```

`npm run dist` regenerates the icon (`scripts/make-icon.mjs`), downloads and checksum-verifies the current `tunnel-client` release into `resources/tunnel` (`scripts/fetch-tunnel-client.mjs`, cached between builds), builds the three bundles with electron-vite, and packages an NSIS installer with electron-builder. `tunnel-client` is Apache-2.0 and ships with its licence.

## Licence

MIT.
