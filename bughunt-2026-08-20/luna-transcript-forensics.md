# Local transcript forensics — 2026-08-20

Read-only reconstruction from `%APPDATA%\\chatgpt-local-files\\sessions` and the retained `bughunt-2026-08-20` reports. Times below are the JSON epoch times rendered in Europe/Berlin (CEST, UTC+02:00); the recorder mixes event-observation time with session metadata time, so an event can precede the `meta.startedAt` of the later session that eventually stored it. Message text is reduced to symptom statements only.

## Executive finding

The user’s recurring failure was not a random failed spawn. In the 20 Aug multi-agent run, the prime correctly opened/bound workers, and worker-5 had a stable MCP `request_id`, but Fiber-derived page evidence disappeared. Consequently the worker’s MCP calls were filed in `2026-08-20-831d7354` (`Unattributed activity`) while the broker still considered the worker bound. The prime then received no worker progress, the turn was marked stalled, and stale-worker cleanup became possible. This is the earliest wrong transition: **content/background health remained “healthy” while MAIN-world Fiber request evidence was absent**. The consolidated report identifies this as A1/A2/A3/A4; the current dirty-tree changes appear to address several adjacent findings, but the Fiber-health blind spot and its full cascade remain unresolved.

## Timeline and exact recordings

### Prior resumed audit: `2026-08-20-bb122e68`

- Title: `Resumed · Search connector bugs`; `meta.chatIds`: `6a86bdde-6acc-83ed-a167-8c4778da993c`, `6a86cc35-0e4c-83eb-aac9-9e0d14e4c16e`; 491 events, 319 tools, 22 errors.
- 10:43:38, event 11: prime `agents` spawn, request id `73d8f3c4-f2a3-41b1-be18-e7e11893fcda`.
- The transcript includes an interrupted turn at event 30 (10:44:27), then completed/unknown turn transitions at events 70/77 and 98/105. This is evidence of silent/interrupted-turn behavior around long tool work, not proof of a connector crash.
- The user’s later complaint was that the assistant “stopped for no reason”; the audit found the last successful tool return followed by a dead gap and a later `interrupted` marker, with no recorded `chat_error`/progress failure. This is consistent with a lifecycle/visibility gap rather than an active tool still running.
- This session also contains the native-path episode: the model first received a virtual-path rejection (operator invocation mismatch), then the user explicitly requested native Windows path normalization and version 1.8.5. The later resumed transcript still reproduced installed 1.8.4 `exec_command.workdir` rejecting `C:\Users\\...`; this is historical context, not the main current attribution incident.

### Prime bug-hunt: `2026-08-20-bb3efcfc`

- Title: `hey bro launch 3 sub agents to go bug hunting in the connector app. ultrathink.`; chat `6a86ccfb-95bc-83eb-ac45-735bab2599e8`; 177 events, 132 tools, 6 errors.
- 11:47:41 event 13: prime spawned three workers under request id `e1f6c339-eb35-44cc-8cff-20eececb3175`. The task strings visibly used the old `You have ZERO prior conversation context` prefix. The prime retried worker-1 at event 33 and again at event 56; it messaged worker-2/3 about the live bootstrap failure at events 52/55.
- User-observed bootstrap failure, recorded in the prime messages: a worker tab opened while the user was typing in the original chat; focus moved to the new tab; the replacement worker failed with exact text `the browser could not start the chat — ChatGPT refused the inserted text`. This is a real focus/insertion race (A14), distinct from request attribution.
- 11:53:07 event 65: user reports the Local Files desktop app shows tool activity but the ChatGPT extension/Overwrite stream shows no current or stale activity. Event 99 records a temporary run of two previously skipped content-script cases; both failed to emit expected progress (new section after STOP and commentary-only section). This is A12 generation binding and A13 sticky Overwrite grace, not simply `/activity` delivery.
- Worker-5 was successfully created as session `2026-08-20-5a2e6c1e` (chat `6a86ce29-3f14-83eb-9d1c-1ff4a7b84608`) but has only 8 events, 0 tools, 1 error; its sole event says identity was lost. Worker-3 was session `2026-08-20-43c3c778` (chat `6a86cd3b-796c-83eb-b0bf-d4ada98754a8`) with 107 events/83 tools/4 errors; worker-2 was `2026-08-20-ed1ff986` (chat `6a86cd38-a44a-83eb-92cc-27c7d3302277`) with 120 events/90 tools/13 errors. Thus worker creation/binding and worker tool execution were not uniformly failing.
- Event 107/103 records the prime warning worker-5 to preserve its report after `WORKER_IDENTITY_LOST`; this is explicit evidence that the broker had a worker slot while exact caller attribution was unavailable.
- Event 191 (12:03:24) marks the prime turn `stalled`, detail `no visible output and no progress for ten minutes`, even though the separate Unattributed journal contains active calls at this time. This is the false-stall cascade.

### Separate Unattributed recording: `2026-08-20-831d7354`

- Title `Unattributed activity`; no `chatIds`; 253 events, 252 tools, 11 errors.
- Events 2 onward (09:47:59–11:12:00 observation range) are MCP calls with `attribution=unattributed`. The session has no trustworthy conversation owner by design.
- The consolidated forensic report identifies 67 calls from worker-5 in this session, with a stable request id, zero corresponding `page_tool` events, and no entry for that request id in durable `request-correlations.json`. This rules out “wrong request id” as the primary explanation for this incident: the id was present on calls, but the page-side mapping was never learned.
- The user’s direct symptom message in this recording says the chat opened but all work landed in Unattributed; a new tab opened while typing, another worker did not launch; later the extension failed to show the work. These are separate visible manifestations of the same browser lifecycle/identity boundary failure.

