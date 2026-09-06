# DesktopCommander Regression Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode six DesktopCommander-derived failure classes as permanent Chat On Steroids regressions and make only the minimal production changes required by failing tests.

**Architecture:** Keep existing runtime boundaries intact and exercise the real process, filesystem, recorder, sandbox, and tunnel seams. Test-only characterization is preferred when the current implementation already satisfies the invariant; when a regression fails, fix the narrow source seam rather than introducing a parallel subsystem.

**Tech Stack:** TypeScript, Node.js child processes/filesystem, Vitest, Electron main-process modules, existing MCP server/runtime.

**Spec:** `docs/superpowers/specs/2026-09-06-desktopcommander-regression-pack-design.md`

## Global Constraints

- Do not add MCP tool names.
- Do not weaken approved-root canonicalization or Core/Desktop authority separation.
- Do not add URL fetch behavior to local file reads.
- Do not add a command blocklist as a containment boundary.
- Preserve the 1 MiB unified-exec collection ceiling and existing token-budget semantics.
- Recorder persistence must remain observable/flushable even when removed from request latency.
- Tunnel `connected` state must continue to require recent end-to-end handshake evidence.
- Follow RED -> GREEN when production behavior changes; test-only characterization may start GREEN when it proves an existing invariant.
- Commit each task separately. Do not push, merge, publish, install, or modify the live installed app.

---

### Task 1: Process torture suite

**Files:**
- Create: `test/unified-exec-torture.test.ts`
- Modify only if RED requires it: `src/main/codex/unified-exec.ts`
- Modify only if RED requires it: `src/main/codex/head-tail-buffer.ts`
- Reference: `test/codex-runtime-parity.test.ts`
- Reference: `test/unified-exec-mutex.test.ts`
- Reference: `test/exec-output-budget.test.ts`

**Interfaces:**
- Consumes: `UnifiedExecProcessManager`, `applyUnifiedExecEnv`, `execCommandResponseText`, `execCommandStructuredOutput`, `MAX_UNIFIED_EXEC_PROCESSES`.
- Produces: one focused torture suite that covers missing flood/fast-exit/responsiveness/parity cases without duplicating existing tree-kill/capacity tests.

- [ ] **Step 1: Add a request helper and multi-megabyte one-line test**

```ts
const request = (manager: UnifiedExecProcessManager, script: string, yieldTimeMs = 5_000) => {
  const processId = manager.allocateProcessId();
  return manager.execCommand({
    command: [process.execPath, '-e', script],
    shellType: process.platform === 'win32' ? 'powershell' : 'bash',
    hookCommand: 'desktopcommander regression probe',
    processId,
    yieldTimeMs,
    maxOutputTokens: 30_000,
    truncationPolicy: { kind: 'tokens', tokens: 30_000 },
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env),
    tty: false
  });
};
```

Assert a script that writes more than 2 MiB on one line returns bounded output, a non-null omitted-byte count, and a model-visible truncation marker.

- [ ] **Step 2: Add concurrent stdout/stderr and fast-exit stderr cases**

Use a child script that alternates `process.stdout.write()` and `process.stderr.write()` in a loop, then exits non-zero after a final stderr sentinel. Assert the sentinel and exit code survive collection.

- [ ] **Step 3: Add event-loop responsiveness probe**

Start a flood command and a short `setTimeout`/`setImmediate` probe concurrently. Assert the probe runs before the flood call completes and the call remains bounded by the existing collection cap.

- [ ] **Step 4: Add text/structured output parity assertion**

