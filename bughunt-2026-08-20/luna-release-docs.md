# Luna release/documentation audit — 2026-08-20

Scope: read-only audit for Windows installer release 1.8.6. I inspected the current dirty tree, root `AGENTS.md`, `agent.md`, `README.md`, package/build metadata, live source declarations, tests, and the existing unpacked 1.8.5 installer tree. No production, documentation, test, or version file was edited; this file is the only edit.

## Prioritized findings

### P0 — release markers are still 1.8.5, not 1.8.6

Evidence:

- `package.json:3` is `"version": "1.8.5"`.
- `package-lock.json:3` and `package-lock.json:8` are `1.8.5`.
- `src/main/version.ts:15` exports `APP_VERSION = '1.8.5'`.
- `extension/manifest.json:4` is `1.8.5`.
- `AGENTS.md:49` and `agent.md:98-100` describe the current release as 1.8.5.
- Existing artifacts are only `release/ChatGPT-Local-Files-Setup-1.8.3.exe`, `1.8.4.exe`, and `1.8.5.exe`; no 1.8.6 artifact exists in the inspected tree.

Minimal edit/checklist: update all four version sources plus the two architecture-guide release references to 1.8.6; run a search for `1.8.5` and assert only intentional historical references remain. The current metadata test (`test/extension.test.ts:27-37`) checks package/version.ts/manifest and protocol, but does **not** check either package-lock marker; add or run an explicit lockfile assertion before packaging. Verify `npm ci`/lock consistency and that the installer artifact name is `ChatGPT-Local-Files-Setup-1.8.6.exe`.

### P1 — README pairing instructions describe a removed six-digit flow

Evidence:

- `README.md:158-163` instructs the user to press Pair, receive a six-digit code, and type it in the extension popup; `README.md:220` repeats “code-gated /pair” and six-digit pairing.
- Current source says the opposite: `AGENTS.md:66,244`, `agent.md:117,528-535`, and `src/main/bridge.ts:575-600` implement silent local `/pair` bearer-token provisioning. `extension/background.js:559-583` documents the old code as removed and calls `/pair` itself.
- The current popup has no code input (`extension/popup.html`/`popup.js`); this README path is not merely imprecise, it sends an installer user to a nonexistent step.

Minimal edit/checklist: rewrite README installation/privacy text to “enable recording or multi-agent, load the installed extension folder, open the popup, and pair”; explain the app’s **Disconnect browser** / re-pair action. Remove all six-digit/code-gated wording and add a release smoke check that the installed extension popup can pair with `/hello` + `/pair`.

### P1 — README worker default conflicts with the live config

Evidence:

- `README.md:212` says “three by default, eight maximum”.
- `src/main/config.ts:86` sets `{ enabled: false, maxWorkers: 2 }`; validation at `src/main/config.ts:191-192` allows 1–8. `AGENTS.md:57` and `agent.md:593` describe the default as 2.

Minimal edit/checklist: change README to two by default/eight maximum and state that multi-agent is off by default. Verify the settings UI and spawn rejection/error text still use the same bound.

### P1 — tool-count/status copy is objectively wrong and user-visible

Evidence:

- `src/main/mcp/surfaces.ts:95-111` declares 8 possible Core names, but explicitly says at most 7 live because `find` and `exec_command`/`write_stdin` are mutually exclusive; Desktop can add `observe` + `computer` (`:124-136`).
- `src/main/connection.ts:120-134` computes the live per-surface list and includes `view_image`.
- `src/renderer/main.ts:42-48` says “Six on Core and two on Desktop” and hard-codes `MAX_TOOL_COUNT = 8`; `:767-770` renders that stale denominator. This omits `view_image` from the stated Core count and cannot represent 9 across both surfaces.
- `agent.md:120` and `AGENTS.md:68` already acknowledge the mismatch, so the guides currently teach a known stale UI fact rather than routing to a fix.

