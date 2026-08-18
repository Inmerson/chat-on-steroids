# Live smoke findings for current Claude C2 batch

Do not treat the ChatGPT renderer as the first problem. The authoritative local session stream is still wrong on disk.

## Hard evidence from the current live chat

Conversation session: `2026-08-16-f04ab0f6`, conversation `6a8207f1-755c-83eb-9f42-3ae0d821fd71`.
Simultaneous same-chat leak: `2026-08-16-2ce13b31` (`Unattributed activity`).

1. **Current turn exists while same-chat calls still go Unattributed.** Main seq 137 starts turn `...-10`, seq 138 stores the user message, seq 139/140 stores progress under `...-10`. At the same time Unattributed lines 57–65 stores this same turn's `screenshot`, `computer`, `list_windows`, `get_window_state`, etc. as `attribution:"inferred"` with no turn.
   - Recommendation: named Fiber evidence remains highest confidence, but if exactly one live connected generation is eligible at `startedAt`, use it as a lower-confidence `live_generation` attribution rather than permanently creating Unattributed. Keep ambiguous multi-chat cases unattributed.

2. **Old turn identity leaks into later turns.** Main seq 128, 130/131, 133/134, 141, 143–149 are `page_tool` events carrying old turn `...-6` while actual current turns are `...-9`/`...-10`.
   - Root direction: introduce a local generation key on generating false→true and bind DOM/Fiber turn later. Do not use whichever stale assistant section React leaves newest.

3. **Progress ids leak across generations.** Main seq 129/132 (`turn ...-9`) and 139/140 (`turn ...-10`) reuse `progressId=request-...-6#p0`. The DOM stamp `data-clf-progress-id` survives when React reuses the node.
   - Recommendation: do not make the DOM attribute globally authoritative. Use generation-scoped identity (e.g. WeakMap node→{generation,id}) or clear/reassign stamps at generation boundary. `foldProgress` must key by generation+progress id, not progress id alone.

4. **Progress source text is already corrupt before rendering.** seq 132 and 140 contain concatenated duplicate prose (`...smallYep bro...`, repeated sentence). `recordProgress` cannot fix a malformed single line by line-union dedupe.
   - Recommendation: capture narrowly scoped authored commentary/message text; do not aggregate mutable reasoning containers. Fix source snapshot first.

5. **`page_tool` IDs are unstable and duplicate the same semantic item.** `Documented tool call and harness issues` stored at seq 128/131/133 with different index-based ids. `Waited for reliable evidence` stored twice; `Inspected CLF application...` stored three times.
   - Recommendation: never include mutable DOM array index in semantic identity. Prefer Fiber request/result message id; otherwise create one generation-local occurrence id when first seen and retain it through reorder/reparenting.

6. **Local connector activity is being misclassified as ChatGPT-native `page_tool`.** `reportPageTools()` calls `toolBlocks(...).filter(!isConnectorBlock)`, while `isConnectorBlock` only checks the current `[aria-label="Open tool call list"]` DOM control. Relabeling/collapse/React replacement can remove that control, making a TobisComputer row look native.
   - Recommendation: classify local vs native from Fiber `/TobisComputer/...` / `invoked_resource.app_name`, persist classification, and make `page_tool` mean *provably non-local*, not "connector marker currently absent".

7. **Desktop UI then presents those `page_tool` labels as `ChatGPT:` speech.** Current UI visibly showed `ChatGPT: Documented tool call and harness issues` twice and repeated `Waiting for reliable evidence` rows. Tool captions must not be conflated with authored assistant commentary.

8. **Tool chronology model is structurally lossy.** A tool is appended only when result is available, but `BaseEvent.seq` is the declared sole ordering authority while `time` is backdated to `startedAt`. A slow tool therefore lands after later prose even though invocation happened first.
   - Recommendation: create a pending/start event at invocation with stable call id and anchor seq, then append a completion/supersession update to the same row.

9. **Be careful with the current `messageIds: Map<string,string>` mitigation.** It can help when ChatGPT reuses the fallback `assistant:<turn>` id with different text, but a single Map value per id does not remember *all* historical `(id,text)` pairs. On reload, older different texts can be re-admitted. Better immediate mitigation is a Set of composite `(id,textHash)` keys; correct long-term fix is generation-scoped stable message identity.

## Tool API / harness recommendations

Full details: `TOOL_CALL_ISSUES.md`. Highest-value changes:
- direct file tools should be the default; add log tail/structured JSONL querying and recursive/batch delete so models do not fall back to PowerShell for normal repo work;
- window screenshot/UIA inspection should not require foreground focus; separate capture from input focus;
- add reliable `activate_window`; current `FOCUS_FAILED` makes even the recovery focus action fail;
- normalize PATH/executable discovery (`git`, `where.exe`, `powershell.exe` failed ENOENT in live runs);
- classify process start/non-zero/ENOENT/refusal correctly (`inspect_repo` once said outcome ok despite git ENOENT);
- make `apply_patch` the obvious primary editor; `edit_file` should return near-match context on mismatch instead of forcing read→retry churn;
- first-class hidden/visible managed TTY lifecycle for Claude Code instead of forcing interrupt/resume just to move it into a visible terminal;
- accept/normalize approved Windows paths and `/totec/...` virtual paths consistently, or return an exact conversion hint;
- long waits should use wait/process primitives, not 30s `computer` batches.

## Acceptance gate

Before any renderer polishing: one fresh chat, 30+ mixed tool calls including intentional failures + one reload + another ChatGPT tab open. The single local session must contain every user message, visible assistant/commentary item, and local tool call exactly once and chronologically; zero same-chat Unattributed leakage; zero cross-chat theft; no duplicate/stale-turn events.

## Review note on the patch currently being written

I watched the current edits through the Claude transcript. The new `generation` attribution grade is directionally right and matches the live evidence. Three partial-fix traps remain worth checking before calling the batch done:

- `messageIds: Map<id,fingerprint>` remembers only the *latest* fingerprint for a reused id. If fallback assistant id `assistant:<stale turn>` is reused by many different answers, a full-page reload can walk older answers again and re-admit them because the map no longer remembers all historical `(id,text)` pairs. If this mitigation remains, use a bounded Set/Map of composite `(id,fingerprint)` occurrences, or preferably eliminate reused fallback ids via generation-scoped assistant identity.
- `recordPageTool()` supersedes only when `messageId` stays the same, but the live duplicates had **different** ids because `reportPageTools()` builds `page-tool:<turn>:<index>:<hash(label)>`. The recorder cannot dedupe what the extension renames on every reorder/label change. Fix identity/classification at the extension/Fiber source, not only the recorder.
- `recordProgress()` replacing instead of unioning prevents exponential compounding, but live seq 132/140 proves the *incoming snapshot itself* already contains duplicate prose. Source extraction still needs fixing (visible authored subtree / visible-text extraction, generation-scoped ids). Otherwise one duplicate snapshot simply replaces another duplicate snapshot.

Also ensure `foldProgress` cannot fold the same leaked progress id across different turns/generations, and do not postpone the stable local generation key merely because the recorder now has a `generation` attribution label.

## CRITICAL review of current `commentaryText()` edit

The just-written `commentaryText()` fix still does **not** cover the original live corruption that triggered this work. It splits `pageText(node)` only on `\n` and then does containment between those blocks. But current installed seq 15 is one single line:

`Yep bro, **that screenshot basically confirmsYep bro, that screenshot basically confirms the gate theory`

There is **no newline between raw streaming buffer and rendered copy** there. Seq 16 likewise contains same-line concatenation before later newline-separated repetitions. Therefore the new function sees that entire doubled sentence as one block and cannot collapse it.

Do not test only newline-separated duplicates. Add the exact seq15 string as a regression fixture. Prefer extracting the actually visible/rendered authored subtree instead of post-hoc string heuristics. If both raw and rendered buffers must be read, identify their DOM branches structurally and choose the visible/rendered one. A text-level fallback needs to detect overlapping repeated prefix/substring boundaries within a single line, not just across lines, and must avoid deleting legitimate repeated prose.

Also `pageToolItems()` still classifies local-vs-native using `!isConnectorBlock(block)` (current DOM marker). The stable stamped ID fixes reorders but does not fix **local connector rows being misclassified as native** when the connector control disappears. Use Fiber request/result metadata to classify where available, or persist local classification once proven.

