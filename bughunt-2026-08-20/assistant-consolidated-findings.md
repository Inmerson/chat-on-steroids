# Defensive connector audit — consolidated findings

Saved: 2026-08-20 12:35 Europe/Berlin
Scope: current ChatGPT Local Files connector tree. This is a defensive engineering audit of the user's own connector. No credentials, access tokens, or unrelated personal data are included here.

## Status

The three requested audit scopes all produced durable reports under this directory:

- `worker-extension-transcript.md` — completed, severity-ranked summary and final verification present.
- `worker-mcp-electron.md` — completed, severity-ranked summary and final verification present.
- `worker-filesystem-codex.md` — substantial completed report with ten ranked findings, regression-suite result, coverage notes, unresolved gaps, and retained repro artifacts. Its worker control channel suffered `WORKER_IDENTITY_LOST`, so broker finish/notification did not complete normally, but the report itself is durable.

`MASTER.md` contains prime-side independent confirmations and the live worker-attribution incident. Its top-level consolidated ranking placeholders were not yet filled, so this file serves as an additional durable synthesis rather than replacing any worker report.

No production-code fixes were made by these audit workers. Audit-only probes/repros were retained under `bughunt-2026-08-20/`.

## Highest-priority confirmed findings

### HIGH — filesystem/sandbox TOCTOU across Windows reparse/junction swaps

`src/main/sandbox.ts` canonicalizes and approves a pathname, then later tool code reopens/uses that pathname. A deterministic repo-contained repro (`repro-reparse-toctou.ts`) showed that replacing a validated ancestor with a junction after validation can redirect the later read outside the custom approved root. The same validate-then-use pattern is relevant to read, view_image, find, exec cwd and patch mutations. Prime independently reproduced the read case.

### HIGH — unresolved request identity weakens terminal isolation

`src/main/codex/ownership.ts` denies terminal access only when both caller and owner are known and different. An unresolved caller is therefore allowed to enumerate/use global live sessions; a session created while identity is unresolved can remain effectively ownerless. This is especially material because the audit itself hit prolonged `WORKER_IDENTITY_LOST` / unattributed execution.

### HIGH — unresolved workspace identity can execute or patch the wrong root

When a call needs chat/workspace identity but exact attribution never resolves, omitted exec cwd and relative apply_patch can fall back to the first approved root instead of refusing. That converts an attribution outage into possible wrong-project execution or mutation.

### HIGH — session-history requests can freeze the Electron main process

The session timeline path reads/parses the complete JSONL before enforcing small result limits, and chronology contains a quadratic path for long untagged stretches. A 250k-event (~40 MB) audit fixture requesting only one event took ~68 s and ~84 MiB extra JS heap.

### HIGH — endpoint disconnect creates ambiguous commits

Stopping the MCP endpoint destroys the response socket but does not cancel an accepted tool handler. A real local HTTP probe observed client fetch failure while a delayed side effect still committed afterward. A caller could reasonably retry after the transport failure even though the first mutation continued.

### HIGH — concurrent bridge startup can leak an untracked live listener

Two simultaneous bridge starts can bind different ports before the singleton global is assigned. One reference overwrites the other; a later stop closes only the retained instance. The audit reproduced two live ports and one remaining reachable after stop.

### HIGH — PNG validation permits large synchronous decompression amplification

`view_image` accepts compressed PNGs under the on-disk limit but does not bound decoded pixels/output before `inflateSync`. A valid ~65 KB 8192×8192 grayscale PNG expanded to ~67 MB decoded data and caused roughly +128 MiB external / +134 MiB RSS in one validation call.

### HIGH — non-PNG image acceptance is not real decode validation

JPEG/GIF/WebP validation uses structural heuristics rather than a real decoder. A tiny plausible-but-invalid WebP payload was accepted by the connector loader while an actual image decoder rejected it. This can produce a successful MCP image block containing bytes ChatGPT cannot decode.

### HIGH — read(image) bypasses the read tool's advertised byte budget

The connector advertises a 512 KiB whole-call/per-file read budget, but the image branch delegates to standalone `view_image`, which permits much larger image payloads. Small `max_bytes` is likewise not applied to that image branch.

### HIGH — exec/write_stdin structured output can bypass text truncation policy

The model-visible text result applies the default/policy token cap, while `structuredContent.output` can return the full retained raw output. A direct repro produced roughly 40k chars in text versus 240k chars in structured output for the same command result.

### HIGH — view_image duplicates full base64 payload on the wire

Standalone `view_image` returns the same image bytes in both native MCP image content and a structured data URL. At the nominal 8 MiB source ceiling this is over 21 MiB of base64 text before JSON/object overhead.

## Extension / transcript integrity findings

### HIGH — `/activity` can forget a still-open chat after app-memory restart

After recorder memory reset, exact MCP calls can continue appending to the correct durable session while `/activity?conversationId=...` returns `sessionId:null` and an empty stream. The activity route trusts the in-memory live-conversation map instead of recovering from durable chat state even though the browser poll itself proves the chat is alive.

### HIGH — provisional observations can be rebound into a later unrelated chat

