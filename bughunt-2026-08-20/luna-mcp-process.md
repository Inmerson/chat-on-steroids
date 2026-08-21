# Luna audit: MCP / process lifecycle

Date: 2026-08-20
Scope: read-only review of the current MCP HTTP server, call tracking, Core process
runtime, connection lifecycle, dynamic exposure, and result bounds. No production or
test files were changed by this audit.

## Ranked findings

### HIGH — forced MCP drain still creates an ambiguous commit after 30 seconds

**Status: OPEN (the normal drain path is improved, but the forced path is not coherent).**

**Exact current refs**

- `src/main/mcp/server.ts:432-453`: `stop()` calls `server.close()` and waits for active
  requests, but after 30,000 ms calls `server.closeAllConnections()` and resolves only via
  the eventual `server.close()` callback.
- `src/main/connection.ts:352-367`: disconnect waits for `endpoint.stop()`, while no
  cancellation signal is passed to a tool handler.
- `src/main/mcp/call-context.ts:121-153`: `inFlight` and `inFlightRequests` are tracked,
  but neither counter participates in endpoint shutdown.
- `src/main/mcp/kernel.ts:332-435`: once dispatch enters the handler/recorder, it has no
  endpoint-lifetime check or cancellation path.

**Ordering / repro**

1. Accept a real `tools/call` whose handler performs a mutation and then blocks longer than
   30 seconds (or never settles).
2. Call `endpoint.stop()` while the request is active.
3. At 30 seconds the active socket is destroyed, so the caller receives a transport failure;
   the handler continues in the main process and can commit its mutation afterwards.

The already-recorded shorter repro remains valid for the same ordering: stopping during an
accepted command closes the response while the command writes its delayed side effect.

**Impact**: the remote caller can retry a mutation after a transport failure, producing a
duplicate command/write. The new graceful drain removes this ambiguity for handlers that
finish before 30 seconds, but the forced deadline still deliberately destroys the response
without cancelling the work.

**Minimal fix**: choose and enforce one policy at the deadline: either keep a durable
shutdown/drain state until accepted calls finish, or propagate an AbortSignal to every
handler and make mutating/process operations honor it before committing. If force-close is
unavoidable, report accepted-call ids as indeterminate and prevent automatic retry rather
than claiming a clean stop.

### MEDIUM — UI total-tool count is wrong for the two real MCP surfaces

**Status: OPEN (presentation/diagnostics mismatch).**

**Exact current refs**

- `src/renderer/main.ts:48`: `MAX_TOOL_COUNT = 8`.
- `src/renderer/main.ts:286-291`: `toolsOn()` sums `surface.tools.length` across Core and
  Desktop.
- `src/main/mcp/surfaces.ts:95-111,126-136`: Core has eight possible names but at most
  seven live schemas, while Desktop can add `observe` and `computer` (two more).
- `src/main/connection.ts:120-134`: the UI-facing `toolsFor()` returns the current
  per-surface list.

With read, command, edit, recording and multi-agent enabled, the actual maximum is 9
schemas (7 Core + 2 Desktop), while the renderer displays `9 of 8`. Conversely, Core's
mutually exclusive `find`/exec pair means the declared eight names are not eight live Core
schemas.

**Minimal fix**: derive the denominator from the same surface definitions/capability
projection used to build the state (or remove the denominator and show the per-surface
lists). Add a UI/state assertion covering Core-only, Desktop-only, and both surfaces.

### MEDIUM — monotonic MCP exposure is not represented by the UI and can yield stale unknown-tool errors

**Status: OPEN by design, but the user-facing state is misleading.**

**Exact current refs**

- `src/main/mcp/server.ts:207-238,263-286`: an endpoint retains previously exposed tools
  monotonically, except `forgetExposedSurface()` resets the feature snapshot.
- `src/main/mcp/kernel.ts:646-690`: exposed-but-disabled tools remain registered and return
  `TOOL_DISABLED`.
- `src/main/ipc.ts:154-164`: switching multi-agent off calls `forgetExposedSurface()` while
  the endpoint itself remains alive.
- `src/renderer/main.ts:303-342,719-720`: the UI shows the current config's tool list and
  tells the user to reconnect, but does not show that the live endpoint's cached schema
  may differ.

**Ordering / repro**: connect with multi-agent enabled, let ChatGPT cache `agents`, turn the
setting off, then issue the old `agents` call before ChatGPT reconnects. The reset causes the
next per-request server build to omit the old tool, so the stale client receives an
unknown-tool failure rather than the normal `FEATURE_DISABLED` response. This is safe but
looks like a transport/integration failure and is not reflected in the live tool list.

**Minimal fix**: either reconnect/recreate the MCP endpoint as part of the setting change,
or retain the old registration and return `FEATURE_DISABLED` until the caller performs the
documented reconnect. Update the UI status from actual endpoint exposure, not only config.

### MEDIUM — image results duplicate a large base64 payload in content and structuredContent

**Status: OPEN (bounded but expensive).**

**Exact current refs**

- `src/main/mcp/tools-core.ts:303-335`: `view_image` returns the same image as MCP
  `content[0].data` and as `structuredContent.image_url`.
- `src/main/mcp/tools-core.ts:1469-1479`: image reads likewise include a base64 image in
  structured output while the normal result path also carries image data.
- `src/main/fsops.ts:18-19,363-379`: compressed input is capped at 8 MiB; this bounds the
  source file but not the duplicated base64/object/JSON representation.

At the cap, each base64 representation is about 10.7 MiB, so the response can hold roughly
21.3 MiB of base64 text before MCP/JSON/object overhead. This is not the decompression-bomb
bug (the PNG validation issue is separately retained in `worker-mcp-electron.md`), but it
can amplify memory and tunnel response pressure on repeated image calls.

**Minimal fix**: return one canonical image representation per MCP response, or enforce a
separate total serialized-result budget before adding structuredContent. Keep the existing
decoded-pixel/inflater bounds as a separate invariant.

## Checks that held in the current tree

- `src/main/mcp/server.ts:88-130,375-399`: missing-length/chunked body parsing applies the
  same 8 MiB cap and drains oversized requests; no compatibility regression was found in
  source review.
- `src/main/codex/unified-exec.ts:446-469,714-795`: Ctrl+C now treats `ESRCH` as the
  natural-exit race and reconciles on the following poll; the formerly promoted false
  failure is fixed.
- `src/main/codex/ownership.ts:34-70` and `tools-core.ts:615-633,714-734`: unknown or
  missing identity cannot write to a proven terminal session; anonymous sessions cannot be
  adopted by a later proven conversation.
- `src/main/exec.ts:202-249`: Windows tree termination uses an absolute `taskkill.exe`
  path with a bounded helper timeout and direct-kill fallback. The fallback can leave
  grandchildren if the helper is unavailable, but the normal Windows path is bounded and
  no new unbounded cleanup wait was found.
- `src/main/codex/unified-exec.ts:546-585,932-978` and
  `src/main/mcp/tools-core.ts:541-647`: structured exec output follows the same truncation
  policy as text output; no bypass was found in the current exec path.

## Verification note

I attempted the safe focused Vitest command:
`npx vitest run test/mcp-shutdown.test.ts test/codex-runtime-parity.test.ts test/mcp.test.ts --reporter=dot`.
The run stopped at Vitest/esbuild startup with `Cannot read directory "..": Access is
denied` and `Could not resolve ...\\vitest.config.ts` in this managed sandbox; this is a
harness/environment failure, not classified as a product finding. No files outside this
audit note were edited.