## CRITICAL — startup/backfill chronology is already wrong before any tool merge

Direct current-session evidence, `2026-08-16-f04ab0f6/events.jsonl` lines 1–5:
- seq 1 `session_start`
- seq 2 **current** assistant `turn_start request-...-0`
- seq 3 current user message (`i installed manually...`)
- seq 4 an **older** 11k-character user message about 17.1
- seq 5 another **older** user message (`nah bro use claude code...`)

So historical transcript backfill is appended *after* the new live turn has already started. Even the current user message is stored after `turn_start`, reversing the natural user→assistant lifecycle.

The code explains it: `content.js::observe()` handles generating transition / emits `turn_start` around lines ~469–510, then only later loops `CLF_DOM.messages()` around ~534. Also assistant messages in that later loop are gated by global `!nowGenerating`; therefore while the current turn is generating, **past already-final assistant messages are also withheld**, even though they are historical and settled. They can be appended much later when the current generation stops.

Fix requirement for the authoritative local log:
- Bootstrap/backfill already-existing transcript **before** opening the new live generation in the recorder, preserving page conversation order.
- The current user message must precede its assistant `turn_start` in the session stream.
- Determine settled/final status per assistant message/turn, not from the global current `nowGenerating` flag. A current generation must not block recording older final assistant messages.
- Ideally distinguish `bootstrap/backfill` observations from genuinely live observations so a reload does not make old history look newly active or refresh session recency.
- Add a fixture: load an existing 3-turn conversation while turn 4 is currently generating; the new local session must order user1/assistant1/user2/assistant2/user3/assistant3/user4/turn4 live updates, never turn4 then historical turns.

## Review of the new local generation-key implementation

Two more live-safety traps in the code currently being written:

### `gen-<epoch>-<n>` collides across content-script reloads

`content.js` initializes `let epoch = 0` and the new code initializes `let genCount = 0`. Both live only in the content-script document. A reload/reinjection of the same ChatGPT conversation resets them, so the first post-reload generation can mint the same `gen-0-1` etc. that was already persisted earlier in this session. That recreates the exact cross-turn identity collision under a new name.

Use a document/tab-lifetime unique namespace that cannot reset to the same value (e.g. random/crypto nonce persisted in `chrome.storage.session` per tab plus monotonic counter, or a sufficiently unique local UUID per generation). If a reload happens while one generation is still active, reconcile to the existing generation where possible rather than silently minting a colliding or duplicate turn.

### `BIND_FALLBACK_MS` = 4s then "take newest assistant section" can knowingly bind the previous turn

`generationTurn()` correctly waits for a section not present in `priorSections`, but after 4s it binds `currentAssistantTurn()` even if that is still demonstrably one of the prior sections. This avoids missing commentary by replacing certainty with a guess, and can duplicate prior-turn prose/page tools under the new generation key. It no longer corrupts the *old* generation identity, but it still violates the user's hard invariant: no false attribution / no duplicates.

Better fallback evidence when ChatGPT reuses an existing section:
- snapshot prior section nodes + their message/Fiber ids/state at generation start;
- bind a prior node only when its Fiber request/message model or relevant authored subtree demonstrably changes after generation start;
- or correlate from the current user turn / Fiber request id;
- never bind a known-prior node solely because a timer expired.

If evidence genuinely cannot distinguish the section yet, keep the generation local/unbound and retain pending observations until it can; do not copy an old turn into a new one just to avoid temporary absence.

### CRITICAL — `priorSections` is sampled too late

The current new `observe()` code populates `priorSections` **inside** `if (nowGenerating && !generating)`, by enumerating `CLF_DOM.turns()` at that moment. But this is the first observation tick after the STOP button became visible; ChatGPT may already have mounted the new assistant section before the tick. In that normal ordering, the new generation's own section is inserted into `priorSections`, so `generationTurn()` considers it old and refuses to bind for `BIND_FALLBACK_MS` (4s). A fast turn can complete entirely inside those four seconds, losing its visible commentary/native tool events — exactly the class of fast tool turns that caused attribution loss in the first place.

Fix: maintain the baseline assistant-section set continuously while idle (or snapshot it on the previous non-generating observation), then freeze **that previous idle baseline** at false→true. Do not derive “what existed before generation” from the DOM after generation has already begun.

Also, logical turns can contain multiple sibling sections. `generationTurn()` currently tests only `latest.nodes[0]` for freshness and stores only that first node. If nodes `[old reused section, new sibling]` form one logical turn, the fresh sibling is ignored. Consider all `latest.nodes`; bind to any demonstrably new/changed node while retaining the logical turn as the target.

## CONFIRMED ROOT CAUSE — CLF destroys Windows PATH casing in `childEnv()`

Fresh Claude C2 evidence: its PowerShell child printed PATH as exactly:
`C:\Users\totec\AppData\Local\Programs\ChatGPT Local Files\resources\rg;`
No System32, Node/npm, Git, user bins, etc.

Exact source: `src/main/exec.ts:67-83`.

```ts
const env = { ...process.env };
...
env.PATH = `${rgDir};${env.PATH ?? ''}`;
```

On Windows environment names are case-insensitive, but `{ ...process.env }` produces an ordinary **case-sensitive JavaScript object**. The inherited real path is commonly keyed as `Path`. After the spread, `env.PATH` is therefore absent even though `env.Path` contains the full inherited path. Line 73 creates a second key `PATH` containing only `rgDir;`. The object then contains both `Path=<real full path>` and `PATH=<CLF rg only>`. Windows treats them as the same environment name when spawning; one spelling wins/collapses, and live evidence shows the CLF-only value wins. This explains the entire cluster: `npm` not recognized, `git` ENOENT, `where.exe` ENOENT, `powershell.exe` ENOENT, and visible Claude inheriting a crippled PATH.

Fix robustly:
- canonicalize inherited Windows env keys case-insensitively before mutation, especially PATH;
- read existing path by finding `Object.keys(env).find(k => k.toLowerCase()==='path')`, preserve that value, delete alternate spellings, then set exactly one canonical key (prefer the inherited spelling or `Path`);
- apply overrides case-insensitively too, otherwise an override `PATH` can duplicate inherited `Path`;
- tests MUST build a fake Windows-style env containing only `Path=C:\\Windows\\System32;C:\\Program Files\\nodejs` and verify child env contains exactly one path key and keeps both inherited directories plus rg prefix;
- test lowercase/uppercase variants and override behavior;
- consider one shared Windows environment normalizer for command/run/launch/managed process paths.

Secondary issue: `findWindowsCommandShim()` searches `process.env.PATH`, while child execution uses `childEnv()`. Command resolution and child PATH should use the same normalized environment; otherwise a shim can be discoverable in one view and absent inside the spawned process.

### PATH corruption is definitely inside CLF, not Windows configuration

Fresh `run_powershell` reads:
- child `$env:Path` = only `...ChatGPT Local Files\resources\rg;`
- machine registry PATH is healthy and includes `C:\WINDOWS\system32`, WindowsPowerShell, OpenSSH, dotnet, etc.
- user registry PATH is healthy and includes Hermes git cmd/bin/usr/bin, Hermes node, WindowsApps, `C:\Users\totec\.local\bin`, ffmpeg, Deno, etc.

So do not tell the user to repair PATH. Fix CLF child environment construction. In addition to case-insensitive canonicalization, consider a defensive Windows fallback: if inherited process Path is missing/suspiciously empty, rebuild from `[Machine Path] + [User Path]` (or equivalent registry/API retrieval) rather than spawning a crippled environment. But normal healthy parent Path should remain authoritative and should not be overwritten unnecessarily.

## CRITICAL — new `page_tool` supersession is dropped by `pullActivity()`

Current patch changed `bridge.ts` so `page_tool` supersessions are exposed with `seq: event.origin ?? event.seq`, matching progress. But `extension/content.js::pullActivity()` lines ~2072–2078 currently permits replacement of an already-held seq **only** for progress:

```js
const held = streamBySeq.get(seq);
if (held && !(entry && entry.kind === 'progress' && held.kind === 'progress')) continue;
if (held && held.text === (entry && entry.text)) continue;
streamBySeq.set(seq, entry);
```

