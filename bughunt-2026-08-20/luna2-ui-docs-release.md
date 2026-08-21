# 1.8.6 release-facing truth audit

Read-only audit of the current dirty tree on 2026-08-20. Only this report was written. The
source/tests are ahead of several older reports, so the current implementation and current
tests are the authority.

## Current truth confirmed

- `package.json:3`, `package-lock.json:3,9`, `src/main/version.ts:15`, and
  `extension/manifest.json:4` all say **1.8.6**. `BRIDGE_PROTOCOL` remains **5**. The current
  `test/extension.test.ts:27-43` checks both lockfile markers as well as the package, app,
  extension, and protocol; do not add a protocol bump just for the app version.
- Live surface code is already corrected: `src/main/mcp/surfaces.ts:95-111` declares eight
  possible Core names, with `find` mutually exclusive with `exec_command`/`write_stdin`, so at
  most **7 Core** schemas are live; Desktop adds at most **2**. `connection.ts:119-135` includes
  `view_image`, `renderer/main.ts:42-48` uses **9** as the combined status denominator, and
  `test/mcp.test.ts:566-570,724-742` pins the result.
- New-config defaults are recording **on**, advisory/urgent estimates **300k/400k**, automatic
  compaction **on at 300k** (edge-triggered), and multi-agent **off** with **2** workers by
  default and a hard **8** (`src/main/config.ts:58-86,161-195`; `test/config.test.ts:117-123,202-211`).
  Existing explicit config choices are preserved.
- Pairing is now silent local `/pair` bearer provisioning: `src/main/bridge.ts:575-600`,
  `extension/background.js:559-583`, and the popup have no code field. The edited README
  installation/privacy text (`README.md:158-163,220`) and worker limit (`:212`) are correct;
  retain those corrections.
- The edited README now has useful reload, Unattributed, and Overwrite entries
  (`README.md:247-253`). The implementation has the corresponding Fiber/content recovery and
  fail-closed rendering paths. These entries should be refined, not replaced with a generic
  “re-pair and retry” promise.

## Ranked corrections

### P0 — the current root manifest cannot run the documented build or verification

`package.json:1-17` contains no `scripts` and no `devDependencies`, while the lockfile root
(`package-lock.json:20-29`) still contains the development dependency set. `npm.cmd run verify`
currently fails with `Missing script: "verify"`; README’s development/build commands
(`README.md:259-296`) therefore cannot be executed from this checkout. This is also dangerous
for a release worker: the root manifest was changed while the lock still describes a different
project shape.

Target `package.json` top-level `scripts`, `dependencies`, and `devDependencies`, and the
`package-lock.json` root package. Restore the build/test contract (or provide a separate,
explicitly generated production manifest without breaking the repository root), then prove
`npm ci`, `npm run typecheck`, `npm run verify`, and `npm run dist:dir`. Keep `sharp: 0.35.3` as
a runtime dependency because `src/main/codex/view-image.ts` imports it; the current
`electron-builder.yml:37-46` unpack rules for `sharp`/`@img` are a good packaging direction but
still need a fresh artifact check.

### P1 — there is no 1.8.6 installer or packaged-runtime proof

`release/` contains 1.8.3, 1.8.4, and 1.8.5 installers/unpacked output, but no
`ChatGPT-Local-Files-Setup-1.8.6.exe`. The existing `release/win-unpacked` is the old 1.8.5
tree and cannot prove the new `view_image`/`sharp` path, extension version, tunnel, ripgrep, or
node-pty packaging.

Target the release procedure/build evidence rather than changing version constants again:
after restoring the manifest, build `dist:dir` and NSIS 1.8.6, inspect `resources/extension`,
`resources/tunnel`, `resources/rg`, and `app.asar.unpacked` (including Sharp native files), then
exercise a packaged `view_image` call on an approved image. Record installer version/hash and
keep source/static checks, tests, build, install, and live browser proof separate.

### P1 — README tool count and `view_image` table are stale

`README.md:66-90` still says “at most six Core tools” and has no separate `view_image` row.
That contradicts the live declarations/tests above and makes the status card’s `9` look wrong.
Update this section in place to say: Core declares eight possible names but exposes at most
seven live (the `find`/exec pair is exclusive), Desktop exposes at most two, and nine is the
combined maximum. Add a `view_image` row describing its separate Codex-shaped image contract;
keep the fact that `read` may also return supported images.

The known-fixed source mismatch is still falsely documented in `AGENTS.md:68` and
`agent.md:120`. Replace those paragraphs with the current 7+2/9 status fact rather than
appending another caveat. Replace in place to keep the root `AGENTS.md` under its stated 32 KiB
budget.