Minimal edit/checklist: derive the UI denominator from the actual surface/tool declarations or display separate Core/Desktop counts; make `view_image` appear in the list. Add a renderer/status regression covering read-only/search/command combinations and desktop-enabled state. Verify `tools/list` and the status card agree after a deliberate reconnect, since `src/main/mcp/server.ts:211-233` freezes/forgets discovery shape at connection boundaries.

### P1 — reconnect/new-chat semantics need one canonical user-facing explanation

Evidence:

- `src/main/mcp/server.ts:211-233` says changing mutually exclusive discovery or disabling feature tools requires a connector reconnect so ChatGPT re-reads schemas; `src/renderer/main.ts:333-339` tells users to reconnect and start a new chat when multi-agent is disabled or tools change.
- `agent.md:256` describes deliberate reconnect/surface reset, but README only mentions reconnect incidentally and still frames pairing as the obsolete code workflow (`README.md:160-163,220`).
- `AGENTS.md:49,66,68` mixes release facts, known stale UI count, and pairing correction without a direct operational route for “tool list is stale”.

Minimal edit/checklist: document the exact sequence: save capability change → reconnect/reload the connector in ChatGPT → start a new chat when prompted; distinguish this from browser extension reload/re-pair. Add a troubleshooting row for “agents/view_image/tool count is stale”. Verify both disabling and re-enabling multi-agent, plus `find`↔exec changes, against a fresh MCP connection.

### P1 — missing symptom routing for reload, Unattributed, and Overwrite in the user-facing README

Evidence:

- README has only broad extension prose (`README.md:152`) and a generic relabelling paragraph (`:247`); it lacks source/test routing for the important failure clusters.
- The architecture guides have the needed routing: `AGENTS.md:295-303` maps Unattributed, Overwrite, and reload/update to correlation/recorder/extension files and tests; `agent.md:312-318,459-470,720` gives symptoms and first owners.
- Current implementation has dedicated regression coverage in dirty-tree `test/correlation.test.ts`, `test/content-script.test.ts`, `test/extension.test.ts`, `test/bridge.test.ts`, plus new dirty `test/renderer-state.test.ts`; release docs should not imply a generic re-pair fixes identity or stale Overwrite rendering.

Minimal edit/checklist: add concise troubleshooting entries: (a) reload is not a close; inspect service-worker journal/document epoch and `restoreOpenChatgptTabs`; (b) Unattributed means exact request-id proof is missing—inspect `inbound.ts` → correlation → Fiber/content/background/bridge/recorder and do not guess; (c) Overwrite is all-or-nothing and depends on exact activity/turn matching—inspect `/activity`, content stream matching, and Fiber. Run targeted tests plus a live reload/worker/Overwrite smoke test where possible.

### P1 — package/build changes add native `sharp` without an explicit packaging contract

Evidence:

- Dirty `package.json:24-25` adds `sharp: 0.35.3`; `package-lock.json` adds its platform packages and native dependency tree.
- `src/main/codex/view-image.ts:25,121` imports and invokes `sharp` for image decoding.
- `electron-builder.yml:37-46` calls `node-pty` the one native module and only unpacks `node-pty`; `npmRebuild: false` is set at `:40`, with no explicit `sharp`/`@img` unpack rule.
- The existing `release/win-unpacked/resources/app.asar.unpacked/node-pty` is present, but no `sharp` directory was found there; that 1.8.5 tree therefore does not prove the new dependency is packaged or runnable. The current installed artifact is pre-1.8.6 and cannot validate the new image path.

Minimal edit/checklist: make an intentional decision for `sharp` packaging (native `.node`/libvips files must be present and loadable in the packaged Electron runtime), then verify with a fresh `npm run dist:dir`, `asar list`/unpacked-resource inspection, and a packaged `view_image` call on a known in-root image. Do not accept a successful NSIS build as proof. Also run `npm ci` on the Windows release environment with the exact lockfile and confirm Electron ABI/runtime loading under the packaged app.