Therefore a `page_tool` update under its original seq is immediately discarded because `held` exists and kind is not progress. The new bridge supersession cannot update the page client.

Fix the client upsert contract generically or explicitly allow both:
- progress→progress: replace when text changed;
- page_tool→page_tool: replace when label changed;
- mismatched kinds for same seq remain impossible/refused.

Do not compare `.text` for page_tool; compare `.label` or simply replace same-kind snapshots after an equality check appropriate to the kind. Add an end-to-end regression: first page_tool `Inspecting files` at seq N, recorder supersedes to `Inspected files`, bridge returns seq N, content stream has exactly one row at N with final label.

## TARGETED TEST RUN on your current working tree — 12 failed / 84 passed

I independently ran:
`electron-as-node node_modules/vitest/vitest.mjs run test/content-script.test.ts`

Result: **1 file failed; 12 tests failed, 84 passed.** This is useful because the failures separate intentional renderer gating from real generation regressions.

### Real current-generation regressions confirmed by tests

- `never records the extension-owned stream back as new ChatGPT progress` → expected `Native progress`, got `[]`.
- `records a commentary line once however many times the page redraws it` → expected commentary rows, got `[]`.
- `keeps one row when the page reparents...` → expected final commentary row, got `[]`.
- Native page-tool test expected one `page_tool`, got zero.
- `does not blame a turn for an error banner...` second turn expected `completed`, got `unknown`.

These all line up with the forensic finding: test setup commonly does `startGenerating(); assistantTurn(...); observe();` — i.e. the new assistant section is already mounted on the first generating observation. Your new code snapshots that section into `priorSections`, treats the **current** section as historical, then does not bind it. The 4s fallback never fires in unit tests and a real fast turn can finish before it too.

Fix the baseline timing, not the tests: maintain the previous idle assistant-section baseline before generation starts. Then update tests only for intentional identity semantics.

### Expected test updates from intentional design changes

- Old test expects zero `turn_start` while STOP appears before section. With the new local generation key, an unconditional local `turn_start` is intentional; update expected id semantics rather than restoring the old delayed behavior.
- Turn-end tests currently expect page ids `turn-1`, `turn-2`; local generation ids are intentional if stable/unique, so update those expectations after fixing reload collisions.
- Several `the app-owned chronological stream` tests fail because `RENDER_STREAM=false`. Do **not** simply delete that renderer coverage. Keep a way for unit tests to exercise the renderer explicitly (test-only injected flag/helper or direct pure render function) while production defaults fail-closed. Separately add tests that production disabled mode restores native ChatGPT and creates no `.clf-stream`.

### Current test suite still lacks the exact original corruption fixture

Add exact seq15 source text as a regression fixture:
`Yep bro, **that screenshot basically confirmsYep bro, that screenshot basically confirms the gate theory`

No newline exists between the duplicate copies. A newline-block deduper cannot pass this test.

## CRITICAL — the 5 failing recorder safety tests are real invariants, not expectations to rewrite

Full suite on current tree shows five `test/session.test.ts` failures because the new `generation` fallback turns calls that were deliberately `inferred` into browser-chat calls. Read these tests before updating them.

Especially:
- `will not let evidence for one tool vouch for a call to another`: active turn explicitly has named `read_file` evidence, but incoming call is `screenshot`. Current fallback still assigns it to that generation. That is false attribution, not a harmless lower confidence grade.
- `spends each named request once`: after the sole named `list_roots` request has been consumed, a second `list_roots` call is now assigned to the generation anyway. That lets one browser request effectively vouch for multiple connector calls.
- `refuses to file a call into an open chat that merely happens to be the only one`: completed generation tail is enough to steal a later foreign call.
- contested/stale-block tests similarly exist to prevent evidence being spent after it is no longer trustworthy.

The user wants **zero same-chat Unattributed leakage AND zero false attribution**. Do not achieve one by weakening the other.

Recommended architecture:
1. Treat sole live generation as a **candidate/holding hint**, not permanent proof.
2. Keep unresolved calls pending through a bounded reconciliation window.
3. If named Fiber evidence arrives and matches tool/request cardinality, commit to that generation (`turn`).
4. If named evidence exists but mismatches the tool, or all matching named requests are already spent, generation fallback must be vetoed — remain unresolved/unattributed.
5. If no named evidence ever arrives because ChatGPT truly omitted it, only use generation fallback when additional same-client evidence exists (e.g. browser/transport/request binding) and no competing source is plausible; otherwise preserve ambiguity.
6. A post-turn time tail alone is never proof. Prefer reconciling a call that **started while that local generation was active**; a call starting after turn_end should not be captured merely because it is within 15 seconds.

If the current connector transport exposes any per-browser/request/session identity in `call-context` / bridge / MCP request metadata, use that to close the gap. The clean solution is stable caller→browser generation binding, not increasingly permissive timing heuristics.

## HIGH-VALUE ATTRIBUTION PATH — `transportKey` already exists but is dropped before recorder

`src/main/mcp/call-context.ts` documents `transportKey` as a “Stable per-conversation key when the transport offers one”. `src/main/mcp/tools.ts::dispatch()` receives it from `mcpCtx?.sessionId`, stores it in `CallContext`, and the agent broker already uses transport keys. But the subsequent `recordToolCall({...})` call passes tool/args/evidence/agent/bind and **does not pass transportKey at all**. `ToolCallInput` has no transportKey field.

Investigate this before relying on timing heuristics:
- Verify on the live ChatGPT connector whether `mcpCtx.sessionId` is present, stable across calls in one ChatGPT conversation, and distinct across another browser/chat/device. Do not assume — instrument/diagnose it safely (hash/opaque equality only, never persist secrets).
- If it is stable enough, add `transportKey` to recorder input and maintain an internal `transportKey -> conversation/generation` binding.
- Establish that binding only after one authoritative named Fiber/page evidence match (or app-opened agent binding). Once proven, subsequent calls on the same transport can be attributed even when ChatGPT folds/omits the tool row.
- A mismatched named request must still veto attribution; transport binding can be invalidated/rebound only on explicit conversation transition evidence.
- Phone/other-browser calls should carry a different transport key and therefore stay out of this chat.
- If ChatGPT is stateless and transportKey is null, fall back to the pending-evidence reconciliation design; do not replace missing caller identity with a 15s post-turn guess.

This is much closer to Codex-style authoritative request/session identity: **bind caller identity once, then log locally**, rather than reverse-engineering every call from mutable DOM rows.

## Fresh live proof from the current turn after seq 470

The same failure remains reproducible hundreds of events later, so it is not limited to the original seq15 fixture. In current main session `2026-08-16-f04ab0f6`, turn `request-...-12`:

- seq 470/473/474/475 store one commentary item whose snapshot repeatedly contains concatenated copies of `Yep bro — continuing...` inside the **same event text**;
- seq 480–485 do the same for `Good direction so far...`;
- seq 491–495 do the same for `While Claude patches PATH...`;
- seq 501–506 do the same for `Interesting live result...`.

So the source extractor is still reading simultaneous raw/rendered streaming buffers and compounding them before recorder folding. This is fresh evidence for structural visible-subtree extraction rather than newline/substring cleanup alone.

The current commentary regression tests do **not** cover the actual same-line raw+rendered failure shape. `commentaryText()` first calls `pageText(...).split('\n')`, then only compares whole newline blocks for containment. The live bad value has both buffers glued inside one block (`...confirmsYep bro...confirms...`), so the algorithm never gets two blocks to compare and cannot possibly remove the duplicate. Existing tests exercise separate containers/newlines, reparenting, shrink/grow and identical redraws, but searching the test suite finds no fixture for the recorded same-line `...basically confirms...` shape.

Add a literal regression fixture built from the real failure: one commentary container whose extracted text contains raw markdown immediately followed by the rendered/plain copy without a newline. More importantly, prefer selecting the actual visible/authored rendered subtree before flattening to text; once the two buffers are flattened into one string, reliable semantic dedupe is fundamentally heuristic.

The same live turn also gives a useful positive control: current MCP `read_file`, `read_files`, and `search_files` calls (for example main seq 477, 487, 497) are correctly recorded with `attribution:"turn"` when named/Fiber evidence is present. That strongly supports preserving precise named matching and solving only the race/rowless gap; a broad sole-generation fallback would throw away evidence that already works.

