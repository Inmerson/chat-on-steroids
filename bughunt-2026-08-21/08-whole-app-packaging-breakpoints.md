# Whole-app and packaging breakpoints — 2026-08-21

Scope: source/architecture audit of startup/config migration and secrets, native/runtime
loading, packaged resources, extension upgrade compatibility, diagnostics, desktop helper
ownership, logging, and install/upgrade state. I read `AGENTS.md` and
`bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md`. No installer was created,
no installed state was changed, and no AppData/config mutation was performed. The existing
tree is shared and dirty; this report is based on the current files, not on unrelated
worktree changes.

## Findings

### 1. Diagnostics can report “Every check passed” while a required check is unknown

**Classification: confirmed current bug — diagnostics accuracy, P1/P2.**

`src/main/diagnostics.ts:319-323` only puts checks with `ok === false` into `broken`.
The summary therefore says `Every check passed.` when every check is either `true` *or*
`null`. That is reachable by design: `developerMode()` returns `ok: null` when ChatGPT has
not called a tool (`src/main/diagnostics.ts:195-218`), and the tunnel route check returns
`ok: null` while metrics are unavailable or still starting (`src/main/diagnostics.ts:93-115`).
The renderer displays that summary verbatim (`src/renderer/main.ts:1048-1052`), so a fresh,
unverified setup is presented as fully verified.

There is a second source-level mismatch in the same diagnostic: the Permissions check only
accepts roots, `screen`, or `control` (`src/main/diagnostics.ts:228-238`), while the live
Desktop surface deliberately treats `clipboardRead`/`clipboardWrite` as sufficient
(`src/main/mcp/surfaces.ts:158-167`, `src/main/connection.ts:178-185`). A clipboard-only
configuration can be connectable and useful but still reports a failed Permissions check.

Focused direction: make the summary tri-state (`failed`, `unverified`, `passed`) and name
unknown checks explicitly; derive the permission verdict from the same `surfaceIsUseful()`
projection used by connection. Add a UI-level check for “no request yet” and clipboard-only
configuration, not only unit assertions on individual check objects.

### 2. Desktop PowerShell helper has no application-owned shutdown path

**Classification: confirmed current lifecycle gap with production leak risk — P1/P2.**

The desktop automation helper is a long-lived child stored in module globals
(`src/main/computer/index.ts:123-133`) and started by `startHelper()`
(`src/main/computer/index.ts:144-240`). A request timeout clears the module's pointer and
calls `runtime.child.kill()` (`src/main/computer/index.ts:242-260`) without awaiting process
close, terminating the process tree, or preventing a replacement helper from being started
while the old one is still winding down.

More importantly, the only main-process quit sequence awaits MCP/tunnel disconnect,
`unifiedExecManager.terminateAllProcesses()`, and `stopBridge()`
(`src/main/index.ts:264-276`). It never stops or awaits the desktop helper. Because the
helper is a separately spawned `powershell.exe` (`src/main/computer/index.ts:148-168`), app
shutdown does not have a deterministic ownership/termination proof; a stuck helper can
survive quit and a timeout/restart can accumulate processes.

Focused direction: export a single `stopComputerHelper()` owned by the main shutdown chain;
cancel queued/pending requests, terminate the process tree with the same absolute Windows
helper used by tunnel/exec cleanup, and await `close` (with a bounded fallback). On timeout,
mark the generation dead but keep the close promise until the old child is gone before a new
helper is admitted. Validate with a temporary helper invocation followed by app quit and a
PID/command-line check; this must not be inferred from unit tests that mock `ChildProcess`.

### 3. Config migrations and invalid-config reset are not persisted

**Classification: confirmed current upgrade-state bug — P2.**

`loadConfig()` parses `config.json`, applies capability migration, token/default migration,
reserved-root filtering, and invalid-file fallback only to the in-memory `current` object
(`src/main/config.ts:225-249`). It never calls `persistConfig()` on either the migrated
success path or the invalid-file path. `persistConfig()` exists only behind explicit UI
mutations (`src/main/config.ts:317-345`). Consequently:

* the comments promising a one-time default move are not true on disk: every launch repeats
  the same migration against the old file;
* a duplicate/reserved root or dropped legacy capability is silently reintroduced from disk
  on the next launch and normalized again; and
* a malformed/corrupt file is logged as “reset to defaults” but left in place, so every
  launch repeats the error and discards the user's file without a quarantine/backup.

The existing config tests demonstrate the blind spot: they write old files and assert the
returned object (`test/config.test.ts:44-79`, `82-90`, `130-143`) but do not reload and
compare the raw file after migration. This is an upgrade/restart failure, not a routine
typecheck/test failure.

Focused direction: have `loadConfig()` track `changed` and atomically persist a validated
migration before publishing it, with a recoverable `.bak`/quarantine for invalid JSON or
schema. Preserve user-selected values and make the migration idempotent. Validate two
separate launches against a temporary user-data directory, including a corrupt file and a
legacy capability/default file, and assert the second launch reads the normalized file.

### 4. The packaged-runtime gate does not verify all production resources or native users

**Classification: packaging risk / unknown for future artifacts; current unpacked artifact
was positive, not a confirmed missing-file bug.**