### P2 — installer resource checks are documented but not yet release evidence for 1.8.6

Evidence:

- `electron-builder.yml:9-34` ships only `out/**` + `package.json` in asar and copies `resources/tunnel`, `extension`, and `resources/rg` as extra resources; `:45-46` unpacks node-pty.
- `src/main/extension-path.ts:23-34`, `src/main/tunnel/locate.ts:85-90`, and `src/main/ripgrep.ts:24-31` resolve those packaged paths correctly in principle.
- Existing `release/win-unpacked` contains `resources/extension/manifest.json`, `resources/rg/rg.exe`, `resources/tunnel/tunnel-client.exe`, and `app.asar.unpacked/node-pty`, but this is only an old 1.8.5 unpacked tree. No 1.8.6 build/install proof is present.

Minimal verification checklist: after `npm run dist:dir`, assert the four paths above and inspect `resources/app.asar`/`app.asar.unpacked`; install the 1.8.6 NSIS artifact per-user without elevation, launch it, open the extension folder through the UI, exercise `rg`, tunnel startup, terminal spawn, and image decoding. Preserve `%APPDATA%\\chatgpt-local-files` across update/uninstall checks. Record installer hash, version, and exact installed paths.

### P2 — build scripts are network/latest-release dependent and mutate resource trees

Evidence:

- `package.json:12-13` makes `dist`/`dist:dir` run `npm run tunnel` and `npm run rg` before building.
- `scripts/fetch-tunnel-client.mjs:37-53` fetches the latest GitHub release unless a tag is passed; `scripts/fetch-ripgrep.mjs:34-50` does the same for ripgrep. Both mutate `resources/*` and cache under `node_modules/.cache`.
- `README.md:290` says latest/current release and cached downloads, but does not define a pinned release-input/reproducibility check for 1.8.6.

Minimal edit/checklist: record the exact tunnel/ripgrep versions and checksums in the release evidence; build with explicit tags or verify the checked-in `VERSION` files are the intended release inputs. Ensure the release worker has network access and that a failed download cannot leave a partially replaced resource directory. This is a reproducibility/release process risk, not a reason to alter production code during this audit.

## Suggested minimal release order

1. Update 1.8.6 in `package.json`, `package-lock.json` (both markers), `src/main/version.ts`, `extension/manifest.json`, and the two architecture-guide release references; search for stale 1.8.5.
2. Correct README pairing, worker-default, and reconnect/new-chat wording; add concise reload/Unattributed/Overwrite routing.
3. Fix/derive renderer tool counts and add the smallest status regression; ensure `view_image` is represented.
4. Resolve and verify packaged `sharp` native runtime behavior before calling the installer releasable.
5. Run `npm ci`; `npm run typecheck`; targeted `npm test -- --run test/extension.test.ts test/bridge.test.ts test/correlation.test.ts test/content-script.test.ts test/mcp.test.ts test/renderer-state.test.ts`; then `npm run verify`.
6. Build `npm run dist:dir` and `npm run dist`; inspect artifact version/resources and run the installed-app smoke checks listed above. Keep source/static, test, build, install, and live browser proof as separate evidence.

## Non-findings / consistency confirmed

- `package.json`, `package-lock.json`, `src/main/version.ts`, and `extension/manifest.json` are internally synchronized at 1.8.5 today; the problem is target 1.8.6 not yet applied, plus no lockfile assertion in the current release metadata test.
- `BRIDGE_PROTOCOL = 5` is consistently declared in `src/main/version.ts:25`, bridge responses, and `test/extension.test.ts:35-36`; do not bump it merely for the app version bump.
- `electron-builder.yml` correctly preserves per-user/no-elevation install and `%APPDATA%` state (`:52-71`); verify it in the built installer rather than changing it based on documentation alone.