### More PATH-adjacent source inconsistencies

While reviewing the confirmed PATH bug, two neighboring issues surfaced:

- `src/main/computer/index.ts::startHelper()` launches bare `powershell.exe`, so computer use has an independent PATH dependency instead of using the absolute PowerShell resolver.
- `src/main/ripgrep.ts::pathCandidate()` reads only `process.env.PATH`, while `src/main/tunnel/locate.ts` already handles `PATH ?? Path`.

Prefer one case-insensitive Windows environment/path resolver shared by exec, process management, computer helper, repo inspection and binary lookup. Fixing only `childEnv()` can leave subsystem-specific ENOENT failures behind.

### Confirmed cause of the current exec timeout + EBUSY failures

`src/main/exec.ts::terminateProcessTree()` still spawns bare `taskkill` without the repaired child environment. Under the currently inherited CLF-only PATH, `taskkill` cannot start; the helper's `error` handler resolves, but the original sleeping child is never killed. `run()` resolves only on that child's eventual `close`, so the 60-second test process outlives Vitest's 30-second limit. The same surviving process holds the temporary `clf-exec-*` directory and produces the suite-level `EBUSY` cleanup error.

Make taskkill independent of PATH (absolute System32 path is simplest), and keep a direct-child fallback if tree termination itself fails. Add a broken-parent-PATH timeout regression. This is a real harness resilience issue even if a normally launched fresh app inherits a healthy OS PATH.

Neighbor found from the same grep: `src/main/tunnel/index.ts::killTree()` still has its own bare `spawn('taskkill', ...)` and returns immediately. ENOENT from `spawn` is asynchronous, so the surrounding `try/catch` does not reliably reach the direct `child.kill()` fallback. Reuse the shared `terminateProcessTree()`/absolute taskkill resolution for tunnel shutdown as well, otherwise the exact PATH failure can leave cloudflared/tunnel children running even after exec/process-manager are fixed.

### Review note on the new `ensureUsablePath()` implementation

The current worktree version returns immediately when *any* PATH entry ends in `System32`. That is not sufficient for the computer helper's current bare `spawn('powershell.exe', ...)`: Windows PowerShell lives under `System32\\WindowsPowerShell\\v1.0`, not directly in the System32 directory. A partially damaged parent PATH containing `C:\\Windows\\System32` but omitting the PowerShell subdirectory would therefore still pass `ensureUsablePath()` and then fail to resolve the helper host.

Best fix: stop making computer use depend on PATH for its own bootstrap and launch the absolute shared PowerShell resolver result. Independently, `ensureUsablePath()` should check/add each required fallback directory rather than returning solely because System32 is present. Add a regression fixture with `Path=C:\\Windows\\System32` only.

## NEW P0 — assistant-final capture is both massively incomplete and can ingest CLF/tool UI as prose

Fresh count on the current authoritative session `2026-08-16-f04ab0f6`: there are **15 `turn_start` events but only 4 `assistant_message` events total**. So even if every MCP call were attributed perfectly, this session still cannot reconstruct what the assistant actually said.

The more serious proof is current seq 428–437:

- seq 428 starts `request-...-11`;
- seq 429 records the correct user message for that turn;
- seq 430–433 continue emitting page-tool activity under stale old turn `request-...-6`;
- seq 434 is progress for turn 11, but its `progressId` is still `request-...-6#p0`;
- seq 435 closes turn 11 as completed;
- **seq 436 records an `assistant_message` under old turn `request-...-6`, final=true, whose text is not authored assistant prose at all.** It is concatenated CLF/tool-row UI such as `▣Listed open windows ... ›_Ran Write-Output ... Command failed ...`;
- seq 437 then synthesizes/re-recovers yet another `turn_end` for old turn 6 from that polluted final.

This proves three separate failures in one contiguous live sequence:

1. final assistant extraction is reading extension/tool chrome rather than an authored prose subtree;
2. final message → generation/turn identity is stale across many later user turns;
3. reload/final recovery can manufacture duplicate old lifecycle events from contaminated content.

Acceptance requirement for local-log-first work: each completed user turn must have its authored visible assistant final (when one exists) associated with that generation exactly once; extension-owned stream/tool chrome must be structurally excluded before text extraction; recovery must be idempotent and must never resurrect an already-ended unrelated generation.

Do not treat the current `assistant_message` count as a renderer problem. The corruption and absence are already in `events.jsonl`, so this belongs in the recorder/extractor identity layer before T-68..T-74 rendering resumes.

### Confirmed source path for the seq436 fake assistant final

`extension/chatgpt-dom.js` already defines `OWN_SURFACES = '.clf-stream, .clf-stage, .clf-composer, .clf-boot'` and `stripOwn()`. Its own comment correctly says: **“Every read of assistant DOM has to do this … anything that reads the turn and feeds the result back into the stream compounds on each repaint.”** `pageText()` obeys that rule.

But `messageText(node, role)` does not obey it on its fallback path. For an assistant it first looks for clean `.markdown` descendants. If none are found, it does:

`const clone = node.cloneNode(true);` → remove a few controls → `return text(clone);`

It never calls `stripOwn(clone)`. Therefore a live assistant/message container with no clean `.markdown` authored prose can fall back to the entire node including `.clf-stream`, and the extension's own synthetic tool rows become the supposed authored assistant final. That exactly matches seq436 beginning with `▣Listed open windows ... ›_Ran ...`.

Fix direction: assistant final extraction must never fall back to arbitrary whole-node text containing unknown descendants. At minimum strip all extension-owned surfaces before any fallback. Prefer a positive authored-prose selector / message-model identity, and if no authored prose exists record **no assistant final** rather than treating surrounding tool/UI chrome as the answer. Add the exact regression: assistant container with a `.clf-stream` but no authored `.markdown` must yield empty assistant prose, never the stream text.

### Fresh review: assistant fallback still promotes commentary to a final answer

The current worktree fixes the `.clf-stream`/tool-row contamination, but `messageText(node, 'assistant')` still has a semantic hole. Its preferred `.markdown` path explicitly excludes anything under `[data-interrupted]`, which is correct: visible reasoning/commentary is recorded separately as `progress`. If no clean `.markdown` exists, however, the fallback clone strips own surfaces, buttons and tool rows and then returns `text(clone)` without removing `[data-interrupted]` roots.

Therefore a turn that streamed visible commentary but never produced final prose can have that commentary returned as the assistant message and stored as `assistant_message final=true`. This changes "commentary only / no final answer" into a fake final, which then affects completion outcome, recovery and handoff semantics.

For assistant messages, the fallback must preserve the same semantic boundary as the preferred path: remove commentary/reasoning roots (`[data-interrupted]`) before considering fallback text, or better refuse whole-node fallback unless a positive authored-final subtree is identified. Add regressions for (1) commentary + `.clf-stream` + tool rows but no `.markdown` => no assistant final, while the commentary is still emitted as progress; (2) unfamiliar assistant wrapper containing genuine non-commentary authored prose => fallback may capture that prose without controls/UI.

There is a second confirmed final-identity bug in `extension/content.js`: on `turn_end`, `settledGenerations` is set for **only `turn.nodes[0]`**, but `CLF_DOM.turns()` deliberately groups multiple sibling sections into one logical turn and later assistant lookup uses `settledGenerations.get(message.node)`. Final prose living in sibling section #2/#3 therefore misses the local generation mapping and falls back to the unsafe reused page `message.turnId`. Settle every section node belonging to the logical turn (and handle React replacement explicitly), not only the first.

### Confirmed recorder-side cause of seq437 resurrecting old turn 6

`src/main/session/recorder.ts::recordChatObservations()` computes `recoveredFinal` as simply the newest `assistant_message final=true` with any `turnId` in the incoming observation batch. It then synthesizes a `turn_end` when that turn id is absent from `explicitEnds` — but `explicitEnds` covers **only the current incoming batch**. It does not establish that the persisted session has an unmatched open `turn_start` for this identity, and it trusts the observation's turn id even though live evidence proves ChatGPT reuses those page ids.

That means a reload which discovers a newly-seen/fake assistant final with stale `request-...-6` can append another completed turn 6 even though turn 6 ended long ago. This is exactly seq436 → seq437.

