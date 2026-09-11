# Runtime Continuity Hardening — Design

## Scope

This slice interrupts the current upstream-2.0.9 selective-port sequence before Coding Runtime Task 7. It hardens two continuity boundaries that can currently terminate or fragment long-running work incorrectly:

1. Goal/loop completion can stop because a model says the work is done even when concrete requested work remains.
2. Compact & Resume carries too much continuation state inside the old conversation lifecycle instead of treating a fresh ChatGPT conversation as the explicit continuation surface.

This work must preserve the current 2.2.0 fork architecture: Persistent Core, Agent System 3.0, durable execution, Control Center, Plugins, Fleet/Devices, exact conversation/session authority, recorder/session recovery, workspace authority, and the restored 2.0.9-style UI shell.

## User intent

- A loop must not stop merely because ChatGPT or the Goal model says “done”.
- “The current turn/milestone finished” and “the user’s requested work finished” are separate states.
- Infinite execution must continue across completed milestones until the user stops it, a real blocker is reached, or no relevant work remains under the approved goal.
- Instead of relying on in-place compaction semantics, the app should ask the current chat to write a continuation prompt, preserve it durably, copy it to the clipboard, open a fresh ChatGPT conversation, paste/send it automatically, and continue there.
- The old chat must remain authoritative until the new chat is proven live and correctly bound.

## Alternatives considered

### A. Prompt-only tuning

Change the Goal system prompt so it is more reluctant to emit `NO_REPLY`, and strengthen the current Compact & Resume prompt.

Rejected as the primary solution. It leaves termination authority inside a probabilistic model decision and does not remove the continuation-state complexity.

### B. Independent verifier model plus existing Compact & Resume state machine

Keep the current continuation transaction, but add another LLM pass whenever Goal wants to stop.

Better than prompt-only tuning, but still lets two model opinions decide a state transition that Core can partially verify deterministically. It also preserves the current continuation complexity.

### C. Evidence-gated completion plus fresh-chat handoff — selected

Treat model output only as a proposal. Core evaluates completion evidence before stopping. For context rollover, generate one durable executable continuation prompt and move the active conversation binding only after a fresh chat acknowledges it.

This is the selected design because it moves terminal decisions toward durable evidence and makes the chat boundary explicit.

## Part 1 — Loop Completion Gate v2

### State model

Goal decisions become semantically three-stage even if the provider schema remains binary initially:

- `continue`: concrete requested work remains; type the proposed next user message.
- `candidate_done`: the model believes the goal may be complete; do not stop yet.
- `done`: Core has verified the candidate against available evidence.

`NO_REPLY` / provider `action:"stop"` maps to `candidate_done`, never directly to terminal loop completion.

### Completion evidence

Core evaluates the strongest locally available evidence for the exact durable session/conversation before accepting `done`.

The gate must refuse terminal completion when any of the following is true:

- the latest durable task plan contains `pending` or `in_progress` items;
- the exact conversation/session still owns an active local tool call, background command, publication obligation, or execution transition;
- the latest relevant recorded assistant state explicitly reports requested work as pending, failed, blocked, skipped, unverified, or still to be done;
- the approved durable execution plan still has an unfinished current milestone;
- a verification step required by the approved plan has not produced success evidence;
- the loop is in `infinite` mode and only the current milestone is complete.

Absence of those blockers is necessary but not sufficient when the session has a concrete plan. If a plan exists, every item must be `completed` before a standard run can terminate.

When no durable plan exists, the model’s candidate completion may be accepted only if there is no contradictory local evidence. This preserves ordinary lightweight chat behavior while eliminating known false-stop cases.

### Infinite execution semantics

For `mode === "infinite"`:

- verified completion of the current milestone does not set the execution run to `completed`;
- Core produces or requests the next in-scope continuation instruction;
- terminal stop is reserved for explicit user stop, unrecoverable safety/authorization/privacy/destructive ambiguity, or a verified state where no further relevant work exists under the approved objective;
- “nice to have” work outside the approved objective must not be invented merely to keep the loop alive.