Feed the same `ExecCommandToolOutput` to `execCommandResponseText()` and `execCommandStructuredOutput()` and assert both expose the same omission/truncation evidence and exit state.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run test/unified-exec-torture.test.ts test/codex-runtime-parity.test.ts test/unified-exec-mutex.test.ts test/exec-output-budget.test.ts`

Expected: all pass. If any new case is RED, make the smallest source change needed and rerun until GREEN.

- [ ] **Step 6: Commit**

```text
test(exec): harvest process torture regressions
```

---

### Task 2: Windows partial-read handle release

**Files:**
- Modify: `test/read-backend.test.ts`
- Modify only if RED requires it: `src/main/codex/filesystem.ts`
- Modify only if RED requires it: `src/main/codex/read-backend.ts`

**Interfaces:**
- Consumes: `readTextFile()` and `readFileStream()` generator-finally semantics.
- Produces: a Windows regression proving an early-stopped partial read releases the underlying handle immediately.

- [ ] **Step 1: Add the Windows-only regression**

```ts
it.runIf(process.platform === 'win32')('releases a ranged-read handle before an immediate rename', async () => {
  const source = at('rename-after-range.txt');
  const target = at('rename-after-range-moved.txt');
  await fs.writeFile(source, `${'line\n'.repeat(20_000)}`, 'utf8');
  const result = await readTextFile(source, { startLine: 1, endLine: 2, maxBytes: 1024 });
  expect(result.text).toContain('line');
  await fs.rename(source, target);
  expect(await fs.readFile(target, 'utf8')).toContain('line');
});
```

- [ ] **Step 2: Run focused test**

Run: `npx vitest run test/read-backend.test.ts`

Expected: GREEN on current Windows implementation. If RED shows an open handle, fix generator cleanup rather than adding retry/sleep logic.

- [ ] **Step 3: Commit**

```text
test(read): pin Windows handle release after partial reads
```

---

### Task 3: UTF-8 split-boundary safety

**Files:**
- Create: `test/utf8-stream-boundary.test.ts`
- Modify as required: `src/main/tunnel/index.ts`
- Modify as required: `src/main/search.ts`
- Modify as required: `src/main/computer/index.ts`
- Modify as required: `src/main/codex/head-tail-buffer.ts`
- Modify as required: `src/main/codex/unified-exec.ts`

**Interfaces:**
- Consumes: tunnel line reader, search/computer child-stream accumulation, `HeadTailBuffer` and unified-exec decode.
- Produces: no replacement character when `€` bytes are split by stream chunks or output-cap boundaries.

- [ ] **Step 1: Write RED tests for split stream decoding**

Force `Buffer.from('€')` into `[0xe2]` and `[0x82, 0xac]` chunks. Exercise tunnel/search-compatible decoding helpers and assert the reconstructed text is exactly `€`, never `�`.

- [ ] **Step 2: Write RED test for head/tail cap boundary**

Create a tiny `HeadTailBuffer` budget that cuts through `€` at the retained head or tail edge, then run the resulting bytes through the same model-output path. Assert no `�` is present and omission accounting remains correct.

- [ ] **Step 3: Implement streaming/boundary-safe decoding**

Use Node's `StringDecoder('utf8')` or `TextDecoder.decode(chunk, { stream: true })` for arbitrary child-stream chunks. For head/tail truncation, trim only incomplete UTF-8 boundary bytes; never replace already-corrupted strings after decoding.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run test/utf8-stream-boundary.test.ts test/tunnel.test.ts test/search.test.ts test/computer.test.ts test/exec-output-budget.test.ts`

Expected: GREEN with no replacement characters and unchanged byte/token caps.

- [ ] **Step 5: Commit**

```text
fix(streams): preserve UTF-8 across chunk boundaries
```

---

### Task 4: Symlink and junction escape corpus

**Files:**
- Modify: `test/sandbox.test.ts`
- Modify: `test/workspace.test.ts`
- Modify only if RED requires it: `src/main/sandbox.ts`

**Interfaces:**
- Consumes: `resolvePath`, `validateNewRoot`, workspace `resolveIn` shorthand resolution.
- Produces: named corpus covering escaping links, missing descendants, internal links, and root retargeting.

- [ ] **Step 1: Add a missing-descendant escape regression**

Create an approved link/junction to the outside directory and resolve `<link>/new/deep/file.txt` with `allowMissing=true`. Assert rejection occurs before any path is created.

- [ ] **Step 2: Add internal-link allow case and native/shorthand parity**

Prove an internal link resolving to another directory under the approved root remains allowed, then assert native path and workspace shorthand make the same decision for the escaping target.

- [ ] **Step 3: Retain/strengthen Windows root-retarget coverage**