### P1 — recording/compaction defaults in README and privacy copy are wrong

`README.md:144`, `:182`, and `:223` still say recording is off and compaction advises at
180k/200k. The source/tests say new configs record on, estimate 300k/400k, and automatically
compact on the 300k edge. Update both the session-history and privacy sections, explicitly
qualifying that an existing config’s explicit choice is preserved. The extension-install step
(`README.md:158`) should say to turn recording on only when the user has left it off, while
noting that the bridge also runs for enabled multi-agent mode.

`src/renderer/index.html:467-474` has the same nuance bug: it says turning recording off
disconnects the extension even though multi-agent mode can keep the bridge alive. Correct that
visible settings hint together with the README, or state the conditional precisely.

### P1 — worker recovery-key wording points users to a place where no key exists

The actual UI exposes a key icon only for a live unbound worker and copies the one-time key to
the clipboard (`src/renderer/chat.ts:731-739,930-945`). The plaintext is deliberately scrubbed
from logs/session data (`test/bridge.test.ts:616-681`). Nevertheless, the model-facing schema
and errors say “from the app log”:

- `src/main/agents.ts:51-58,113-120,639-644`;
- `src/main/mcp/tools-core.ts:944,963-970`.

Change those descriptions to the actual route: click the unbound worker’s recovery-key button
in the Chat/Swarm UI, paste the copied one-time key into that worker chat as `join_key`, and use
`join` only for a binding that never arrived. Align `README.md:197-212` with this exact UI (the
current “explicit click in the desktop window” wording is less actionable) and change the
troubleshooting phrase `README.md:255` from “not paired” to “not connected/unavailable.”

### P1/P2 — publish the worker prompt/delegation contract, including the user’s preferred style

The live contract is already strong in `src/main/mcp/instructions.ts:92-105`,
`src/main/mcp/tools-core.ts:938-970`, `src/main/bridge.ts:1728-1742`, `AGENTS.md:379-385`, and
`agent.md:950-958`: a task must stand alone from its first sentence; include project/location,
objective, relevant files/facts, constraints and allowed edits, validation, and expected
handoff; preserve exact user constraints; send short phase-level progress and meaningful
findings/decisions/blockers; do not poll; workers message only prime and `finish` is terminal.
Mirror that checklist in the user-facing multi-agent section (`README.md:197-212`) so a user
understands why a worker does not inherit the prime transcript. Keep audit write boundaries
explicit when applicable: source/tests/AppData/config remain read-only and only the named
report may be created.

Small source polish: `src/main/mcp/instructions.ts:99-100` literally renders
`?you have zero prior context?`; use ordinary quoting/backticks. This is presentation, but it
undermines the otherwise clear prompt contract.

### P2 — mark old design/audit material as historical snapshots or refresh current summaries

Do not silently treat these as current release truth:

- `docs/tool-surface.md:6-10,91-102,123-133,299-303,612-644` says 1.7.1, six Core tools,
  folds `view_image` into `read`, and includes the retired `session save_handoff` action. Keep
  the decision history, but add a prominent snapshot/superseded banner and point current readers
  to `surfaces.ts`/`tools-core.ts`.
- `TOOL_USABILITY_AUDIT.md:1-18,22-30` calls the surface eight tools and says native Windows
  paths fail; those claims predate the current separate `view_image` and native-path changes.
  Label the report with its 2026-08-17 snapshot scope or refresh its scorecard.
- `TODO.md:12-18` records the installed 1.8.4 build. Leave the historical release block intact,
  but add a new 1.8.6 release/evidence block after the actual build/install.
- `bughunt-2026-08-20/luna-release-docs.md:7-18,39-79` reports 1.8.5 markers, missing Sharp
  unpack rules, and stale count/pairing code that are no longer the current tree. Preserve it as
  an audit snapshot, but add a superseded-by-current-tree note; do not copy its old checklist
  into release docs. The timestamped consolidated report and worker reports likewise describe
  earlier states and should be read as evidence, not current implementation claims.

## Release handoff checklist

1. Restore/synchronize the root manifest and lock, then run the documented verify/build commands.
2. Update README current sections and replace the two stale architecture-guide count notes without
   expanding root `AGENTS.md`.
3. Correct recovery-key error/schema wording and mirror the self-contained worker contract.
4. Build and inspect/install 1.8.6; verify Sharp/view_image and all shipped resources.
5. Search for stale current claims (`six Core`, `180k/200k`, recording off, `save_handoff`,
   “from the app log”, 1.8.5/1.8.4) while retaining clearly marked historical evidence.
