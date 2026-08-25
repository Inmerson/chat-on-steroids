# v2 Antigravity Goal Loop and Fast Lane Design

Date: 2026-08-25
Status: design approved in chat; implementation pending written-spec review
Base: upstream Chat On Steroids v2.0.0

## 1. Purpose

Build the custom Chat On Steroids line on top of upstream v2.0.0 rather than merging the rewritten 1.9.x history. Keep the upstream v2 session, compaction, command, desktop, execution, privacy, CI and packaging fixes as the baseline, then port the custom Antigravity capabilities onto that baseline.

The resulting system has two Antigravity roles:

1. **Fast Investigator** — a bounded read-only repository investigator used by ChatGPT Prime when broad reconnaissance is likely to reduce wall-clock time.
2. **Goal Driver** — an unattended continuation model. After a real ChatGPT turn finishes, it decides either the next short user message or `NO_REPLY`. It uses the already-authenticated Google Antigravity CLI session instead of OpenRouter, so it needs no separate API key or per-request API billing.

ChatGPT remains Prime. Antigravity never owns final verification, release decisions, or direct mutation authority.

## 2. User-visible behavior

### 2.1 Automatic goals

A normal **manual** user message in a Prime or solo conversation becomes the active goal for that durable Chat On Steroids session.

If another manual user message arrives while the goal is active, it becomes a new goal revision immediately. Any draft produced for the older revision becomes stale and must never be sent.

App-generated user messages are not goals. This includes:

- a Goal Driver message typed automatically by the extension;
- a Compact & Resume bootstrap brief in the replacement chat;
- a spawned worker bootstrap.

### 2.2 Stop and restart from chat

A small deterministic local command recognizer handles explicit stop intent before any Goal Driver request. Phrases such as `goalı durdur`, `goal durdur`, `stop goal`, and `otomatik devamı kapat` stop the active goal for that session.

Stopping is session-local, not a global product setting. The next ordinary manual user message automatically creates a fresh goal revision and resumes unattended operation.

No model is asked whether a stop command means stop.

### 2.3 Unattended continuation

After ChatGPT finishes a completed turn and the upstream settle barrier proves the turn is really over, the Goal Driver receives a bounded transcript containing only:

- authored user messages;
- final assistant answers.

It never receives MCP tool arguments/results, file contents captured by the recorder, interim commentary, secrets, environment variables, or browser evidence.

The Goal Driver returns exactly one of:

- `NO_REPLY` — the active goal is complete and automatic continuation stops;
- one short next-user message — the extension types and sends it automatically.

A Goal Driver failure never fabricates a message. The loop pauses visibly and can recover on the next manual user message or a safe retry path.

### 2.4 Context rollover

The active goal is keyed by **durable session id**, not ChatGPT conversation id.

When the existing upstream automatic-compaction threshold is reached, goal continuation yields to Compact & Resume. It does not generate another ordinary follow-up while compaction owns the chat.

The upstream continuation transaction moves the same local session to the replacement conversation. Because the active goal belongs to the session, the replacement chat inherits the same goal revision without reconstructing it from the bootstrap text.

The Compact & Resume bootstrap message is explicitly classified as app-generated and therefore does not replace the active goal.

Once the replacement chat settles and is attached to the same session, unattended Goal Driver operation resumes.

No separate context threshold is introduced; the existing configured automatic-compaction threshold remains authoritative.

## 3. Architecture

### 3.1 Baseline strategy

Do not merge or rebase the old custom history onto the rewritten upstream history. The implementation branch starts at current `origin/main` v2.0.0 and ports custom features deliberately.

Upstream v2 remains authoritative for:

- session `search/read` and cursor semantics;
- recorder and conversation correlation;
- Compact & Resume, resume gate and durable rebind;
- command queue / worker lifecycle;
- Codex unified exec and exec recovery hints;
- toolchain discovery;
- apply-patch safety fixes;
- desktop frame/helper safety;
- tunnel environment scrubbing;
- privacy verification, hooks, CI and packaging.

Do not reintroduce upstream-deleted parallel runtimes such as the old connector-native process manager or patch stack.

### 3.2 Antigravity runtime

Introduce one shared bounded Antigravity CLI runtime used by both custom roles.

Common properties:

- executable: installed `agy` CLI found through a bounded Windows locator;
- authentication: existing Antigravity cached account/session only;
- no Gemini API key and no paid provider fallback;
- fixed model initially: `gemini-3.7-flash-low`;
- low effort;
- bounded stdout/stderr;
- bounded wall-clock timeout;
- process-tree termination on timeout/budget breach;
- host-path sanitisation before model-facing output;
- no secrets copied into prompts or child environment beyond what `agy` itself needs from its normal cached installation state.

The two roles have separate prompts and working-directory policy.

#### Fast Investigator

Port the existing read-only investigator behavior to v2:

- `--mode plan` plus sandboxing;
- approved workspace as cwd;
- project reuse/registration where useful;
- soft tool target and hard tool-call cap;
- observed-file evidence derived from actual tool events;
- advisory result only;
- deterministic Delegation Router blocks trivial work, mutation requests and final verification before `agy` starts.

Expose `agents action=investigate` in the v2 Core surface while preserving upstream `spawn/message/status/finish` semantics.

#### Goal Driver

The Goal Driver must not inspect a repository at all. Run it from an app-owned empty/scratch working directory and provide all permitted context in the prompt. Use plan/sandbox mode as defense in depth even though no repository evidence is needed.

The Goal Driver has a tighter output contract than the investigator:

- one short user message or exact `NO_REPLY`;
- reject empty, oversized, malformed or protocol-contaminated output;
- no tool-derived evidence is accepted as part of the reply;
- a bounded timeout substantially below the existing three-minute OpenRouter ceiling unless live testing proves that insufficient.

### 3.3 Goal state

Add durable session-scoped goal state, conceptually:

```ts
interface ActiveGoalState {
  sessionId: string;
  revision: number;
  status: 'active' | 'stopped' | 'complete' | 'failed';
  text: string;
  sourceMessageId: string;
  updatedAt: number;
  consecutiveAutoTurns: number;
}
```

Only an authenticated/local browser event tied to the session may update this state.

Revision is the stale-result fence. Every asynchronous Goal Driver request captures the revision it started for; its result is discarded if a manual message, stop command, navigation/rebind state change, or another authoritative transition changes the revision before send.

The state survives app restart and Compact & Resume, but it does not cross into another unrelated durable session.

### 3.4 Manual versus automated message provenance

The extension is the producer that knows when it typed a Goal Driver reply. Preserve that fact explicitly instead of guessing from message text later.

The browser-to-app protocol will distinguish at least:

- manual authored user message;
- Goal Driver generated user message;
- app bootstrap/resume message.

A manual user message updates goal state. The other two do not.

The exact wire representation may be an explicit provenance field on the existing recorder message event or a narrowly-scoped goal/manual bridge operation, whichever integrates with current v2 recorder invariants with the smaller protocol surface. Implementation must choose one and test both producer and consumer together.

Text equality alone is not an authority boundary and must not be used to decide provenance.

## 4. Goal turn flow

1. User manually submits a message.
2. Extension records it with manual provenance.
3. App resolves the durable session and creates/updates `ActiveGoalState`, incrementing revision.
4. ChatGPT runs normally. Prime may use Fast Investigator according to the router.
5. Upstream turn lifecycle reaches a real terminal boundary and its settle barrier holds.
6. Before drafting, the page/app checks:
   - this is Prime or solo, never a worker;
   - active goal exists and is `active`;
   - no Compact & Resume transaction owns the chat;
   - the turn/revision has not already been handled;
   - the turn completed with final answer text suitable for goal evaluation.
7. App builds the privacy-bounded authored transcript from durable session data.
8. Goal Driver runs under the captured session id + revision + turn id.
9. On `NO_REPLY`, app marks the goal complete for that revision and sends nothing.
10. On a valid message, the extension receives the one draft, records a local spent-token receipt, types it, sends it, and acknowledges it exactly once.
11. That generated user message is recorded with Goal provenance and therefore does not replace the active goal.
12. The next ChatGPT turn repeats the flow.

## 5. Concurrency and failure invariants

The following must hold:

- **One draft per finished ChatGPT generation.** Reload/retry does not duplicate a send.
- **One active goal revision per durable session.** A later manual message invalidates all older work.
- **One browser document owns typing a draft.** Preserve upstream client ownership and lost-ACK protections.
- **Workers never run Goal Driver.** Existing prime/worker identity remains authoritative.
- **Compaction wins over ordinary continuation.** No Goal Driver message is sent while a continuation transaction is opening/capturing/moving the session.
- **A stale asynchronous result cannot send.** Revision + conversation/navigation epoch + draft token are checked at the last possible moment before typing.
- **Restart is fail-closed.** Durable active goal may survive, but no old unacknowledged draft is blindly re-sent without existing ownership/idempotency evidence.
- **Provider failure is not a user message.** Timeouts, CLI auth failure, malformed stream, oversized reply or tool errors become visible paused/failed state.

A bounded runaway guard is required. Default design: after **32 consecutive automatically generated user messages for one goal revision**, pause that goal and require a manual message to create a new revision. Compact & Resume does not reset this count. `NO_REPLY` resets by completing the goal. This guard protects against a model that never recognizes completion while still allowing long unattended tasks.

## 6. Chat and settings UI

Retain upstream's Goal panel and settle/send UX, but remove OpenRouter-specific requirements from the custom build:

- no OpenRouter API-key requirement for Goal;
- no OpenRouter model catalogue/picker for Goal;
- display provider/model as `Antigravity · Gemini 3.7 Flash Low`;
- show active/stopped/complete/failed state and current short goal text where space permits;
- preserve a visible Goal master switch, but the custom deployment enables it for the user's configuration;
- normal manual messages create/update the session goal automatically while the master feature is enabled;
- stop-from-chat is session-local and does not globally turn the feature off.