Recovery should be conservative and state-based: never synthesize a lifecycle end merely because a reload batch contains a final. Require a persisted unmatched local generation/open-turn identity that the final can actually be bound to. Historical/backfill observations should not mutate current generation lifecycle. If identity cannot be proven, keep the final as historical prose (if clean) without inventing a turn end.

### Review note on the new text-change generation binding

The current worktree `sectionMark(node)` uses raw `node.textContent` length + tail and claims this cannot be changed by CLF because attributes are excluded. That is incomplete: `content.js::paint()` still calls `applyLabel()` / `applyPageLabel()` and **rewrites visible tool-label text inside assistant sections**, even while the synthetic stream renderer is fail-closed. Therefore CLF can change the raw `textContent` of an old assistant section between the baseline observation and generation binding, making `sectionMark()` falsely conclude that ChatGPT wrote the new generation into it.

Do not use arbitrary whole-section text as generation evidence while CLF is allowed to mutate text in that section. Build the generation mark from positive page-authored signals that CLF does not rewrite: clean authored prose/commentary snapshots plus structural appearance/count/identity of native/connector tool rows, or preferably MAIN/Fiber message-model evidence. A label rewrite on an already-existing old tool row must not count as evidence that a new generation owns that section. Add a test where baseline is captured, CLF relabels an old tool row, STOP appears, and generation binding must remain null until real page-authored content appears.

### Review of `sectionSignature()`: commentary-only page activity is currently invisible

The new `CLF_DOM.sectionSignature(node)` correctly avoids raw `textContent` and therefore avoids CLF's own tool-label rewrites. But it currently consists only of authored `.markdown` prose plus the number of tool rows. Live visible commentary/progress is under the outermost `[data-interrupted]` roots (`progressRoots()` / `progressLine()`), and none of that content contributes to the signature.

That creates a recorder-level gap, not merely a renderer difference. `generationTurn()` can bind a generation that reuses an already-present section only when the section's signature changes. If ChatGPT begins/continues a turn by writing visible commentary into an existing section before it emits final `.markdown` prose or a new tool row, the signature remains unchanged, `generationTurn()` stays null, and `progressUpdates()` is never called — so the local authoritative log can miss the commentary that was actually visible.

Include a clean commentary component in the page-authored signature, using the same outermost `[data-interrupted]` roots and `pageText()`/own-surface stripping already used by `progressLine()`. The signature does not need to persist the text, but a real page-authored commentary change must move it while a CLF label rewrite must not. Add two regressions: (1) baseline existing section + commentary-only change => generation binds and progress is emitted; (2) baseline old tool row + CLF-only label rewrite => generation does not bind.

### Fresh renderer review: undefined `localKeyFor()` and page-id reversal would reintroduce unsafe identity

The worktree renderer patch added `const localId = localKeyFor(turn.id)`, but an exact whole-repo search finds no definition or second reference to `localKeyFor`. This is a runtime `ReferenceError` in JavaScript and will not be caught by the TypeScript no-emit check.

Do not repair it by creating a reverse `page turn id -> local generation` lookup. `pageTurnIds` is deliberately stored as local-generation -> page-id because ChatGPT page turn ids are reused; reversing it would make multiple generations collapse onto whichever mapping happened to win. For a rendered logical turn, use section identity already available: current generation iff `turn.nodes` contains `genNode`, with local id `turnId`; settled sections can use `settledGenerations.get(node)` because turn-end seeds all logical sibling nodes. Page turn ids remain hints/legacy spellings only, never authoritative reverse keys.

### Producer occurrence hash must not be a silent-loss lottery

The new content-side `occurrenceKey()` is the right semantic change (id + what the message said), but its current text identity is one 32-bit FNV-1a value plus length. A collision means a genuinely different authored message is silently discarded in `content.js` before the recorder ever sees it. That is exactly the failure class the user's "every message exactly once" invariant is trying to eliminate.

Use a stronger deterministic identity for full text. The recorder already uses SHA-256; the content script can use a compact 64/128-bit deterministic hash implemented locally, two independent 32-bit lanes, or an exact bounded key/cache strategy. The requirement is that collision risk is negligible enough that message loss is not a plausible operational failure. Add a producer regression with reused id + distinct same-length/same-prefix answers, and keep repeated identical scans deduped.

### Review note on sticky connector classification

The new `chatgpt-dom.js::markLocalBlock()` currently has only two references in the whole extension: its definition and the fallback call from `isConnectorBlock()` after the DOM connector control is found. The new comment says the Fiber pass can prove/local-mark a row, but no Fiber path currently calls `markLocalBlock()`.

That means the sticky attribute survives mutation of the **same** DOM row, but not React replacement. If React replaces a previously-known local row after its connector control has disappeared, the replacement node has neither `data-clf-local` nor the control and can still be misclassified as page-native. `content.js` already has `fiberFor(block)` and `localConnector(block, localTools)` paths that know `seen.app === 'TobisComputer'` or `/TobisComputer/`; wire that authoritative Fiber proof into the sticky marker (or make `isConnectorBlock` consume the Fiber classification directly) whenever rows are refreshed. Add a replacement-node regression, not only a mutation-in-place regression.

### Generation fallback currently bypasses the evidence grace window

There is a second structural problem in the current recorder flow beyond the failing veto tests. `awaitSighting()` calls `pickTarget()` at the top of its loop and returns immediately whenever `target.conversationId !== null`. Because `pickTarget()` currently returns the sole live generation as `attribution:'generation'`, that weak inference becomes a terminal answer **before** `SIGHTING_GRACE_MS` has elapsed. A fast call can therefore be permanently filed into the browser generation before the page/Fiber request that names the real tool has had time to arrive and either confirm it or contradict it.

If generation liveness is retained, treat it as a pending candidate, not as equivalent to named/row/agent evidence. The grace window exists specifically because browser evidence lags tool completion. Strong evidence should be allowed to arrive for the full bounded reconciliation window; only an unresolved call may consider a weak candidate afterward, and explicit contradictory/consumed/contested/stale evidence must veto it. Prefer transport/session binding when available so even this fallback becomes unnecessary for normal ChatGPT connector calls.

## URGENT WORKTREE CORRUPTION — PowerShell rewrite mojibaked `recorder.ts`

The attempted `Get-Content -Raw` / `.Replace(...)` / `Set-Content -Encoding utf8` cleanup of `lastGeneratingAt` did not match the CRLF strings, but it **did rewrite the entire file through Windows PowerShell's text decoder**. A direct search now finds **55 `â...` mojibake sites in `src/main/session/recorder.ts`**. Examples include:

- `—` rendered as `â€”` throughout comments/log strings;
- `→` rendered as `â†’`;
- runtime truncation markers `…[...]` at roughly lines 667–668 rendered as `â€¦[...]`.

This must be repaired before treating the current worktree/tests as meaningful. Do not manually replace only the comments: restore the file's intended UTF-8 characters from git/base or a pre-corruption snapshot while preserving the intentional code edits made since, then verify no mojibake patterns remain. Avoid another whole-file PowerShell text round-trip. Use structured Edit/apply-patch or a byte-safe script with explicit UTF-8 decoding/encoding. Add this incident to the tool/harness issue list; it is a concrete reason shell text surgery should not be the default source-edit path.

### Fresh review: long-message restart dedupe mismatch

The new occurrence model still duplicates long assistant messages after recorder restart. Live recording fingerprints the full page text. `storeText()` caps long text inline and stores the original character count separately. After restart, `storedMessageIds()` rebuilds the fingerprint from only the capped inline `event.message.text`, while `fingerprint()` includes string length. The lengths differ, so replaying the identical long answer is treated as new.

Use the persisted original character count and a stable identity for the complete message rather than the length of the capped display text. Add a regression: record an assistant answer longer than `MAX_MESSAGE_CHARS`, restart/reset the recorder, replay the same page message, and assert that no duplicate is appended. The current `length + first 200 chars` identity is also lossy: two reused-id answers can share both while differing later, so a full-content digest is safer for an exactly-once log.

### Review of the new digest patch: truncated branch currently drops the digest

The new `storeText(..., { identify: true })` plumbing computes `identity = { digest: textIdentity(raw) }` and spreads it into the **short** return path, but the overflow/truncated return at roughly lines 755–760 currently returns `text`, `truncated`, `chars`, and optional `assetId` **without `...identity`**. That means precisely the long assistant answers this change is meant to make restart-stable still hit disk with no digest and fall back to the lossy legacy identity after restart.