### `Create Agent Guide`: `2026-08-20-47bbc9b2`

- Chat `6a86d6e1-adb4-83ed-9d3d-9737e099e38e`; 27 events, 22 tools, 1 error. All recorded tool calls use request id `7154bf15-7de9-40e8-af4a-df560c20cfc6` and `attribution=request_id`, so this chat is a control comparison, not an Unattributed failure.
- The session did perform an `apply_patch` (event 25) and subsequent verification commands (26–28). The assistant claimed the agent documentation was corrected; the recording proves a patch call occurred, but the claim’s exact final content is not inferred here.

### Current continuation: `2026-08-20-b4cbfa46` (“Audit progress and files”)

- `meta.conversationId`: `6a86d388-51d4-83eb-9f62-b4e2a213e5dd`; `startedAt` 11:41:31, `updatedAt` 12:00:21 CEST; 168 events, 101 tools, 0 errors. `meta` says 20 user messages, but event observations include times as early as 11:15:56. This is an important authored-vs-observed/replayed ordering discrepancy; do not use directory update time as message authorship time.
- Calls in the durable event stream use request id `6f87e4eb-402c-4baa-a189-6035e4e00611` and `attribution=request_id`, conversation `6a86d388-51d4-83eb-9f62-b4e2a213e5dd`, showing that the current prime chat’s identity path was healthy for the recorded desktop actions.
- The user subsequently reports another launch in which only roughly 50–66% of workers were created and one worker’s calls all went Unattributed, explicitly suspecting extension request-id transfer. This is a user-authored recurrence report at event/message seq 372 (stored observation around 11:54:31); it aligns with the worker-5 evidence above, but does not by itself identify whether the immediate trigger was reload, Fiber loss, or tab/document replacement.
- The transcript contains repeated Compact & Resume handoff messages and assistant summaries. Those are historical lineage, not proof that every claimed fix shipped; only recorded tool calls and retained reports are implementation evidence.

## Cross-reference to retained findings and dirty-tree state

The retained `00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md` (especially sections 1.1–1.8, A1–A14, M1–M6, F1–F10) confirms the above and should remain the primary forensic source. It states:

- A1/A2/A3/A4: worker identity split-brain, content-only health check, sticky `fiberPresent`, and active-work→false-stall/stale eviction.
- A5: stale nonempty correlation snapshot suppresses durable-history reconciliation (`repro-correlation-stale.test.ts` still reproduced during consolidation).
- A6–A11: `/activity` restart split-brain, provisional same-tab misbinding, delayed old-document zombie resurrection, duplicate lifecycle retry, silent queue loss, and exact-call recorder reordering.
- A12/A13: skipped generation-binding regressions and stale Overwrite replacement mounting while a new exact call is live.
- M1/M2/M3: session-history freeze, concurrent bridge startup listener leak, and ambiguous MCP disconnect commit.
- F1 remains a reproduced Windows junction/reparse TOCTOU; F2/F3 fail-open unresolved identity/first-root behavior remain security concerns.

The user-visible/assistant-reported changes in `Audit progress and files` appear to address or probe: stale correlation recovery, Fiber health recovery, concurrent bridge startup, session-history tail performance, renderer dirty-field clobber, stale Overwrite on new call, lifecycle replay dedupe, image wire-size/decode handling, and self-contained worker prompt guidance. The recording proves some focused commands/patches and the retained reports prove the probes, but it does **not** prove a live browser run after all changes. The consolidated report explicitly says Fiber-loss recovery still has a failing regression and junction TOCTOU remained unfinished.

## Remaining unresolved logic / next verification

1. Make health prove a live MAIN-world Fiber round trip; reinject/recover when the helper disappears after a previously healthy answer. Do not let `content.js` health or sticky `fiberPresent` imply request ownership.
2. On missing exact correlation, fail closed for agent identity, inbox, terminal ownership, workspace and liveness; do not continue useful work as Unattributed and later infer a dead worker.
3. Add document/navigation epochs and terminal tombstones so delayed dying-document activity cannot resurrect a tab/chat; make `/events` retries idempotent and prevent silent pre-journal eviction.
4. Re-run the two Overwrite generation-binding regressions with current source and verify a real page reload/new-section sequence; current focused green suites are insufficient because the relevant cases were skipped or adversarial.
5. Finish/retest F1 junction/reparse TOCTOU and M3 accepted-mutation shutdown semantics. These remain unresolved even if the current dirty tree contains adjacent fixes.

## Evidence boundaries and uncertainty

- `meta.startedAt`/`updatedAt` describe durable session projection updates, not necessarily authored message times. Event `time` values are observation times and can be out of order after replay/continuation merges.
- A worker session with 0 tools does not prove it never opened; it proves no tool calls were durably attributed to that session. The paired Unattributed stream is the stronger evidence for worker-5’s actual work.
- The recordings establish the Fiber/request-evidence failure signature with high confidence; they do not prove the exact browser trigger (service-worker sleep, page reload, stale/missing Fiber injection, or document replacement) for every recurrence.
- No production code, tests, AppData recording, or existing report was edited for this investigation; this file is the only new artifact.