### Fail-safe direction

If completion evidence is ambiguous, prefer continuation over termination. One extra continuation turn is cheaper than abandoning unfinished work.

The gate must not invent new requirements. It may continue only work already grounded in the user request, durable plan, or current approved execution milestone.

## Part 2 — Fresh Chat Handoff v2

### User-facing behavior

Rename the conceptual action from “Compact & Resume” to “Continue in New Chat” while retaining compatibility for persisted/config/internal names during migration.

Trigger sources remain:

- manual user action;
- automatic context-threshold rollover;
- managed execution rollover when the current conversation can no longer continue safely.

### Handoff generation

The current chat receives one instruction: write an executable continuation prompt for a brand-new chat.

The prompt must preserve:

- the user’s authoritative requirements and later corrections;
- exact repo/worktree/branch/commit state;
- dirty-tree caveats;
- completed work with verification evidence;
- current in-progress point;
- failures/root causes already investigated;
- durable execution id/mode when present;
- plan state and next concrete action;
- constraints and explicit “do not” rules.

The existing `HANDOFF_BRIEF_RULES` remain the basis, but the artifact is treated explicitly as the next chat’s executable first user message rather than as a hidden compaction summary.

### Durable ordering

The transition is transactional:

1. old chat remains authoritative;
2. handoff prompt is generated and validated;
3. handoff is written durably;
4. the same text is copied to the system clipboard as a recovery affordance;
5. Core queues one fresh-chat browser command;
6. the extension opens one new ChatGPT conversation and pastes/sends the exact handoff text;
7. Core waits for exact conversation-id evidence from the opened page;
8. only then does Core rebind session/workspace/execution/conversation attribution from old chat to new chat;
9. the old chat becomes historical/non-authoritative for that durable session.

If steps 4-7 fail, the old chat remains authoritative and the durable handoff remains available for retry/manual paste. No session ownership is moved early.

### Clipboard behavior

Clipboard copy is best-effort recovery support, not transition authority. Clipboard failure must not invalidate a durably stored handoff or cause duplicate fresh chats.

The exact clipboard text must equal the exact first user message queued for the fresh chat.

Clipboard ownership belongs to the desktop/browser integration layer that already performs the user-visible fresh-chat action. Core remains the authority for the text and transaction; the integration may write the clipboard only from the Core-provided bootstrap payload. This avoids making clipboard contents an input to the continuation protocol.

### One handoff, one new chat

Retries, reloads, duplicate observers, or delayed browser ACKs must converge on one continuation transaction and one replacement conversation. A stale marker must never type the handoff into an unrelated chat.

## Part 3 — Interaction with existing subsystems

### Durable execution

Execution identity remains in Core and survives chat replacement. A fresh-chat handoff only changes `conversationId`; it does not create a second execution run.

Standard execution may become terminal only through the new completion gate. Infinite execution treats milestone completion as a continuation point.

### Agent System 3.0

Worker chats remain excluded from automatic compaction/fresh-chat handoff unless a future worker-specific design explicitly changes that rule.

Prime ownership moves only through the authenticated continuation commit, preserving the existing conversation-fencing rules.

### Session / workspace

The durable session and workspace remain the authority. The handoff text does not become a second authority copy for workspace identity.

### Recorder

The recorder must retain provenance for:

- handoff generation in the old chat;
- fresh-chat bootstrap text;
- old conversation id;
- new conversation id;
- successful/failed rebind.

## Part 4 — Error handling

- Short/truncated handoff: reject; stay in old chat.
- Handoff storage failure: reject; stay in old chat.
- Clipboard failure: surface warning, continue if durable storage is healthy.
- New-chat open failure: keep old authority; retry the same transaction, not a new one.
- Paste/send failure: keep old authority; handoff remains durable and clipboard-assisted.
- New conversation id cannot be proven: do not rebind.
- Rebind persistence failure: new chat must not become authoritative; retry/abort using existing continuation durability rules.
- Goal verifier ambiguity: continue rather than stop.

## Part 5 — Testing strategy

Implementation follows RED → minimal GREEN → regression gate.

