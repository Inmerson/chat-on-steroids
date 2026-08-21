# 1.8.8 implementation and release record

Started: 2026-08-21  
Starting revision: `f7388750fb975f366b7c99994557a444ceba84ac` (`main`)  
Source backlog: `00-2026-08-21-CONSOLIDATED-VERIFIED-BUGHUNT.md`

## Working boundary

- The repository was already heavily dirty when this pass began. Existing changes are user/shared work and must be preserved.
- No reset, checkout, clean, broad reformat, or unrelated overwrite is permitted.
- Fixes target V-01 through V-19. Items explicitly classified as risk-only in the consolidated report are not silently promoted into release scope.
- Version changes and packaging happen only after subsystem integration and verification.

## Implementation streams

| Stream | Findings | Primary ownership |
| --- | --- | --- |
| Extension document | V-01, V-02, V-03 content side | `content.js`, `fiber.js`, `chatgpt-dom.js` |
| Extension worker | V-03 background side, V-09, V-16 | `background.js` |
| Bridge and agents | V-03 app side, V-10, V-11, V-12, V-18 | `bridge.ts`, `agents.ts` |
| Codex tools | V-04, V-05, V-14, V-15 | read/search/patch/unified exec |
| Sessions | V-07, V-13, V-17 | session store/recorder/continuation |
| Renderer | V-08, renderer side of V-19 | timeline and diagnostic presentation |
| Electron lifecycle | V-06 | shutdown, MCP drain, tunnel/helper ownership |
| Operations/package | main side of V-19 and package smoke | diagnostics, config persistence, package validation |

## Integration checklist

- [x] Every changed cross-process payload is implemented on producer and consumer.
- [x] Every V-01 through V-19 finding has a root-cause implementation recorded below.
- [x] Focused bridge and extension suites passed during the implementation pass.
- [ ] `npm run verify` passes after the final integrated edits (execution approval blocked; see verification record).
- [ ] `npm run build` passes (execution approval blocked; see verification record).
- [x] `package.json`, lockfile, `src/main/version.ts`, and `extension/manifest.json` agree on `1.8.8`.
- [ ] NSIS package completes.
- [ ] Packaged runtime smoke verifies version, extension, tunnel, ripgrep, node-pty, Sharp, and declared runtime resources.
- [ ] Final artifact paths and hashes are recorded below.

## Completed changes

| Finding | Implemented root-cause change |
| --- | --- |
| V-01 | Raised transcript mutation cadence from 50 ms to 250 ms, added adaptive activity polling, bounded Fiber construction before `postMessage`, changed Fiber membership paths to sets/maps, and replaced quadratic DOM nested-row filtering with ancestor walks. |
| V-02 | Added an 8 MiB aggregate page queue budget, UTF-8 wire budgeting, stable-id coalescing for streaming assistant snapshots, byte accounting, and explicit gap records for dropped observations. |
| V-03 | Added persisted per-tab navigation epochs; every content-to-worker request carries the epoch, stale document/epoch work is rejected, and compaction/command side effects revalidate route plus epoch immediately before mutation or ACK. |
| V-04 | Added a 512 MiB raw source ceiling and a separate 2 MiB decoded-line ceiling to streaming reads so a no-newline file cannot grow carry without bound. |
| V-05 | Made 64 terminal sessions a hard pre-spawn limit; only exited, unlocked sessions can be collected, so a live child is never forgotten to make registry space. |
| V-06 | Rebuilt shutdown as admission/drain, owned-child termination, recorder flush, and independent durable flush phases. MCP/bridge drains are bounded; tunnel and desktop-helper process trees and timers are awaited. |
| V-07 | Replaced whole-map canonical message rewrites with one atomically replaceable, content-addressed shard per stable message identity. The old map is a lazy-migration overlay. |
| V-08 | Added a 160-row, 2 MiB input, 256 KiB rendered-HTML timeline window with an explicit omission notice; recent-tail parsing no longer repeatedly concatenates an unbounded buffer. |
| V-09 | Added AbortController deadlines to worker fetches, a durable idempotent close outbox with alarm retries, permanent-4xx journal head isolation, and stricter page-to-worker durability acknowledgement. |
| V-10 | Page command settlement now occurs only after authoritative app ACK; stale current-protocol ACKs receive `no_such_command` instead of silently blacklisting a replacement. |
| V-11 | Ended runs persist 30-minute worker lease tombstones, the bridge tells the matching tab to stop, and the MCP kernel rejects exact retired callers or any temporarily ambiguous caller while a retired lease could still be open. |
| V-12 | Stale-swarm sweeps are singleflight. `activeTurnId` and last outcome live in durable metadata; legacy recovery reads only a bounded newest event tail. |
| V-13 | Added a validated metadata checkpoint, explicit bounded history rebuild, sharded canonical recovery, and a durable continuation transaction journal. Startup resolves interrupted commits from the authoritative session attachment and fails closed on a third identity or missing handoff. |
| V-14 | Search now has one 10-second monotonic whole-call deadline, passes remaining time to ripgrep, bounds breadth-first enumeration before materialization, and refuses JavaScript regex fallback when ripgrep is absent. |
| V-15 | `apply_patch` rejects source files above 16 MiB before duplicate planning/execution reads can amplify them. |
| V-16 | Bridge origin/auth checks occur before rate charging; page activity polling backs off to 10 seconds idle and 30 seconds hidden. |
| V-17 | Asset reservations are serialized and checked against durable per-session (192 MiB) and global (2 GiB) disk usage, with an 8 MiB per-asset cap and accounting invalidation after deletion/pruning. |
| V-18 | Protocol mismatch returns HTTP 426 on stateful bridge routes. The popup shows exact app/extension versions and protocol numbers instead of appearing partly connected. |
| V-19 | Diagnostics use `pass | fail | skipped | not-run`; unexecuted checks cannot produce “all passed,” and desktop usefulness comes from the same surface projection used by MCP discovery. |