OpenRouter secret storage may remain for unrelated future compatibility only if some other live feature still uses it. Dead Goal-only OpenRouter request/catalogue code should be removed rather than kept as an unused second runtime.

## 7. Privacy and security

The upstream v2 privacy boundary is preserved and tightened for the new provider:

- Goal prompts contain only user-authored messages and final assistant answers plus the active-goal instruction.
- No MCP tool calls/results, files, browser evidence, local paths, environment values or secrets are included.
- Goal Driver cwd is app-owned scratch space, not the project workspace.
- Fast Investigator remains read-only advisory and cannot perform final verification.
- ChatGPT Prime remains responsible for mutations, tests, release decisions and security-sensitive conclusions.
- `npm run verify:privacy` is mandatory before commit/push.

The Goal Driver may cause ChatGPT to continue using whatever permissions the user has already granted to ChatGPT through the app. Therefore stop handling, provenance, revision fences, worker exclusion, context rollover ownership and runaway bounds are treated as security-sensitive control-plane behavior and require negative tests.

## 8. Testing strategy

Implementation follows TDD. Minimum deterministic coverage:

### Antigravity runtime

- fixed Flash Low model and bounded invocation;
- no paid fallback/API key;
- timeout and process-tree termination;
- stream parsing and output bounds;
- Goal Driver runs in scratch cwd, not project cwd;
- investigator tool budget and observed-file evidence.

### Goal state

- first manual user message creates revision 1;
- later manual message increments revision and replaces goal text;
- generated Goal message does not update goal;
- resume/bootstrap message does not update goal;
- stop phrase marks goal stopped without invoking Antigravity;
- next manual message after stop creates a fresh active revision;
- state follows session rebind across Compact & Resume;
- unrelated session cannot inherit it;
- restart restores only durable state, not unsafe send authority;
- 32-message runaway cap pauses the goal.

### Race tests

- draft starts for revision N, manual message creates N+1, N result arrives: nothing is sent;
- draft becomes ready, compaction starts before typing: ordinary draft is not sent;
- old conversation result arrives after resume to a new conversation: discarded;
- lost ACK/reload does not duplicate an already sent automated message;
- worker conversation cannot start Goal Driver even when global Goal is on.

### Browser/integration

- real terminal turn -> settle -> draft -> auto-send -> ACK path;
- `NO_REPLY` produces no composer send;
- explicit stop chat command halts the loop;
- context threshold triggers existing Compact & Resume and the same active goal continues in the replacement chat;
- extension/app protocol version remains synchronized.

### Release gate

- nearest suites while developing;
- `npm run verify`;
- `npm run build`;
- production dependency audit at high severity;
- packaged runtime smoke on x64;
- installed app/extension version compatibility;
- live local MCP smoke for investigator routing;
- live browser smoke for one automated Goal continuation and one Compact & Resume continuation where feasible.

## 9. Migration sequence

1. Work from the clean v2 branch based on current `origin/main`.
2. Preserve all upstream v2 fixes; do not merge the old custom branch wholesale.
3. Add shared Antigravity runtime and port Fast Investigator + Delegation Router.
4. Refactor the upstream Goal engine to use the Antigravity Goal Driver instead of OpenRouter.
5. Add durable session-scoped active goal/revision state and provenance.
6. Wire manual goal update, local stop commands and generated-message exclusion.
7. Coordinate Goal with existing Compact & Resume using session identity and current transaction state.
8. Remove Goal-only OpenRouter UI/request/catalogue dependencies.
9. Run full verification, package, install and live-smoke the custom v2 build.
10. Only after this baseline is green, port additional custom Steromi/power-tool surfaces that still add value on top of v2; do not resurrect upstream-deleted parallel runtimes.

## 10. Non-goals

This phase does not:

- use Hermes;
- add Gemini API billing or another paid fallback;
- allow Antigravity to edit source as a Goal Driver;
- make Goal run inside worker chats;
- replace the upstream session/continuation architecture;
- merge the rewritten v1 history into v2;
- port every old custom tool before the v2 Goal/Fast Lane baseline is stable.

## 11. Success criteria

The design is complete when a user can send an ordinary goal-like request, leave the computer unattended, and observe this bounded behavior:

`manual goal -> ChatGPT Prime -> optional Antigravity Fast Investigator -> final ChatGPT answer -> Antigravity Goal Driver -> automatic next user message -> ... -> NO_REPLY`

If context approaches the configured threshold, the sequence becomes:

`... -> automatic Compact & Resume -> replacement ChatGPT conversation -> same durable session + same active goal revision -> continue -> NO_REPLY`.

At any point a manual stop command halts the session goal, and any later normal manual message replaces it with a new revision.