Pre-`/c/<id>` observations are keyed only by tab during the provisional window. If the tab leaves the original fresh chat and later opens another fresh chat before expiry, old provisional observations can be bound under the later conversation.

### HIGH — stale dying-document IPC can resurrect tab ownership after navigation/removal

`tabs.onUpdated` and `tabs.onRemoved` cleanup can race an already-sent message from the dying page on a cold service worker. The stale content message can re-add the tab/conversation mapping before `/closed` is decided, leaving a zombie conversation.

### HIGH — stale Overwrite can hide a newly started real tool call

The renderer's sticky replacement grace can keep an older complete local stream mounted after Fiber has already exposed a new exact connector request whose MCP handler is still in flight. This suppresses ChatGPT's newer native tool row and presents stale activity instead of the current call.

### HIGH/MEDIUM — at-least-once `/events` replay is not lifecycle-idempotent

If a committed `/events` response is lost, the browser journal retries the same batch. Named `turn_start` / `turn_end` records have no event identity/dedupe, so the same lifecycle batch can append duplicate boundaries and produce duplicate renderer grouping.

### HIGH/MEDIUM — content-script pre-journal queue silently drops oldest observations

The volatile queue is capped at 400 entries and evicts from the front with no gap marker. A deterministic 401-observation probe delivered 400 and silently lost the first entry before the service-worker durable journal ever saw it.

### HIGH/MEDIUM — stale correlation snapshot suppresses durable-history recovery

If the saved correlation index is nonempty but stale, restore returns after loading it instead of reconciling newer exact request-id evidence already present in durable tool history. The retained repro still fails on the desired invariant.

### MEDIUM/HIGH — exact tool-call recording can reorder and evade the quit flush chain

Exact-conversation calls bypass the recorder chain used to preserve call order and awaited by `flushRecorder()`. Concurrent calls with asymmetric pre-append work can therefore become durable in reverse invocation order; those writes are also outside the documented flush barrier.

## Live multi-agent/extension failure found during the audit

A replacement filesystem worker was successfully bound in broker state but then its real MCP calls were recorded as Unattributed. The bound worker session recorded lifecycle but zero tool calls, while the Unattributed session contained dozens of reads/execs/patches under one request id and every attempted `agents` control call returned `WORKER_IDENTITY_LOST`.

A strong candidate root cause is the extension recovery health check: `background.js` pings only the isolated `content.js` recorder and treats a matching recorder version as full page health, skipping reinjection of MAIN-world `fiber.js`. Request-id ownership depends on Fiber. An executable audit regression demonstrates that a content-script-only “healthy” response results in zero Fiber reinjection attempts.

This candidate is strongly supported by code, repro and the exact live symptom, but the original worker tab was not instrumented deeply enough to prove that missing/stale Fiber was the live incident's only cause.

## Additional confirmed defects

- Native Windows paths containing `..` are normalized by `path.resolve()` before the connector's explicit traversal-segment rejection, so native and virtual spellings receive different security decisions. Containment still blocks the demonstrated case, but the invariant is inconsistent.
- Intercepted `cd missing && apply_patch` can execute the patch and create the missing workdir instead of honoring the shell's failed-`cd` gate.
- Uncommon filesystem errors such as ELOOP can leak the full native approved-root path through unsanitized error text.
- Main→renderer state pushes can overwrite a focused unsaved settings field; a jsdom probe reproduced the clobber while focus remained on the input.
- `write_stdin` Ctrl+C can race a just-exited successful pipe process into a false `kill ESRCH` failure; the next empty poll returns the actual successful final output.
- Worker bootstrap can steal foreground focus; user keystrokes landing in the new worker composer can cause bootstrap prompt insertion to be refused, after which a replacement tab can immediately steal focus again.

## Verification / false-confidence evidence

- Extension/transcript final relevant suite: 5 files passed, 355 tests passed, 82 skipped, while the above deterministic race/replay/loss findings remained reproducible.
- MCP/Electron focused suite: 5 files passed, 193/193 tests passed, while the large-session freeze, endpoint-stop ambiguity, bridge-start race, renderer clobber, Ctrl+C race and PNG amplification remained reproducible.
- Filesystem/Codex focused suite: 6 files passed, 230 passed / 1 skipped, while all ten ranked findings in `worker-filesystem-codex.md` remained present.
- Prime full suite observation: 1009 passed, 83 skipped, 2 `WINDOW_NOT_FOUND` failures; immediate isolated rerun of those two passed, so they were classified as likely environment/order-sensitive flake rather than promoted to a production finding.

## Retained audit artifacts

Important retained probes/repros include:

- `repro-reparse-toctou.ts`
- `repro-view-image-gap.test.ts`
- `repro-error-path-leak.ts`
- `repro-exec-structured-cap.ts`
- `repro-correlation-stale.test.ts`
- `repro-fiber-health-gap.test.ts`
- `probe-bridge-race.test.ts`
- `probe-mcp-stop-inflight.test.ts`
- `probe-renderer-state-clobber.test.ts`
- `probe-session-tail.test.ts`
- `probe-view-image-inflate.test.ts`
- `png-inflate-probe.png`

The detailed code references, exact reproduction mechanics, error logs, missing-test notes and unresolved gaps remain in the three worker reports and `MASTER.md`.
