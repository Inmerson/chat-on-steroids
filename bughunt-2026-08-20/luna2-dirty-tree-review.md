# Luna 2 dirty-tree release review

Date: 2026-08-20  
Repository: `C:\Users\totec\chatgpt-local-files`  
Scope: all current tracked and untracked dirty changes, with `AGENTS.md` and `bughunt-2026-08-20/00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` as review context. This is a read-only adversarial review; no production, test, AppData, config, or Git state was changed.

## Ranked release findings

### P0 — approved-root validation is still bypassable by a Windows reparse-point TOCTOU

`src/main/sandbox.ts:147-164` canonicalizes only the deepest existing path, and `resolvePath()` returns the checked pathname at `src/main/sandbox.ts:252-318`. Consumers subsequently reopen that pathname: `src/main/mcp/tools-core.ts:474-506, 1299-1323` and the Codex read/patch backends. A same-user process can swap a checked directory for a junction after `resolvePath()` returns and before the later open/stat/write. The current README explicitly admits this at `README.md:60`, but disclosure does not preserve the approved-root confidentiality/integrity boundary.

Proof/repro idea: the retained `bughunt-2026-08-20/repro-reparse-toctou.ts` resolves `/workspace/gate/secret.txt`, renames `gate`, installs a junction to `outside`, and reads the already-returned `resolved.real`; on Windows/NTFS the read is then outside the approved root. Run the same ordering against `read`, `apply_patch`, and `exec_command` with a barrier between validation and use. The same race also defeats the image size check (`src/main/codex/view-image.ts:151-173`): `readFile()` has a 512 MiB primitive cap, not the roughly 3 MiB image wire cap, if the file is replaced/grown after metadata.

Action: use handle-relative/strongly pinned Windows opens for the check-and-use operation (including directory traversal), or fail/lock the affected operation until that is available. A second `realpath` at the consumer is not a fix for the same race. This should block 1.8.6 on a security-boundary claim.

### P1 — a normal ChatGPT reload closes the conversation before the replacement document registers

The background module says reload must not close a conversation (`extension/background.js:100-104`), but the new `tabs.onUpdated` path treats every `changeInfo.status === 'loading'` as terminal (`extension/background.js:1109-1119`). It calls `markTerminal()` and `releaseTab()` before the new document can send `register_document`; `releaseTab()` removes the tab conversation and posts `/closed` at `extension/background.js:798-824`. The app then runs `closeConversation()` (`src/main/bridge.ts:677-695`, `src/main/session/recorder.ts:1564-1585`), ending the session/worker slot and appending an `unknown` turn end if generation was active. The replacement page later clears the terminal tombstone and reopens the session, but cannot undo a prime/worker run release or the false detach lifecycle.

Proof/repro idea: record an active conversation C in one tab, then emit `onUpdated(tab, {status:'loading', url:'https://chatgpt.com/c/C'})`; delay the replacement `register_document` message. Observe `/closed` for C before registration. Repeat with a prime and a worker: the bridge's `primeConversationGone()`/`workerConversationGone()` path can end the run on an ordinary reload. Add the same-document-reload case beside the existing external-navigation tests in `test/extension.test.ts:970-1171`.

Action: defer release while a same-tab ChatGPT replacement document is expected, and only close after a real tab removal or a proven external navigation that cannot be the same conversation. Preserve the terminal/stale-document protection without making reload a conversation close.

### P1 — proven swarm identity can still default commands and patches to the first approved root

`dispatchTracked()` refuses only when identity itself is missing (`src/main/mcp/kernel.ts:383-400`). Once an exact conversation/agent is proven, `resolveCwd()` still chooses `ctx.roots[0]` when the workspace map is empty (`src/main/mcp/kernel.ts:560-572`), and `apply_patch` does the same (`src/main/mcp/tools-core.ts:474-478`). Workspace state is intentionally evictable/TTL-bound in `src/main/workspace.ts`; missing inheritance or a compact/restart map loss is therefore reachable. In a swarm, this turns a recoverable workspace outage into wrong-project arbitrary shell execution or mutation.