Spread `...identity` into the truncated return too, then add the >`MAX_MESSAGE_CHARS` restart regression. Verify the persisted JSON event for the long message actually contains `message.digest`, not merely that the helper computes one in memory.

### Encoding repair left an unintended BOM

After the targeted mojibake repair, direct byte inspection shows `src/main/session/recorder.ts` begins `EF BB BF`, while neighboring `src/main/bridge.ts` and `src/main/exec.ts` begin directly with `2F 2A 2A` (`/**`). The BOM came from the Windows PowerShell `Set-Content -Encoding utf8` incident and the repair script preserved it (`bom true`). Remove that BOM as part of the source restoration and verify the first bytes match the repo's normal BOM-less UTF-8 convention.

## NEW P0 — content-side `seenMessages` still drops reused-id assistant finals before the recorder can dedupe them

The new recorder occurrence model cannot recover messages the extension suppresses upstream. `extension/content.js` still keeps `seenMessages` as a plain `Set` of message ids. In `reportMessages()` both user and assistant paths do an id-only `has(id)` / `add(id)` before emitting.

For historical/reloaded assistant prose this is unsafe for the exact reason already proven live: `settledGenerations` is an in-memory WeakMap and is empty after content-script reload, while the fallback assistant id from `CLF_DOM.messages()` is derived from ChatGPT's reused page turn id. Multiple different historical assistant answers can therefore receive the same fallback id. The first answer is emitted; every later answer with that reused id is dropped **inside content.js**, so the recorder's new `(id,text)` logic never even gets a chance to distinguish them.

Fix the dedupe at the producer too. For assistant fallback messages, dedupe by a stable occurrence identity (message/model identity if Fiber exposes one; otherwise id + full authored-text digest) rather than id alone. Keep it bounded. Add a reload regression with several assistant turns sharing the same fallback page id but different text: all different answers must be emitted exactly once, and a second identical scan must emit zero duplicates. Do not rely on `settledGenerations` for historical turns because that mapping is intentionally process-local and disappears on reload.

### Current worktree compile sanity: `MAX_MESSAGE_OCCURRENCES` is referenced but not defined

The in-progress recorder dedupe currently bounds `live.messageIds` with `MAX_MESSAGE_OCCURRENCES` at roughly line 1354. An exact whole-file search finds that symbol only at the use site and no declaration/import. Unless a definition is added, the next typecheck should fail. Add an explicit bounded constant alongside the other recorder caps and cover eviction behavior, or remove the bound until there is a defined policy.

### URGENT: the NUL repair reintroduced raw NULs through structured Edit

After the bulk byte-safe cleanup reported all three files `nul false`, the subsequent structured Edits intended to change double-escaped source strings to the normal `\u0000` source convention materialized control bytes again. Independent byte inspection immediately afterward reports:

- `src/main/session/compact.ts`: 2 raw NUL bytes
- `src/shared/session.ts`: 2 raw NUL bytes
- `extension/content.js`: 1 raw NUL byte
- `src/main/session/recorder.ts`: 0

Do not repair these with an Edit payload containing a JSON/string `\u0000` escape; that is the operation that materializes byte 0. Either choose a printable delimiter, or use a byte-safe script that writes the literal source characters backslash + `u0000`, then verify both (a) byte-level NUL count is zero and (b) runtime semantics with a unit test. The rendered diff is not sufficient evidence because it displays both cases similarly.

## 2026-08-17 live review: compaction UI, auto-compaction and transcript injection

### Do not use OS colour scheme as the ChatGPT theme source

The current in-progress popup CSS switches its copied native colours with `@media (prefers-color-scheme: light)`. ChatGPT can be forced to Light or Dark independently of the Windows/OS preference, so this can make the injected menu and tooltip use the opposite surface from the page. Keep the measured native values, but select them from the actual ChatGPT page/theme state or current composer surface. Do not depend on hashed native class names.

### Hover and click should have different native semantics

The compact control currently has a delayed hover path that opens the provider menu. The live native controls show the cleaner contract the user asked for: hover raises a small tooltip, while the chevron click opens the chooser. Remove hover-to-open for the provider menu. Do not fall back to the HTML `title` attribute. Reuse one CLF tooltip primitive for the compact button, mode descriptions and other injected controls, with focus support for keyboard users.

### Flash must stop and settle before its recording snapshot

The ChatGPT-native compaction path already stops an active turn and waits for local tools to settle. Flash currently requests compaction from the app before equivalent settling. That risks snapshotting the local recording while the old turn or its tools are still changing. Extract one shared `stop/settle current turn for compaction` primitive and run it before the Flash app snapshot. Auto-compaction must use the same primitive. A provider change must never silently skip the consistency barrier.

### Auto-compaction needs an edge trigger, not a threshold polling loop

Add explicit settings with Auto Compact off by default, a user-set token threshold, and an explicit provider choice. Flash is third-party/OpenRouter and therefore must only become the automatic provider after the user chooses it. Auto-compaction is intentionally cyclical across resumed chats. Each conversation/session generation may compact once when it crosses the configured threshold; the fresh resumed chat then starts a new cycle and may compact again when its own estimate later crosses the threshold. Prevent only duplicate/re-entrant compaction of the same already-over-threshold source chat while its compaction/resume is active or already completed. Gate on conversation/session-generation identity plus job state, and define retry behaviour after a failed/cancelled attempt.

The composer meter should read the recorder/session token estimate, not scrape visible DOM text. If that estimate is not already present in the extension activity payload, add it there together with the active auto-compaction threshold/provider so the meter and trigger use one source of truth.

### Preserve native final-answer rendering while replacing the activity stream

Do not delete/rebuild ChatGPT's final Markdown answer just to achieve chronological activity. Reparenting React-owned nodes is unsafe, while cloning them loses native event handlers/citation behaviour. The stronger architecture is to suppress the native thinking/progress/tool activity subtree, mount the CLF chronological transcript in the same visual slot, and leave the final native assistant prose component where ChatGPT owns it. That gives a native-looking result while preserving Markdown, citations and future React behaviour.

Only hide final native prose if the CLF renderer becomes a proven semantic superset. `RENDER_STREAM` is currently fail-closed for good reason: do not flip it on until the recorder's turn/generation identity and exactly-once stream pass live validation, not only unit tests.

### Tool-permission alignment

For the app settings cleanup, prefer a two-column grid for each tool row (fixed checkbox column plus text column) with row-level vertical centring. The current `align-items:flex-start` plus a manual `margin-top:2px` and translated pseudo-check is exactly the kind of compensation that creates the uneven padding/centering visible in the screenshot. Remove the compensation first, then tune one shared row gap/padding. Remove decorative inner hairlines that do not encode a real grouping boundary.

## LIVE REVIEW ? short worker-code / retirement implementation

While Claude is implementing the new agent lifecycle, two edge cases are visible in the current in-progress `src/main/agents.ts` and must be resolved before accepting the batch:

1. **Terminal-code retirement currently leaks the old hash.** `retireCredential(agent, true)` moves `agent.secretHash` into `terminalCodes` and then clears `agent.secretHash = ''`. Later `pruneExpiredTombstones()` tries `if (agent.secretHash) terminalCodes.delete(agent.secretHash)`, but the hash is already gone from the agent. The terminal map entry therefore survives the 1-hour tombstone purge. `mintCode()` excludes every hash in `terminalCodes`, so in the new tiny code space this also permanently burns codes instead of cycling them after expiry. Delete terminal retry entries by agent id (or retain a non-usable terminal hash reference solely for cleanup) on revive/purge/end-run.

2. **The global invalid-code lockout is an easy denial of service.** `workerForCode()` checks `codeLookupRefused()` before resolving even a correct live worker code. Ten wrong guesses in a minute therefore make every stateless worker code fail for the rest of that window. The comment says bound workers are unaffected, but current ChatGPT MCP transport is stateless and ordinary worker calls rely on the code. Avoid a global lockout that rejects known-valid codes; either scope misses to stronger caller evidence, use a larger code space/other throttling, or explicitly accept and test the tradeoff.