### Completion-gate tests

Cover at minimum:

- model returns stop while plan has pending item → loop continues;
- model returns stop while plan has in-progress item → loop continues;
- model returns stop while required verification is unresolved → loop continues;
- model returns stop and all plan items + required verification are complete → standard loop stops;
- no-plan lightweight conversation with no contradictory evidence may stop;
- infinite mode milestone complete → execution stays active and continues;
- explicit user stop remains terminal;
- evidence from another conversation/session cannot affect this loop.

### Fresh-chat handoff tests

Cover at minimum:

- generated handoff is durably stored before open;
- clipboard receives the exact bootstrap text;
- clipboard failure does not duplicate or abort a durable transition;
- fresh chat receives exactly one bootstrap message;
- duplicate/retried open requests converge on one command;
- old conversation remains authoritative before fresh-chat ACK;
- exact new conversation ACK commits the rebind;
- stale/wrong conversation cannot claim the handoff;
- failed send/open leaves old authority intact and handoff retryable;
- execution/session/workspace/prime attribution all move together only at commit;
- worker chats remain excluded.

### Compatibility tests

Cover at minimum:

- an existing persisted compaction setting still loads;
- an already-written handoff remains readable;
- an in-flight legacy continuation is not silently reinterpreted as a v2 handoff;
- UI relabeling does not change the durable storage key or break settings migration.

### Regression gates

Focused tests must include existing Goal, continuation, handoff, bridge, execution, Agent System 3.0 continuation, and recorder/session cases touched by the change.

Then run:

```text
npm run typecheck
npm run verify:notices
git diff --check
```

After this continuity slice is committed, resume Coding Runtime Task 7 and its full protected verification:

```text
npm run verify:ci
npm run build
```

## Implementation boundaries

Likely production surfaces:

- `src/shared/goal.ts`
- `src/main/goal.ts`
- `src/main/bridge.ts`
- `src/main/execution.ts`
- `src/main/session/handoff-prompt.ts`
- `src/main/session/handoff.ts`
- continuation/session ownership code only where the existing commit boundary requires it
- extension/browser command handling where clipboard + fresh-chat bootstrap are performed

Do not wholesale rewrite the recorder/session store, Agent System 3.0 broker, or browser bridge. Reuse the current continuation WAL, command idempotency, exact conversation evidence, and durable rebind boundaries where they already satisfy the new design.

## Migration / compatibility

- Existing persisted `compaction` configuration may remain under that storage key initially.
- Existing handoff files remain readable.
- Existing active continuation transactions must either finish under their stored protocol or be safely aborted; do not reinterpret an in-flight old transaction as a new protocol mid-commit.
- UI naming can move to “Continue in New Chat” without requiring an immediate durable schema migration.

## Acceptance criteria

This slice is complete only when:

1. a model `stop` decision is no longer sufficient by itself to terminate an unfinished loop;
2. plan/evidence contradictions force continuation;
3. infinite execution survives milestone completion;
4. context rollover creates one durable handoff and one fresh chat;
5. the exact handoff is copied to clipboard and typed into the new chat;
6. old authority remains intact until exact new-chat evidence commits the move;
7. failure paths leave a recoverable old chat + durable handoff rather than a half-moved session;
8. focused regression gates are green;
9. Coding Runtime Task 7 resumes afterward rather than being silently skipped.

## Sequencing in the current roadmap

The immediate order becomes:

1. close the existing Task 6 review state if any review-only action remains;
2. implement Runtime Continuity Hardening as this spec defines;
3. run the continuity-focused regression gate and commit the slice;
4. resume Coding Runtime Task 7 without changing its verification obligations;
5. continue Browser/Bridge Reliability, Recorder/Session, Windows Computer Use, Workspace/UI/i18n, and final integration in the previously approved order.

This design intentionally inserts continuity hardening before Task 7 because Task 7 is the first integrated verification checkpoint for the coding-runtime slice. Verifying the old continuation semantics immediately before replacing them would create a misleading checkpoint and duplicate broad verification work.