Proof/repro idea: enable multi-agent mode, prove a worker's conversation identity, start it without inherited workspace (or clear/expire that worker's workspace), then call `exec_command` without `workdir` and `apply_patch` with relative paths while two approved roots exist. The operation resolves against root 0 instead of refusing. The no-identity refusal does not exercise this case because the identity is present.

Action: when `swarmRunning()` and the operation consumes an omitted/default workspace, require a non-null workspace and return a clear `WORKSPACE_REQUIRED` refusal. Keep first-root fallback only for an explicitly accepted non-swarm compatibility mode.

### P1 — startup request-correlation recovery performs unbounded full-session scans and can permanently disable retry

`restoreRequestCorrelations()` sets `restored = true` before any I/O (`src/main/session/correlation.ts:143-145`), then enumerates every session and fully parses each `events.jsonl` through `readEvents()` (`:171-194`; implementation `src/main/session/store.ts:717-785`). The `kinds` filter does not avoid reading/parsing the file. On startup this runs before the app is ready (`src/main/index.ts:180`), and `repairDeterministicAttribution()` immediately adds another all-session/all-event pass (`src/main/index.ts:181`, `src/main/session/recorder.ts:665-674`). The consolidated audit already measured a 40 MiB/250k-event history causing roughly a 68-second main-process freeze.

There is also a recovery correctness failure: a transient `readDurable()`, `listAllSessions()`, or `readEvents()` error after `restored = true` leaves future calls as no-ops. The existing catch only returns early when a snapshot was loaded; otherwise it throws once and never retries.

Proof/repro idea: use the retained large-session probes or a 40 MiB `events.jsonl`, restart, and measure time/peak memory before the window and bridge become usable. Inject one transient store/read failure, call `restoreRequestCorrelations()` again, and verify that the second call does not reconcile because the flag is already set.

Action: persist an incremental request-id index/high-water cursor, or use a bounded/indexed scan; do not parse every historical journal on every launch. Set the completed flag only after successful reconciliation, or keep an explicit retryable state and surface degraded attribution while recovery is pending.

### P1 — post-restart `/activity` can synchronously re-read a whole session on every cold feed

When the live recorder map is empty, the new bridge path calls `restoreRecordedConversation()` (`src/main/bridge.ts:705-718`). That goes through `findSessionByConversation()` and `sessionForConversation()`, whose existing-session path calls `storedHistory()` (`src/main/session/recorder.ts:211-217, 416-423`), a full `readEvents()` scan. The route then calls `readEvents(live.sessionId, { from: since })` again (`src/main/bridge.ts:721-724`). A first poll normally has `since=0`, so the cache shortcut cannot help; explicit old cursors also force the full-file implementation at `src/main/session/store.ts:717-785`.

Proof/repro idea: with a large recorded session, restart the app or clear only the in-memory recorder map, then issue `/activity?conversationId=C&since=0` and repeat while the page polls. Measure the main-process pause and allocations; the first request performs at least one full history reconstruction and another full event read, and a failed reattach can repeat that work on later polls.

Action: restore from a bounded durable activity projection/tail plus a cursor, and make `/activity` consume that projection directly. Do not rebuild lifecycle/page-tool state by parsing the entire journal on the browser polling path.

### P1 — forced MCP shutdown still permits an accepted mutation to commit after its transport was destroyed

The normal drain now waits, but the timeout at `src/main/mcp/server.ts:428-453` calls `server.closeAllConnections()` after 30 seconds. `src/main/connection.ts:352-367` has no cancellation or indeterminate-result handoff, and `src/main/mcp/call-context.ts:121-153` only counts in-flight work. Tool handlers and recorder writes can therefore continue after the caller receives a socket/fetch failure. A client retry can execute the same mutation twice.

Proof/repro idea: hold an accepted `apply_patch` or other mutating tool call past 30 seconds, invoke endpoint/connection stop, and let the handler finish after the socket is destroyed. Assert that the caller sees transport failure while the file/session mutation commits; retry the same request and observe the duplicate. The existing short-drain test does not cover this forced path.

Action: propagate an abort signal into every handler and make mutators stop before commit, or add durable accepted-call/idempotency records and an explicit indeterminate receipt. Do not represent a forced close as a cleanly failed call when the process may still commit it.

