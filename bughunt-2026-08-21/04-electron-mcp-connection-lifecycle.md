# Electron / MCP / connection lifecycle audit

**Date:** 2026-08-21 (Europe/Berlin)
**Repository:** C:\Users\totec\chatgpt-local-files
**Scope:** read-only review of the Electron main lifecycle, MCP HTTP transport and dispatch accounting, connection/tunnel supervision, diagnostics, logger, and durable state.
**Repository writes:** this report only. No production source, tests, AppData, config, build, or commit was changed.

## Result at a glance

Five source-proven lifecycle breakpoints remain. The first four can leave the app with duplicate resources, a stuck or partially torn-down main process, or an unhandled async failure. The fifth weakens stale-agent cleanup exactly during the known request-identity outage. Existing focused tests were not rerun; the audit looked for ordering and runtime failure paths that ordinary green tests do not cover.

## Findings

### E1 — HIGH — losing the single-instance lock does not terminate the startup path

**Status:** NEW, source-confirmed; no Electron process repro was run. **Confidence: high.**

src/main/index.ts:42-45 calls app.quit() when app.requestSingleInstanceLock() returns false, but execution continues. The module still registers second-instance at line 169 and attaches the full app.whenReady() startup chain at lines 171-253. app.quit() is asynchronous, so a second launch can reach whenReady before the quit request is processed.

**Trigger:** start a second app copy while the first owns the lock.

**Impact:** the losing process can initialize the same user-data paths, load and possibly rewrite config/state, register IPC/window listeners, start the browser bridge, and attempt a tunnel before it exits. Two processes can briefly fight over the bridge ports, tunnel id, config temp file, and durable state; the visible symptom may be a transient duplicate connector or a state write from the process that should never have started.

**Fix direction:** make lock ownership a hard startup branch: return from the entry path (or put all event registration and whenReady work in the else branch) when the lock is lost. Keep the existing second-instance handler only in the owning process.

### E2 — HIGH — shutdown kills active MCP work in parallel and can skip every final flush

**Status:** NEW shutdown composition; related ambiguous MCP disconnect was already retained as M3 in bughunt-2026-08-20 and is not considered fixed merely because endpoint draining was added. **Confidence: high.**

src/main/index.ts:264-276 starts disconnect(), unifiedExecManager.terminateAllProcesses(), and stopBridge() in one Promise.all. However, disconnect() eventually calls the MCP endpoint's drain-oriented stop at src/main/mcp/server.ts:432-453, while terminateAllProcesses() immediately clears the managed-process map and terminates every process (src/main/codex/unified-exec.ts:471-484, 848-853). An accepted exec_command can therefore still have an open HTTP response while shutdown kills the child whose result it is meant to deliver. The bridge uses an even harder cut at src/main/bridge.ts:1391-1394 (closeAllConnections() before close()), so accepted browser observation requests can be destroyed before recorder flushing.

The same chain has a second failure mode: if any member of the Promise.all rejects, the .then(() => flushRecorder()) and subsequent session/durable flushes at lines 274-275 are skipped, while .finally(() => app.quit()) at line 276 still exits. A tunnel stop, bridge close, process termination, or listener exception can therefore turn a teardown error into lost recorder/session/state writes.

**Trigger:** quit with a long-running MCP command, an accepted bridge request, or a transient teardown rejection.

**Impact:** client-visible transport failure or partial command side effects, followed by a shutdown that can lose the final tool/observation/state records. This is an ordering bug, not just a timeout choice: the code promises to drain accepted MCP work while concurrently cancelling the process that performs it.

**Fix direction:** serialize shutdown explicitly. Stop accepting new MCP/bridge work, choose and communicate a cancellation contract for already accepted requests, drain or cancel them with a bounded deadline, then terminate remaining process sessions, and finally run recorder, session, and durable flushes in a finally/best-effort aggregation that cannot be skipped by one teardown error. Preserve per-step errors for diagnostics rather than allowing them to short-circuit the final flush.

### E3 — HIGH/MEDIUM — tunnel stop and launch paths leak child lifetime or reject unobserved

**Status:** NEW relative to the prior tunnel/process-tree report (the old bare-taskkill failure was improved); source-confirmed. **Confidence: high for stop ordering and the cloudflared timer; medium-high for unhandled launch rejection.**

The shared killTree() at src/main/tunnel/index.ts:71-81 starts terminateProcessTree() with void and returns no completion promise. Both tunnel handles then report stop completion without waiting for that operation:

- OpenAI: src/main/tunnel/index.ts:545-553.
- cloudflared: src/main/tunnel/index.ts:665-670.

terminateProcessTree() itself awaits the Windows helper or sends the fallback signal (src/main/exec.ts:202-265), but the tunnel caller does not await it. A reconnect or quit can therefore remove the handle and start the next tunnel while the old child (or its supervised grandchild) is still alive. Late process output/exit events are still attached to the old child, and repeated reconnects can accumulate processes or control-plane connections.

The OpenAI supervisor also launches its async loop with void launch() at line 543 and again from the retry timer at line 358, with no catch. A synchronous spawn/argument failure or an unexpected exception from health/report handling leaves the state at “connecting” and creates an unhandled rejection. The cloudflared readiness timeout at lines 656-663 is neither stored nor cleared nor unref'd; stopping immediately after spawn leaves a referenced 45-second timer holding the closure and potentially delaying process exit.

