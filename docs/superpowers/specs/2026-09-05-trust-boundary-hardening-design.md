# Chat On Steroids Trust Boundary Hardening Design

## Purpose

Harden the authority boundary of the current `origin/main` / 2.1.2 codebase before adding new DesktopCommander-inspired features. This tranche is deliberately narrow: reduce fresh-install authority, make terminal scope unambiguous, prevent durable session logs from retaining common credential fields, and make the Windows updater deterministically choose the current-user installer mode that was proven to work on this machine.

## Non-goals

- Do not add a command blocklist or claim that `exec_command` is sandboxed by approved folders.
- Do not add URL fetching to local file tools.
- Do not add Remote Desktop Commander or another cloud-device relay.
- Do not redesign the MCP tool surface.
- Do not add session encryption-at-rest in this tranche; that is P1 after recursive redaction is established.
- Do not invent an agent-health engine on `origin/main`. The exact-conversation health engine exists only in separate WIP work; its invariant is recorded below and must be applied when that subsystem lands.
- Do not merge, push, publish, install over the live app, or mutate the user's dirty primary checkout.

## Baseline

Isolated worktree:

`C:\Users\exprt\Project Inmersion\Tools\chat-on-steroids-sync\.worktrees\trust-boundary-hardening-20260905`

Branch:

`feat/trust-boundary-hardening-20260905`

Base commit:

`4b70f3d09ac5a0ee951943d4130b04674ec10ede`

Baseline validation before implementation:

- `npm run typecheck` — pass.
- `npm test -- --run` — 92 files passed, 2041 tests passed, 18 skipped.

## Design decisions

### 1. Fresh installs are Restricted by default

`DEFAULT_CAPABILITIES` in `src/shared/types.ts` is already the correct conservative capability set: browse/search/read/metadata are enabled, while create/edit/move/delete/command/Desktop/clipboard mutation authority is disabled. `defaultConfig()` currently overrides that safe constant by enabling nearly every portable capability, sets `readOnly: false`, and enables multi-agent mode.

A genuinely missing config must instead use the conservative capability set, `readOnly: true`, and `multiAgent.enabled: false`. Session recording remains enabled because the current product's session/compaction architecture depends on it and it is not an OS mutation authority. Existing configs keep their explicit choices; migration must not narrow or widen an already-persisted user decision merely because the shipped default changes.

No new `profile` field is added in this tranche. The security property is the default itself; a future UX may name profiles without changing this invariant.

### 2. Approved folders are a file-tool boundary, not a terminal boundary

The per-capability copy already correctly says `Run anything as you. NOT limited to approved folders.` The setup wizard currently contradicts that with `Nothing outside the folders you approve is reachable.`

The wizard must instead say that file tools are confined to approved folders and that terminal commands, when enabled, run as the OS user and are not confined by those folders. This is disclosure of the real authority model, not a new warning modal or a command parser.

### 3. Durable tool-call arguments receive centralized recursive secret redaction

The recorder already recursively redacts a small exact-key set and separately strips clipboard payloads. Move that policy into a focused `src/main/session/redaction.ts` module and broaden the case-insensitive credential-key set to include:

- `authorization`
- `token`
- `access_token`
- `refresh_token`
- `password`
- `passwd`
- `api_key`
- `apikey`
- `secret`
- `cookie`
- `set-cookie`
- `client_secret`

The sanitizer must recurse through nested objects and arrays, preserve non-secret diagnostic metadata, and retain the existing special handling for `computer` clipboard actions. Redaction is key-based: it must not scan arbitrary prose for token-looking strings, because session history intentionally contains user/model content and broad content heuristics would destroy useful recovery data.

### 4. Windows updater always requests current-user install mode

The production incident established that an old machine-wide installation can make electron-builder's assisted NSIS installer select `C:\Program Files\Chat On Steroids`, even though the project is configured `perMachine: false`. The updater runs non-elevated; the custom ACL grant then fails against Program Files and NSIS aborts.

The proven safe handoff is the supported NSIS switch `/currentuser`. Every Windows staged-update launch must therefore include `/currentuser` alongside `/S`. User-requested relaunch behavior (`--force-run`) remains unchanged.

### 5. Correct NSIS quoting for the ACL helper

NSIS does not use backslash escaping for the quoted command string in the way the current script assumes. The currently shipped line:

`ExecWait '\"$SYSDIR\icacls.exe\" \"$INSTDIR\" /grant \"*S-1-15-2-2:(OI)(CI)(RX)\" /Q' $0`

must become:

`ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q' $0`

The existing fail-closed `${Errors}` / nonzero exit checks remain in place.

### 6. Agent-health invariant is gated, not implemented here

`origin/main` at the baseline commit has no `src/main/agent-health.ts` and no `bridgeHealthEvidenceForAgent`. Therefore this tranche must not add unused health code merely to satisfy a roadmap item.

When the agent-health subsystem is merged, the required invariant is:

> Global browser-extension presence is never sufficient evidence that a specific worker conversation is healthy. Missing exact conversation/session evidence must remain missing/degraded even if another ChatGPT tab is active.

The landing change must include a regression case equivalent to `exact worker conversation absent + unrelated browser present => not healthy`.

## Verification requirements

Each behavior change follows test-first RED → GREEN. After all tasks:

- `npm run typecheck`
- focused changed suites
- `npm test -- --run`
- `git diff --check`
- inspect `git status --short --branch`

No success claim is made from a test that was already green before the corresponding production change.