### Design cleanup

- Rebalanced Home so controls occupy a compact fixed top row and Activity gets the expandable area.
- Replaced the oversized white quarter-width navigation capsule with four centered compact destinations and a restrained active treatment.
- Increased dark-surface separation and text contrast while keeping status colour semantic (green live, red failure).
- Made Activity a stable time/subject/detail grid with stronger row hierarchy and tighter density.
- Widened the Chat session rail, reduced selected-row glare, and improved timeline spacing and truncation behavior.
- Consolidated Setup controls into clearer settings rows and made diagnostic skipped/not-run states visually distinct.

### Explicit residual evidence boundaries

- The page-side amplification paths are now bounded, but this pass still has no live Chrome performance/heap trace proving whether a previously observed ChatGPT crash ended in OOM, watchdog termination, or an upstream page failure.
- The renderer uses a hard-budgeted newest window, not full DOM virtualization. This closes the verified synchronous memory cliff while keeping implementation risk contained for 1.8.8.
- The known same-user Windows reparse/junction swap race remains documented in the README; pathname validation alone cannot make Node filesystem operations handle-relative.

## Verification record

- `npm test -- --run test/bridge.test.ts`: **66/66 passed** during the extension/bridge implementation stream.
- `npm test -- --run test/extension.test.ts`: **45/45 passed** during the extension/bridge implementation stream.
- Final integrated `npm run typecheck`: **passed** on 1.8.8.
- `node --check` for `extension/background.js`, `content.js`, `fiber.js`, `chatgpt-dom.js`, `popup.js`, and the packaged-runtime smoke script: **passed**.
- `git diff --check`: **passed** (only existing CRLF conversion warnings).
- Final `npm run verify`: **not executed**. The required outside-sandbox run was rejected by the Codex approval service because the account execution quota is exhausted until 2026-08-27 13:52 local time. No workaround was attempted.
- `npm run build`: the restricted run failed before compilation because esbuild could not read the parent dependency/config path. The outside-sandbox approval was rejected by the same quota gate, so this is **environment-blocked, not a source build result**.
- `scripts/smoke-packaged-runtime.mjs` now checks app/extension version agreement, extension scripts, tunnel-client, cloudflared, ripgrep, app.asar, node-pty, Sharp/libvips, and an actual Sharp PNG encode. It cannot be run until a package exists.

## Release artifacts

No 1.8.8 installer exists yet. Expected output after approval is:

- `release/ChatGPT-Local-Files-Setup-1.8.8.exe`
- `release/win-unpacked/`

Do not publish or install a stale 1.8.7 artifact under the new release name. Hashes belong here only after the final NSIS file and packaged smoke both succeed.