**Trigger:** reconnect/quit immediately after a tunnel process starts, a malformed/unlaunchable configured executable, or cloudflared stopping before its URL appears.

**Impact:** duplicate tunnel clients, orphaned child/grandchild processes and temp resources, stuck “connecting” UI, or a main-process unhandled rejection. The cloudflared timer alone keeps the event loop live for up to 45 seconds after stop.

**Fix direction:** make child termination return a promise and wait for exit with a bounded fallback before publishing the handle as stopped; attach one catch/report path around every launch attempt and use a per-launch generation so stale readiness/watch callbacks cannot report after replacement. Store and clear the cloudflared timeout (and unref it if it is only a watchdog), and remove the per-run temp directory after the child is proven gone.

### E4 — HIGH — renderer push/log listeners can throw into main-process lifecycle code

**Status:** NEW; source-confirmed. **Confidence: high.**

src/main/ipc.ts:415-427 installs main-process listeners that call getWindow()?.webContents.send(...) without checking isDestroyed() or catching errors. pushState() additionally starts void buildState().then(...) without a rejection handler (src/main/ipc.ts:416-421). buildState() crosses async secret and bridge reads and can reject; webContents.send() can throw once the renderer/webContents has been destroyed.

src/main/index.ts:35 retains the BrowserWindow reference indefinitely: no closed handler sets it to null. showWindow() at lines 107-115 calls isMinimized, show, and focus on that reference without an isDestroyed() guard. The synchronous onLog, onSessionChange, and onSwarmChange sends can therefore throw during a renderer crash/close or while shutdown is already destroying the window. logger.ts:42-54 and connection.ts:73-76 invoke listeners synchronously and do not isolate one bad listener from the producer.

**Trigger:** close/crash the renderer while a tunnel status, MCP error, session write, or swarm event is emitted; or let a delayed buildState() resolve after the window is gone.

**Impact:** an exception propagates into tunnel callbacks, status/lifecycle operations, or shutdown. Depending on the call site it becomes an unhandled promise rejection, aborts a connection transition, or prevents the final flush chain in E2. A subsequent second-instance event can also throw against the destroyed window instead of recreating it.

**Fix direction:** clear the window reference on closed; centralize a safe sendToRenderer that checks isDestroyed() and catches send; add catch to every async state push and log the failure without rethrowing. Listener dispatch in logger/status should isolate callback exceptions, and shutdown should unregister renderer-facing listeners before destroying the window.

### E5 — MEDIUM/HIGH — MCP in-flight accounting ends before degraded recording finishes

**Status:** NEW lifecycle amplification of the prior request-identity outage; source-confirmed. **Confidence: high for the accounting gap, medium-high for stale-run consequence.**

src/main/mcp/call-context.ts:128-143 documents and implements inFlightMcpRequests as covering dispatch, identity waits, and durable recording. But src/main/mcp/kernel.ts:432-450 only awaits recordToolCall() when the caller already has an exact conversation id; the no-identity path deliberately executes void recording. That recording still waits up to REQUEST_ID_GRACE_MS (15 seconds) for exact page evidence in src/main/session/recorder.ts:998-1018 and then performs the serialized disk write. The outer trackMcpRequest() finally runs as soon as the MCP result is returned.

The bridge's stale swarm sweep uses this counter as a safety gate (src/main/bridge.ts:1230-1243, 1263) but has no separate pending-recorder count. During a Fiber/request-correlation outage, a worker's tool can therefore be returned to ChatGPT and filed as Unattributed while its durable append is still pending; a concurrent sweep can see zero in-flight MCP requests and make a quiescence/stale decision against history that has not yet received that call.

**Trigger:** multi-agent mode with missing page-side request evidence, followed by a stale sweep or run-release check during the 15-second attribution/write window.

**Impact:** active work can look durably idle, compounding the known Unattributed -> false-stall -> stale-worker cascade; final reports/messages may be released or dropped before the pending record is visible to the quiescence proof.

**Fix direction:** keep a separate recorder-pending counter (or keep the MCP request counter alive through recording.finally) even when the response is deliberately not blocked. Make stale/quiescence checks use that wider accounting, and add a negative ordering regression: return an unattributed call, run the sweep before its exact-id grace expires, then resolve the recording and assert the worker was not released.

## Prior findings checked against current code

- The prior concurrent bridge-start listener leak (M2) appears addressed by bridgeStarting/stopBridge serialization at src/main/bridge.ts:1291-1305, 1374-1394.
- The prior endpoint-disconnect ambiguous-commit finding (M3) is only partially addressed: server.close() now drains with a 30-second force-close, but E2 shows that app shutdown concurrently terminates the process and hard-closes bridge connections, so the accepted-work contract is still not coherent.
- Existing transport safeguards remain present: the server bounds declared and chunked/no-Content-Length bodies at src/main/mcp/server.ts:80-129, 375-399, validates loopback Host/Origin, and has request/header timeouts. This audit did not claim those checks absent; the remaining concern is lifecycle/error handling around them.

## Recommended order

1. Fix E2 first: establish one shutdown contract and make final flushing non-skippable.
2. Fix E1 and E4 to prevent duplicate-start and renderer-lifecycle exceptions from entering that shutdown path.
3. Fix E3 so reconnect/quit really owns child process lifetime.
4. Fix E5 before relying on stale-agent cleanup as an identity-outage recovery mechanism.