Keep the existing real junction replacement test and add an assertion that the stale approved-root identity is rejected for both read and create semantics.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run test/sandbox.test.ts test/workspace.test.ts`

Expected: GREEN. Any RED is fixed in canonicalization, never by path-string filtering.

- [ ] **Step 5: Commit**

```text
test(sandbox): harvest junction escape corpus
```

---

### Task 5: Recorder latency isolation

**Files:**
- Modify: `test/mcp.test.ts`
- Modify: `src/main/mcp/kernel.ts`
- Reference: `src/main/mcp/call-context.ts`
- Reference: `src/main/session/recorder.ts`

**Interfaces:**
- Consumes: `recordToolCall()` promise and `holdWhileSettling(context, work)`.
- Produces: attributed MCP tool replies that do not await recorder disk completion while the call remains visible as settling work and `flushRecorder()` still drains it on shutdown.

- [ ] **Step 1: Write the RED MCP latency regression**

Stub the recorder promise so it remains pending after the handler has produced a normal `read` result. Race the real MCP `tools/call` request against a short deterministic timeout and assert the MCP reply wins while the recorder is still unresolved.

- [ ] **Step 2: Verify RED**

Run the single new test. Expected current failure: the MCP reply waits because `kernel.ts` awaits `recording` for exact conversation attribution.

- [ ] **Step 3: Remove recorder persistence from request latency**

Change the exact-attribution branch from awaiting the promise to keeping it in settling accounting:

```ts
holdWhileSettling(context, recording);
```

Do not change `recordToolCall()` ordering, recorder error handling, or `flushRecorder()`.

- [ ] **Step 4: Add accounting assertion**

While the recorder is stalled, assert the tool is no longer counted as actively running but remains included in the wider in-flight/settling projection used by diagnostics/shutdown.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run test/mcp.test.ts test/mcp-inflight.test.ts test/session.test.ts test/mcp-shutdown.test.ts`

Expected: GREEN; shutdown still drains admitted work.

- [ ] **Step 6: Commit**

```text
fix(mcp): keep recorder writes off tool latency
```

---

### Task 6: Tunnel and connection liveness regressions

**Files:**
- Modify: `test/tunnel.test.ts`
- Modify: `test/connection.test.ts`
- Modify only if RED requires it: `src/main/tunnel/index.ts`
- Modify only if RED requires it: `src/main/connection.ts`

**Interfaces:**
- Consumes: `outageConfirmed`, `outageRecovered`, connection generation checks, tunnel retry/backoff/report callbacks.
- Produces: deterministic liveness regression coverage for half-open/stale/restart/duplicate-generation failure classes.

- [ ] **Step 1: Add stale-handshake-with-ready regression**

Model a locally ready tunnel whose handshake timestamp is older than the freshness window and prove the reported state becomes offline rather than connected.

- [ ] **Step 2: Add transient complaint and recovery sequence**

Use fake time to prove a fresh complaint stays connected, the same unanswered run crosses to offline only after the confirmation interval, and a newer handshake clears the run.

- [ ] **Step 3: Add generation-staleness regression in `connection.test.ts`**

Capture a report callback from an old tunnel generation, reconnect, then invoke the stale callback. Assert it cannot overwrite the new connection status or public URL.

- [ ] **Step 4: Add replacement/restart boundedness regression**

Prove a stopped/replaced tunnel handle is stopped exactly once and repeated child failures advance through bounded backoff rather than spawning unbounded concurrent replacements.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run test/tunnel.test.ts test/tunnel-locate.test.ts test/connection.test.ts`

Expected: GREEN. If RED, keep the fix inside the existing supervisor/generation model.

- [ ] **Step 6: Commit**

```text
test(tunnel): harvest liveness and restart regressions
```

---

### Task 7: Final branch verification

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes: all six task commits.
- Produces: release-quality evidence for the isolated branch.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`

- [ ] **Step 2: Run focused P1 suites**

Run: `npx vitest run test/unified-exec-torture.test.ts test/read-backend.test.ts test/utf8-stream-boundary.test.ts test/sandbox.test.ts test/workspace.test.ts test/mcp.test.ts test/mcp-inflight.test.ts test/mcp-shutdown.test.ts test/tunnel.test.ts test/tunnel-locate.test.ts test/connection.test.ts`

- [ ] **Step 3: Run full suite**

Run: `npm test`

- [ ] **Step 4: Diff hygiene**

Run: `git diff --check origin/main...HEAD`

- [ ] **Step 5: Record final review evidence**

Do not push or merge. Hand the clean branch to the finishing-development-branch workflow after final code review.