Related: the current human-friendly alphabet is 32 symbols, so 3 characters gives 32,768 possibilities. That is much smaller than a 62/64-character 3-char space (~238k/~262k). If three characters remain the product requirement, make the routing/security assumptions explicit and test collisions/reuse after the 1-hour purge.


## LIVE REVIEW ? prime identity / revive follow-up

Further in-progress review findings from the new design:

1. **Do not authorize the keyless prime with `provenConversation()` as currently wired in `mcp/kernel.ts`.** `recorder.ts::provenConversation()` explicitly documents that its evidence is for narrowing/refutation and "never on its own to authorise". It simply returns the sole conversation with any unconsumed connector-row sighting in the last `SIGHTING_TTL_MS` (60s); it is not scoped to this call, `startedAt`, or tool name. Feeding it into `Caller.conversationId` and then `resolve()` turns stale/other-chat page evidence into positive prime authorization. Safer architecture: ordinary tools do not need to identify the prime at all; worker attribution still uses the short worker code. For prime-only `agents` control operations, resolve the calling conversation from *fresh evidence for that very agents call* (the `startedAt` path already exists via `awaitFreshSighting` / named call evidence) and pass that trusted conversation explicitly. If prime messages then arrive only on `agents` status/message/revive calls rather than every unrelated file call, that matches the user's stated goal better than weakening identity.

2. **The 1-hour tombstone purge must also clean terminal finish-retry hashes.** `retireCredential(agent,true)` moves the old hash to `terminalCodes` then clears `agent.secretHash`; `pruneExpiredTombstones()` cannot later delete that terminal entry by reading `agent.secretHash`. Cleanup must be keyed by agent id or retain a cleanup-only terminal hash reference. Otherwise old three-character codes are permanently burned and `terminalCodes` grows forever.

3. **Prune expired tombstones before worker-id allocation.** `reserveWorkerIds()` only sees `agents.has(id)`. If the only call after an hour is a new `spawn`, expired tombstones should be released before reserving ids; do not require a prior `status`/`revive`/restore side effect to make expired slots reusable.

4. **Update stale model-facing text after adding revive.** `tools-core.ts` still says a worker "cannot be reopened once it finishes" in at least the checkpoint guidance/status prose. Finished workers are now revivable for one hour, so this instruction is false and can make the prime recreate work instead of using `revive`.

5. **Prime replacement is only operationally immediate if an active worker generation is interrupted, not merely told later.** `endRun()` correctly invalidates the credential first and the bridge now queues stop notices. For a worker that is actively generating, however, ChatGPT may have no composer until the turn stops; a stop notice alone can arrive too late. If the extension can safely distinguish a stop-notice continuation (`type=continue`, no agent) it should first click/trigger the worker chat's Stop control when that exact target conversation is generating, then send the notice once writable. At minimum document/test the best-effort boundary: already-started tool calls may not be cancellable, but no later worker-authenticated call may succeed.

6. **Keep the resume-output cap separate from raw history-call expansion if possible.** `MAX_RESUME_CHARS` was raised to 128 KiB and is still reused for `history(call_id)` expansion. The one-call handoff requirement does not imply every recorded raw tool call should automatically get the same larger response budget. Separate constants make the intended cost explicit and prevent fixing resume from silently ballooning forensic history results.


## LIVE REVIEW ? second-pass identity edges

1. **Use exact named per-call evidence for swarm control if available.** The new `controlCaller(startedAt)` is a major improvement over dispatcher-wide `provenConversation()`, but it currently waits on `awaitFreshSighting`, which proves only that exactly one chat rendered *some connector row* after this call began. `recorder.ts::claimNamedCall(tool, startedAt)` already has stronger evidence from ChatGPT's message model: an unclaimed request naming the exact tool, and its own comments explain why this avoids Gmail/Calendar/parallel-connector false matches. Prime takeover is destructive enough that `agents` control should prefer/require an exact fresh `agents` request when the per-call evidence stream is available, with generic-row fallback only if consciously accepted and tested. In particular, a parallel old-prime connector call must not cause a new chat's `agents spawn` to be mistaken for the old prime.

2. **Retire the old prime conversation after Compact/Resume.** `rebindPrime()` moves PRIME_ID to the resumed conversation, but the old prime chat remains a normal ChatGPT conversation. Under immediate-different-conversation takeover semantics, if that handed-off old chat later emits an `agents spawn` (for example a delayed old turn or user action), it can now look like a genuinely unrelated new prime and kill the resumed swarm. Keep the previous prime conversation id as a retired/handoff source for that run and refuse later swarm-control calls from it with a clear ?this chat handed off; continue in the resumed chat? result. A truly unrelated conversation is still allowed to replace immediately.

3. **Do not recycle a dead 3-character routing code within the same live connector/process.** After the one-hour tombstone is purged, `mintCode()` can currently choose that code again. The old worker chat still knows it, and ordinary worker calls are deliberately routed by code alone (no conversation identity in dispatcher). If that old chat calls later, the recycled code can misroute it into a different live worker. Keep a process/run-surface `spentWorkerCodes` set after terminal retry eligibility ends and exclude those hashes from `mintCode`; clear it only when the MCP endpoint/path token itself is regenerated (or otherwise when old chats cannot reach the same surface). Slot/name reuse after 1h does not require routing-code reuse.

4. **Prime inbox wording must match the new identity boundary.** Since ordinary prime read/exec/session/computer calls intentionally have no prime identity, they also cannot receive/ack the prime inbox on those results. Model text must say worker checkpoints/final reports appear on later `agents` results (or via `agents status`), not generically ?at the end of your tool results.? Otherwise the model waits for messages on calls that can no longer carry them.


## LIVE REVIEW ? critical cross-run bridge binding race

**Release blocker: stale old-worker browser traffic can currently bind a reused worker id in the new run.**

`bridge.ts` `/events` currently does `if (body.agent) bindConversation(body.agent, conversationId)` before deriving the recorded agent. `body.agent` is page/content-script state, carries only the friendly logical id such as `worker-1`, and has no run/incarnation. After a new-prime takeover, `endRun()` clears the old agents and `createAgents()` may immediately reuse `worker-1`. The still-running old worker page continues posting observations with `agent: "worker-1"` until its stop notice lands. Those old events can therefore call `bindConversation("worker-1", OLD_CONVERSATION)` against the **new** worker-1 and steal/corrupt its conversation binding.

The `/commands/ack` path has an even sharper version: it trusts `body.agent` and performs `bindConversation` / `noteAgentBootstrap` **before** proving the command id is still queued. An ACK from a stale worker tab whose command was cancelled by takeover can arrive after the new run created `worker-1`; `ackCommand()` later ignores the missing command, but the damaging binding already happened. The same bug applies to the literal `prime` id: late `/events` from an old prime/resume tab or a stale resume ACK can rebind the **new** PRIME_ID to an old conversation.

Fix the trust boundary rather than adding a timer:
- `/events` must not create/replace an agent?conversation binding from `body.agent`. Derive attribution only from a binding already established by a trusted command acknowledgement / broker state.
- `/commands/ack` must first look up the live queued command by `id`; if it is missing/cancelled, do **zero** agent/run mutation. Derive the expected agent from `command.spec` on the server, not from `body.agent`. For a continuation, also require the acknowledged conversation to equal the command's target conversation. Then bind/note bootstrap using that server-known agent.
- A fresh worker command is the legitimate place to establish the initial conversation binding; a revive continuation already has an expected target; a stop notice has no agent and must establish none; a resume rebinds PRIME_ID **only** through the explicit `rebindPrime` resume path. Do not call generic `bindConversation` / `noteAgentBootstrap` for a resume. Right now the body-agent binding runs first, so `rebindPrime()` sees the conversation already equal and returns before `unbind(prime)` / joinedAt refresh, while also leaving a stale `prime.bootstrap` candidate that the new no-key resume design no longer needs.
- Add a regression: old run has worker-1, takeover ends it, new run creates new worker-1, then a late `/events` and late `/commands/ack` from the old worker arrive. Neither may change the new worker's conversation or bootstrap state.


## LIVE REVIEW ? durable command queue needs run incarnation

**Cross-run crash/restart edge:** worker/continuation `CommandSpec` and `specKey()` are keyed only by logical `worker-N` (or conversation for continue), while worker ids are intentionally reused by a later run. `restoreCommands()` also restores durable worker commands without checking which swarm run created them. `onSpawnRequest()` then folds a current `worker-1` into any restored `worker:worker-1` command; if the task happens to be identical, the stale command id/spec can survive unchanged. A stale old tab holding that marker can then redeem the *current* worker's freshly minted join capability and bind the old conversation into the new run.