### P1 — explicit session-history search/call/range inputs remain unbounded in work, scan bytes, and asset expansion

Only the default history tail uses `readRecentEvents()` (`src/main/mcp/tools-core.ts:763-770`). Any `query`, `call_id`, or `from` takes the full `readEvents()` path. Query matching then JSON-stringifies every event and may expand every truncated asset (`src/main/mcp/tools-core.ts:875-880`), with no total scan-byte, event, or expanded-asset budget. The `limit` cap bounds returned lines, not the work or memory needed to find them.

Proof/repro idea: create a session with a large journal and many truncated tool payloads/assets, then issue `session(action='history', query='x')` and `session(action='history', call_id=...)`. Measure main-process latency and memory while the response remains small.

Action: provide streaming/index-backed search with hard scan/event/expanded-byte budgets and a truthful `truncated`/continuation result. Keep the exact-call expansion budget separate from the search scan budget.

### P2 — the focused multi-agent switch still bypasses the new dirty-field protection

`apply()` protects `homeMaEnabled` at `src/renderer/main.ts:452-463`, but `paintGroups()` immediately overwrites it unconditionally at `src/renderer/main.ts:239-273`. A focused user toggle can therefore be reverted by an unsolicited whole-config `state:changed` push before its `change` save completes. The added renderer regression covers `tunnelId` only (`test/renderer-state.test.ts`), not this switch.

Proof/repro idea: focus `homeMaEnabled`, toggle it, deliver an old state push before the change IPC resolves, and assert the control remains dirty. It currently reverts in `paintGroups()`.

Action: apply the same previous-state/dirty guard inside `paintGroups()` or have `apply()` pass the guarded value through; add a multi-agent checkbox regression. This is lower priority than the security and lifecycle blockers but should be fixed before calling the settings race closed.

## Areas reviewed with no release-blocking issue found

- Release metadata and packaging: `package.json`, `package-lock.json`, `src/main/version.ts`, `extension/manifest.json`, and `electron-builder.yml` are synchronized at 1.8.6; scripts/devDependencies are present; Sharp and node-pty/@img trees are explicitly unpacked. The untracked smoke/probe files and audit reports are outside the builder's `out/**`/extra-resource inputs.
- MCP ingress and surface publication: chunked/no-`Content-Length` body bounding in `src/main/mcp/server.ts`, current Core/Desktop surface counts, `view_image` publication, live capability guards, and sanitized error paths were reviewed. No new protocol producer/consumer mismatch was confirmed there.
- Identity/terminal ownership: request-id attribution guards in `src/main/mcp/kernel.ts`, anonymous-versus-proven ownership in `src/main/codex/ownership.ts`, and late identity waits were reviewed. The missing-workspace fallback above is the remaining release issue; do not treat the identity guard as covering it.
- Process/output bounds: the ESRCH interrupt handling and structured output truncation in `src/main/codex/unified-exec.ts` are coherent; the former terminal-exit race and structured-content cap bypass were not found in the current tree.
- Extension Fiber/journal paths: Fiber listener replacement and `scanOk`, service-worker journal byte/count bounds, serialized storage writes, explicit queue-gap markers, and durable event acknowledgement were reviewed. The reload lifecycle issue above is separate from the repaired Fiber/journal behavior.
- Session/rendering integrity: canonical message upserts, sequence-tail recovery, bounded default recent-history reads, chronology's O(n) rewrite, and renderer session/detail/handoff generation guards were reviewed. The explicit-history and cold-`/activity` scans above remain outside those bounded paths.
- Native/virtual path syntax and installer-facing documentation were reviewed. Lexical Windows `..`/device-name/native-path handling is covered; it does not solve the reparse TOCTOU finding.

## Verification record

- Final `npm run typecheck` pass: green.
- A build attempt was made during the review but the managed execution sandbox denied access while resolving the repository's parent path; that environment failure is not treated as a product finding. A Windows packaged-install smoke test remains required after the blockers are fixed.
- No source, test, AppData, config, or Git files were edited by this review; only this report is intended to be added.