The main/preload build externalizes dependencies (`electron.vite.config.ts:1-20`), while
the builder ships only `out/**` and `package.json` in the asar and relies on three
`extraResources` trees (`electron-builder.yml:10-35`). It explicitly unpacks node-pty,
Sharp, and `@img` (`electron-builder.yml:37-47`), but the application also loads native
Tree-sitter grammars; those packages are not named in `asarUnpack`. Electron-builder's
current native handling happened to leave their Win32 prebuilds unpacked, but that behavior
is not asserted by the config or by the smoke gate.

The checked-in smoke script only requires Sharp, node-pty, and asar `package.json`
(`scripts/smoke-packaged-runtime.mjs:8-22`). It does not inspect `resources/extension`,
`resources/tunnel/tunnel-client.exe`, `resources/rg/rg.exe`, extension/app/protocol version
coupling, Tree-sitter parsing, or actual main-process startup with a temporary user-data
directory. A package can therefore pass this gate while a release-only extension, tunnel,
search, or parser path is absent/broken.

Observed evidence from the existing `release/win-unpacked` (read-only probes; no installer
run):

```text
node scripts/smoke-packaged-runtime.mjs release/win-unpacked
{"version":"1.8.7","sharp":"0.35.3","libvips":"8.18.3","pngBytes":95,"ptySpawn":"function"}

Tree-sitter parse probe:
{"parser":"function","language":"object","root":"program"}

Resource/native existence probe:
{"extension/manifest.json":true,"tunnel/tunnel-client.exe":true,"rg/rg.exe":true,
 "app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty.node":true,
 "app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node":true,
 "app.asar.unpacked/node_modules/tree-sitter/prebuilds/win32-x64/tree-sitter.node":true,
 "app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/win32-x64/tree-sitter-bash.node":true}
```

Focused direction: make a release smoke gate enumerate every `extraResources` executable and
manifest, require the native modules actually imported by production, parse one Bash tree,
and verify app/extension/bridge versions from the packaged files. Explicitly unpack
Tree-sitter (or document and assert the builder's auto-unpack contract). Start the packaged
main entry with isolated temporary user data and assert extension-path and bundled binary
resolution before allowing an installer artifact to ship.

### 5. Extension protocol mismatch is warning-only, so stale manually loaded extensions can
appear connected while routes are incompatible

**Classification: source-confirmed upgrade compatibility risk; exact Chrome update/reload
behavior remains an external validation unknown — P2.**

The extension hardcodes bridge protocol 5 and sends it on requests
(`extension/background.js:23-26`, `497-505`). The app receives it in
`noteExtensionVersion()` and, on mismatch, only logs one warning
(`src/main/bridge.ts:329-350`). `handle()` calls that function and then continues routing
the request (`src/main/bridge.ts:575-590`); there is no compatibility response, negotiated
schema, or status field exposed to the extension popup. The popup only distinguishes app-not
found/not-paired/connected (`extension/popup.js:16-18`, `39-64`). The app's own comment
acknowledges the failure mode: an extension “connects, pairs, and then some routes quietly
do nothing” (`src/main/bridge.ts:330-334`).

The current recovery code correctly repairs dead content/Fiber contexts after extension
reload (`extension/background.js:1157-1228`), so this does not repeat the consolidated
Fiber-repair findings. It also does not solve a stale extension whose request/response shape
changed across an app upgrade. Since the extension is shipped as a manually loaded unpacked
folder (`electron-builder.yml:17-21`), NSIS upgrade cannot update Chrome's registered copy;
the user can remain on the old protocol while the app reports only a log warning.

Focused direction: return a machine-readable compatibility result from `/hello`, surface it
in the popup/setup UI, and fail closed on incompatible authenticated routes (or implement a
versioned adapter with explicit tests). Validate app-upgrade plus already-open ChatGPT tabs
using old and new extension folders: stale versions must be visibly “incompatible” and must
not partially acknowledge/drop journal, activity, compact, or command messages.

## Reviewed areas with no additional promoted current defect

* The current unpacked artifact loaded Sharp, node-pty, and Tree-sitter successfully; this
  is evidence for that artifact only and not a substitute for the missing package gate.
* `src/main/logger.ts:1-42` keeps operational logs in RAM, caps them, and applies agent/key/
  token scrubbing before UI or debug-console output. No new concrete redaction failure was
  promoted here; model-facing/durable redaction findings remain deduplicated to the
  consolidated report.
* `src/main/secrets.ts` uses Electron `safeStorage` and the encrypted secret blob; no new
  plaintext-secret path was found. Corrupt-secret recovery is intentionally fail-closed and
  should be covered in an install/reinstall probe, but is not reported as a confirmed bug.
* `electron-builder.yml:56-75` remains per-user/asInvoker and explicitly preserves AppData
  on uninstall. No installer was run, so rollback, upgrade-in-place, and uninstall behavior
  remain validation unknowns rather than claimed proof.
* Consolidated findings whose current source is already repaired (notably the bridge startup
  serialization and extension Fiber/content recovery) were not repeated.

## Priority validation sequence

1. Add diagnostics tri-state/clipboard assertions and exercise the renderer summary with
   null checks.
2. Add helper stop ownership, then run a real packaged desktop-action/quit PID probe.
3. Persist and reload migrations in a temporary user-data directory, including corruption.
4. Extend packaged smoke to all resource/native/version/startup paths; run it on a clean
   `dist:dir` artifact, without creating an installer.
5. Exercise old/new extension protocol against the bridge and verify the user-visible
   incompatible state plus lossless journal/command behavior.