Run-scope browser commands. Include the broker `runId` (and ideally a per-worker incarnation/generation if the same logical worker can revive) in worker/continue command specs or their durable metadata/key. On restore, discard commands whose run/incarnation does not match the restored broker state. `specKey` should distinguish two different incarnations even when both are called `worker-1` and have the same task. Resume commands remain session-scoped. Add a crash-style regression with a stale durable `worker-1` command from run A plus a restored pending `worker-1` in run B; the old command id must never become run B's bootstrap.


## LIVE REVIEW ? resume commands must capture the swarm incarnation

**Release blocker: a queued resume can currently rebind whatever prime happens to exist when its ACK arrives, even if that swarm did not exist when the resume was created.**

`CommandSpec { type: 'resume' }` stores only `handoffId + sessionId`. `describe()` decides whether the command is an agent handover dynamically with `hasPrimeAgent()`, and `/commands/ack` calls `rebindPrime(conversation)` for every sent resume whenever a PRIME exists at ACK time. `endRun()` / `cancelWorkerCommands()` do not cancel resume commands.

Concrete bad sequence: chat A starts Compact/Resume while it owns run A (or even while no swarm exists) -> resume command sits queued/leased -> an unrelated chat B becomes a new prime and run A is ended / run B starts -> the old resume tab finally opens and ACKs -> current code rebinds PRIME_ID of **run B** to A's resumed conversation. The same dynamic `hasPrimeAgent()` in `describe()` can also label a resume that was created with no swarm as `agent: prime` merely because a swarm appeared later.

Fix by making swarm handover intent immutable at queue time. A resume command that is supposed to carry a swarm should capture the broker run/incarnation id at creation (`handoverRunId`, nullable). A resume created with no swarm keeps null forever. On redeem/describe/ACK, only treat it as prime handover when that captured run id still equals the broker's current run. A real takeover/endRun should cancel or render inert any queued resume associated with the retired run. Resume commands unrelated to a swarm can still open normally but must never rebind a future PRIME.

Regression: queue resume from run A, create/take over into run B before ACK, then ACK old resume. Run B's prime conversation and workers must remain unchanged. Also queue a resume with no swarm, create a swarm before ACK, and prove the ACK does not adopt that resume chat as prime.


## LIVE REVIEW ? feature-off stop test is currently a false positive

The new `test/ipc.test.ts` case named ?tells a live worker chat to stop before the bridge goes away? currently proves only that `pendingCommands()` still contains `continue:conv-worker` **after** `settings:save` returns. That is almost the opposite of delivery: `stopBridge()` does not clear the command array, so a queued-but-never-delivered stop notice survives and makes the test green even though the extension server is already gone and the live worker tab cannot fetch it.

There is a real lifecycle problem when both Session recording and Multi-Agent are turned OFF. `resetSwarm()` queues targeted stop notices; `queueStopNotice()` calls `deliver()`, but for a conversation the app already knows is live `deliver()` intentionally leaves continuation delivery to the extension so it can reuse the existing tab. If `settings:save` immediately calls `stopBridge()` in the same operation, the extension can lose the only route that would fetch that queued notice. Reordering `resetSwarm()` before `stopBridge()` is necessary but not sufficient unless delivery is actually completed or the bridge remains temporarily available.

Fix/define a graceful shutdown path: when disabling the last feature that needs the extension bridge, end the swarm while the bridge is live, then keep the bridge alive until targeted stop notices are acknowledged or a bounded grace expires (without freezing the renderer for tens of seconds). A deferred ?stop when command queue drained / deadline? is preferable to pretending queueing equals delivery. New work must remain disabled during the grace. The regression should simulate an extension fetch/ACK after the settings change and prove it can still receive the stop command before the bridge closes; merely asserting `pendingCommands()` is non-empty is not sufficient.


## LIVE REVIEW ? global MCP instructions still teach the old resume and prime-inbox behavior

`src/main/mcp/instructions.ts` is stale relative to the new architecture in two user-visible ways:

1. Session instructions still say `session action=resume` returns the handoff ?in parts? and tell the model to ?Read every part before acting.? The whole point of this batch is that ordinary handoffs now return in one call (128 KiB cap) and paging is exceptional. Change this to: resume returns the whole handoff in one call; only request another `part` if the result explicitly says the brief was split.
2. Multi-agent instructions still tell the prime that worker messages ?are appended to your tool results as they arrive.? That is no longer true once prime ordinary calls intentionally carry no identity. Worker inbox/replies can still ride ordinary keyed worker results, but the no-key prime is only established on `agents` calls, so prime checkpoints/finals must be collected on `agents` results/status. Teach that distinction globally, matching the corrected `tools-core.ts` join/spawn text.

Add an instructions-level regression so the server cannot reintroduce old model guidance while the lower-level tool result wording remains correct.


## LIVE FINDING — a reload mid-turn opens a second turn and re-records the turn's history

Session `2026-08-17-30c5be99`, from the real log, is unambiguous:

```
  3  8:17:01 PM turn_start  g-w2vck21rmu96n-1-4
 12  8:17:20 PM page_tool   g-w2vck21rmu96n-1-4  Inspected Claude Code windows and monitoring interface
 19  8:17:44 PM page_tool   g-w2vck21rmu96n-1-4  Monitored Claude workspace and key inheritance changes
 ...
 42  8:19:59 PM tool_call   g-w2vck21rmu96n-1-4          <- page reloaded here, ~8:20:19
 43  8:20:20 PM turn_start  g-6ywrgby6cavy-0-1           <- NEW turn; seq 3 never got a turn_end
 47  8:20:21 PM page_tool   g-6ywrgby6cavy-0-1  Inspected Claude Code windows and monitoring interface
 48  8:20:21 PM page_tool   g-6ywrgby6cavy-0-1  Monitored Claude workspace and key inheritance changes
 ...
 58  8:20:47 PM turn_end    (no turnId!)        unknown
 59  8:20:48 PM turn_start  g-6ywrgby6cavy-2-2           <- and AGAIN, 28s later
 63  8:20:48 PM page_tool   g-6ywrgby6cavy-2-2  Inspected Claude Code windows and monitoring interface
 68  8:20:48 PM page_tool   g-6ywrgby6cavy-2-2  Monitoring Claude Code for Editing Issues
```

One assistant turn is recorded as **three** turns, and its six commentary captions are stored
three times — twice under the reload's observation time rather than the time they happened.
The visible symptom the user reported: the injected stream appears to start at the reload
moment (every row stamped 20:20:48) and everything before it looks deleted, while the desktop
timeline still holds the genuine 8:17 rows. Both surfaces are telling the truth about a log
that has been written wrong.

Three separate defects here:

1. **`resumeOpenTurn()` is one-shot and gives up silently.** Boot order is
   `checkStatus → resumeOpenTurn → observe()`, and `resumeOpenTurn` reads `appActiveTurnId`
   from a single `pullActivity()`. If the app is not reachable/paired yet at that instant —
   the ordinary case immediately after a reload — the pull yields nothing, `appActiveTurnId`
   stays null, and the very next `observe()` mints a brand-new generation for a turn the app
   still has open. The app *did* have it open: there is no `turn_end` for seq 3 anywhere.
   Adoption needs to stay possible for a bounded window after boot, not just at one tick.

2. **Re-observed captions are recorded as new events.** Once the new generation is minted,
   every caption already on screen looks new, because per-generation keys mean
   `live.progress` / `live.pageTools` were cleared by the `turn_start` handler. Supersession
   is keyed within a generation, so it cannot see that seq 47 is seq 12 again.

3. **A `turn_end` with no `turnId` (seq 58).** It clears `live.turnId`/`turnStartedAt` and is
   written without a turn id, so it closes nothing a reader can name and no group can be
   ended by it. A turn_end that cannot say which turn it ends should not be emitted.

Not caused by the chronology work: the ordering contract renders this log faithfully, and the
log itself is what is wrong. Fixing 1 removes 2 in the common case, but 2 and 3 deserve their
own guards — a reload can also land after the app has genuinely closed the turn.
