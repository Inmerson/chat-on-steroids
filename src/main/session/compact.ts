/**
 * Compaction: turning a recorded session into a handoff a fresh chat can act on.
 *
 * This is not a chat summary. The output is an operating brief for a coding agent
 * that is about to continue somebody else's half-finished implementation, so the pack
 * that goes to the model is built with a strict priority: every user message survives
 * verbatim, then everything that failed, then everything that changed a file, and
 * only then the commentary. Running out of budget deletes narration, never intent.
 *
 * The raw session is never touched. A handoff is an extra file beside the log.
 */

import { randomUUID } from 'node:crypto';
import type {
  CompactionStage,
  CompactionState,
  Handoff,
  SessionEvent,
  SessionSummary
} from '../../shared/session.js';
import { estimateTokens } from '../../shared/session.js';
import { getConfig, updateConfig } from '../config.js';
import { logError, logInfo } from '../logger.js';
import { OpenRouterError, complete, listModels, pickDefaultModel } from '../openrouter.js';
import { recordHandoff } from './recorder.js';
import { getSession, readEvents, saveHandoff } from './store.js';

/** Characters of packed history sent to the model when the context is unknown. */
const DEFAULT_PACK_CHARS = 400_000;
/** Never send more than this, whatever the model claims to accept. */
const MAX_PACK_CHARS = 1_200_000;
/** Room left for the model's own output, in characters of input given up. */
const OUTPUT_RESERVE_CHARS = 40_000;
const MAX_OUTPUT_TOKENS = 8_000;
/** Tail of the brief kept for the UI while it streams. */
const PREVIEW_CHARS = 2_000;

const SYSTEM_PROMPT = `You are writing a handoff brief so a different coding agent can continue an unfinished software task in a brand-new conversation, with no memory of what came before.

You are given a recording of the previous session: the user's own messages, the assistant's visible replies, and the exact tool calls that were made against the user's machine, with their results.

Write the brief so that an agent who reads only your brief can carry on correctly.

Rules:
- The user's messages are the specification. Preserve the original task, every requirement, every later correction, and every constraint. If a later message changed an earlier requirement, state the final position and say that it changed.
- Never drop a requirement because it looks minor or because it was not worked on. Unfinished requirements matter most.
- Use the tool evidence to decide what is actually done. An assistant message saying it will do something is not evidence that it happened; a recorded tool call that succeeded is. Say plainly which is which.
- Keep exact identifiers: file paths, function names, versions, ports, hashes, ids, command lines, error text. Do not paraphrase them.
- Separate clearly: what is complete and verified · what was attempted and failed · what was only discussed · what is still to do.
- Include failures and unresolved bugs with the actual error, and say what was already tried so it is not repeated.
- State the current state of the repository, install and running processes as far as the recording shows it.
- Be dense and operational. No preamble, no praise, no restating these instructions, no "in this session we". Bullet points and short lines.
- If the recording is incomplete or ambiguous, say so in one line rather than inventing detail.

Structure the brief with these headings, omitting any that would be empty:

TASK — the original goal, in the user's terms.
REQUIREMENTS — every constraint and requirement, including corrections.
DONE — completed and verified, with the evidence.
IN PROGRESS — started, not finished, and exactly where it stopped.
FAILED / UNRESOLVED — what broke, the error, what was already tried.
FILES — paths touched and what changed in each.
ENVIRONMENT — commands, versions, running processes, repo state.
NEXT — the concrete next actions, in order.
DO NOT — what the next agent should not redo or undo.`;

// ------------------------------------------------------------------ state

let state: CompactionState = idleState();
let abort: AbortController | null = null;
const listeners = new Set<(state: CompactionState) => void>();

function idleState(): CompactionState {
  return {
    stage: 'idle',
    sessionId: null,
    step: '',
    received: 0,
    reasoning: '',
    preview: '',
    model: '',
    startedAt: null,
    finishedAt: null,
    handoffId: null,
    error: null,
    resume: false
  };
}

export function compactionState(): CompactionState {
  return { ...state };
}

export function onCompactionChange(listener: (state: CompactionState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(patch: Partial<CompactionState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener({ ...state });
}

function stage(next: CompactionStage): void {
  setState({ stage: next });
}

export function compactionRunning(): boolean {
  return state.stage !== 'idle' && state.stage !== 'ready' && state.stage !== 'error';
}

export function cancelCompaction(): void {
  abort?.abort();
}

// ------------------------------------------------------------------- pack

/**
 * The history to send, split into as many passes as the budget requires.
 *
 * Almost always one part. A genuinely enormous session — the case this whole feature
 * exists for — can have more essential material than any model will accept in one
 * request, and there is no honest way to fit it: dropping user messages loses the
 * specification, and sending it anyway fails at the provider. So it is compacted in
 * stages, each pass carrying the brief so far plus the next slice of history.
 */
interface PackPlan {
  parts: string[];
  notes: string[];
  events: number;
  tokens: number;
}

function line(event: SessionEvent, body: string): string {
  const time = new Date(event.time).toISOString().slice(11, 19);
  const who = event.agent ? ` [${event.agent}]` : '';
  return `#${event.seq} ${time}${who} ${body}`;
}

function flat(text: string, cap: number): string {
  const value = text.replace(/[ \t]+/g, ' ').trim();
  return value.length <= cap ? value : `${value.slice(0, cap)}… [${value.length - cap} more characters]`;
}

/**
 * Fraction of each later pass reserved for the brief carried forward from the last.
 *
 * Without it a staged compaction would have no room to restate what it already knows,
 * and the early user requirements would fall out of the final brief — which is the
 * exact failure staging exists to prevent.
 */
const CARRY_FRACTION = 0.35;
const MAX_CARRY_CHARS = 60_000;

/**
 * Builds the text sent to the model, in priority order.
 *
 * Tier 1 is never dropped. Tiers 2 and 3 are added while budget remains, newest first
 * for the commentary, because the end of a session is what the next agent is about to
 * continue. If tier 1 alone will not fit, the pack becomes several parts rather than
 * one oversized request — the previous behaviour appended a note claiming material had
 * been cut while actually sending all of it, so the largest sessions failed at the
 * provider with the budget silently exceeded.
 */
export function packSession(summary: SessionSummary, events: readonly SessionEvent[], budget: number): PackPlan {
  const notes: string[] = [];
  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];

  for (const event of events) {
    switch (event.kind) {
      case 'user_message':
        tier1.push(line(event, `USER MESSAGE:\n${event.message.text}`));
        if (event.message.truncated) {
          notes.push(`a user message at #${event.seq} was longer than the recorder's cap and is cut`);
        }
        break;
      case 'chat_error':
        tier1.push(line(event, `CHATGPT ERROR: ${flat(event.message.text, 600)}`));
        break;
      case 'turn_end':
        if (event.outcome !== 'completed') {
          tier1.push(line(event, `TURN ENDED: ${event.outcome}${event.detail ? ` — ${event.detail}` : ''}`));
        }
        break;
      case 'tool_call': {
        const call = event.call;
        const changed = call.changes && call.changes.length > 0;
        const failed = call.outcome !== 'ok';
        const head = `${call.tool} → ${call.summary.title}${call.summary.detail ? ` (${call.summary.detail})` : ''}${call.summary.metric ? ` ${call.summary.metric}` : ''}`;
        if (failed) {
          tier1.push(line(event, `TOOL ${call.outcome.toUpperCase()}: ${head}\n  args: ${flat(call.args.text, 600)}\n  result: ${flat(call.result.text, 600)}`));
        } else if (changed) {
          const files = (call.changes ?? [])
            .map((change) => `${change.path} +${change.added} −${change.removed}${change.approximate ? ' (approx)' : ''}`)
            .join(', ');
          tier1.push(line(event, `TOOL OK: ${head}\n  files: ${files}\n  args: ${flat(call.args.text, 400)}`));
        } else {
          tier2.push(line(event, `tool ${head}`));
        }
        break;
      }
      case 'assistant_message':
        tier2.push(line(event, `ASSISTANT: ${flat(event.message.text, 1500)}`));
        break;
      case 'progress':
        tier3.push(line(event, `progress: ${flat(event.message.text, 200)}`));
        break;
      case 'handoff':
        tier2.push(line(event, `an earlier handoff was written here (${event.handoffId})`));
        break;
      case 'note':
        tier3.push(line(event, `note: ${flat(event.message.text, 200)}`));
        break;
      default:
        break;
    }
  }

  const header =
    `SESSION ${summary.id}\n` +
    `title: ${summary.title}\n` +
    `started: ${new Date(summary.startedAt).toISOString()}\n` +
    `last activity: ${new Date(summary.updatedAt).toISOString()}\n` +
    `recorded events: ${summary.events} · user messages: ${summary.userMessages} · tool calls: ${summary.toolCalls} · errors: ${summary.errors}\n` +
    (summary.agents.length > 0 ? `agents: ${summary.agents.join(', ')}\n` : '') +
    `last turn ended: ${summary.lastTurnOutcome ?? 'unknown'}\n`;

  const essentialHeading = '=== ESSENTIAL (user messages, failures, file changes) ===';
  const overhead = header.length + essentialHeading.length + 2;
  const essentialBudget = Math.max(2_000, budget - overhead);

  // One pass unless the essential material genuinely will not fit in one.
  const groups = splitToBudget(tier1, essentialBudget, notes);
  if (groups.length > 1) {
    notes.push(
      `the essential material needed ${groups.length} passes to fit the model's context; ` +
        'each pass carried the brief so far forward, so nothing was dropped'
    );
  }

  const parts: string[] = [];
  for (const [index, group] of groups.entries()) {
    const last = index === groups.length - 1;
    const lines = [header, essentialHeading, ...group];
    let used = lines.reduce((sum, part) => sum + part.length + 1, 0);
    // Commentary rides along with the final pass only: it is the least load-bearing
    // material and repeating it per pass would just crowd out the essentials.
    const room = last
      ? budget
      : Math.floor(budget * (1 - CARRY_FRACTION));
    if (last) {
      const addWhileRoom = (label: string, items: string[], newestFirst: boolean): void => {
        if (items.length === 0 || used >= room) return;
        const ordered = newestFirst ? [...items].reverse() : items;
        const taken: string[] = [];
        let dropped = 0;
        for (const item of ordered) {
          if (used + item.length + 1 > room) {
            dropped++;
            continue;
          }
          taken.push(item);
          used += item.length + 1;
        }
        if (taken.length === 0) {
          if (dropped > 0) notes.push(`${dropped} ${label} entries did not fit and were dropped`);
          return;
        }
        if (newestFirst) taken.reverse();
        lines.push(`=== ${label.toUpperCase()} ===`, ...taken);
        if (dropped > 0) notes.push(`${dropped} ${label} entries did not fit and were dropped`);
      };
      addWhileRoom('context', tier2, true);
      addWhileRoom('progress', tier3, true);
    }
    parts.push(lines.join('\n'));
  }

  const tokens = parts.reduce((sum, part) => sum + estimateTokens(part), 0);
  return { parts, notes, events: events.length, tokens };
}

/**
 * Splits essential entries into groups that each fit the budget.
 *
 * An entry longer than a whole budget is sliced rather than dropped: one enormous user
 * message is still the specification, and cutting it silently is the failure mode this
 * replaces. The slice is marked so the model knows it is reading a continuation.
 */
function splitToBudget(items: readonly string[], budget: number, notes: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let used = 0;
  const flush = (): void => {
    if (current.length > 0) groups.push(current);
    current = [];
    used = 0;
  };
  for (const item of items) {
    if (item.length + 1 > budget) {
      flush();
      const pieces = Math.ceil(item.length / budget);
      notes.push(`one recorded entry was larger than a single model request and was sent in ${pieces} pieces`);
      for (let at = 0, piece = 1; at < item.length; at += budget, piece++) {
        groups.push([`${piece > 1 ? '…(continued) ' : ''}${item.slice(at, at + budget)}`]);
      }
      continue;
    }
    if (used + item.length + 1 > budget) flush();
    current.push(item);
    used += item.length + 1;
  }
  flush();
  return groups.length > 0 ? groups : [[]];
}

// ---------------------------------------------------------------- compact

export interface CompactRequest {
  sessionId: string;
  /** Recorded on the handoff so the UI can say why it exists. */
  reason: string;
  /** True when the caller intends to open a fresh chat afterwards. */
  resume?: boolean;
}

/**
 * Runs one compaction end to end.
 *
 * Every stage is published before it begins, so the button in the app reports what is
 * happening rather than how long it has been happening. A failure leaves the state in
 * `error` with the real message; nothing is deleted and nothing navigates.
 */
export async function compactSession(request: CompactRequest): Promise<Handoff> {
  if (compactionRunning()) throw new Error('A compaction is already running');
  abort = new AbortController();
  state = { ...idleState(), sessionId: request.sessionId, startedAt: Date.now(), resume: request.resume === true };
  stage('collecting');

  try {
    const summary = await getSession(request.sessionId);
    if (!summary) throw new Error('That session no longer exists');
    const events = await readEvents(request.sessionId);
    if (events.length === 0) throw new Error('That session has nothing recorded yet');

    stage('preparing');
    const model = await resolveModel();
    setState({ model });
    const models = await listModels().catch(() => []);
    const chosen = models.find((entry) => entry.id === model);
    const budget = Math.min(
      MAX_PACK_CHARS,
      Math.max(20_000, (chosen?.contextLength ? chosen.contextLength * 4 : DEFAULT_PACK_CHARS) - OUTPUT_RESERVE_CHARS)
    );
    const pack = packSession(summary, events, budget);
    logInfo(
      `compaction: packed ${pack.events} events into ~${pack.tokens} tokens for ${model}` +
        (pack.parts.length > 1 ? ` across ${pack.parts.length} passes` : '')
    );

    const reasoningWanted = getConfig().compaction.reasoning;
    const notes = [...pack.notes];
    const carryCap = Math.min(MAX_CARRY_CHARS, Math.floor(budget * CARRY_FRACTION));
    let brief = '';

    for (const [index, part] of pack.parts.entries()) {
      const total = pack.parts.length;
      const last = index === total - 1;
      setState({
        step: total > 1 ? `part ${index + 1} of ${total}` : '',
        received: 0,
        preview: '',
        reasoning: ''
      });
      stage('sending');
      let first = true;
      const carried = brief ? `${'=== BRIEF SO FAR ==='}\n${brief.slice(-carryCap)}\n\n` : '';
      const instruction = last
        ? total > 1
          ? 'This is the final part of the recording. Produce the complete, final brief, keeping everything still true from the brief so far.'
          : 'Write the handoff brief now.'
        : `This is part ${index + 1} of ${total} of the recording, oldest first. Produce an updated brief that covers everything so far. Later parts will follow; do not drop anything from the brief so far, and do not write a conclusion yet.`;
      const result = await complete(
        {
          model,
          system: SYSTEM_PROMPT,
          user: `${carried}${part}\n\n=== END OF THIS PART ===\n${instruction}`,
          reasoning: reasoningWanted,
          ...(chosen ? { reasoningLevels: chosen.reasoningLevels } : {}),
          maxTokens: MAX_OUTPUT_TOKENS,
          signal: abort.signal
        },
        {
          onText: (chunk) => {
            if (first) {
              first = false;
              stage('streaming');
            }
            const preview = (state.preview + chunk).slice(-PREVIEW_CHARS);
            setState({ received: state.received + chunk.length, preview });
          },
          onReasoning: (chunk) => {
            if (state.stage === 'sending') stage('thinking');
            setState({ reasoning: (state.reasoning + chunk).slice(-PREVIEW_CHARS) });
          }
        }
      );
      if (!result.text.trim()) {
        throw new Error(
          total > 1 ? `The model returned nothing for part ${index + 1} of ${total}` : 'The model returned an empty brief'
        );
      }
      brief = result.text.trim();
      if (result.truncated) {
        notes.push(
          `the model stopped early (${result.finishReason})${total > 1 ? ` on part ${index + 1} of ${total}` : ''}; the brief may be missing its last sections`
        );
      }
    }

    stage('saving');
    const handoff: Handoff = {
      id: `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
      sessionId: request.sessionId,
      createdAt: Date.now(),
      model,
      reasoning: reasoningWanted,
      text: brief,
      sourceEvents: summary.events,
      sourceTokens: summary.estimatedTokens,
      notes
    };
    await saveHandoff(handoff);
    await recordHandoff(request.sessionId, handoff.id, model, handoff.text.length, request.reason);

    setState({ stage: 'ready', handoffId: handoff.id, finishedAt: Date.now() });
    logInfo(`compaction: saved handoff ${handoff.id} (${handoff.text.length} characters)`);
    return handoff;
  } catch (err) {
    const message =
      (err as Error)?.name === 'AbortError'
        ? 'Compaction was cancelled'
        : err instanceof OpenRouterError
          ? err.message
          : (err as Error).message;
    setState({ stage: 'error', error: message, finishedAt: Date.now() });
    logError(`compaction failed: ${message}`);
    throw err;
  } finally {
    abort = null;
  }
}

/**
 * The model to use, resolving and remembering a default the first time.
 *
 * The default is looked up in OpenRouter's live catalogue rather than assumed, and
 * then written back to settings so the choice is visible and editable instead of
 * being re-guessed on every run.
 */
async function resolveModel(): Promise<string> {
  const configured = getConfig().compaction.model.trim();
  if (configured) return configured;
  const models = await listModels();
  const picked = pickDefaultModel(models);
  if (!picked) throw new Error('OpenRouter returned no usable models');
  await updateConfig((latest) => ({ ...latest, compaction: { ...latest.compaction, model: picked } }));
  logInfo(`compaction: default model resolved to ${picked}`);
  return picked;
}

/** Clears a finished or failed run so the UI stops showing the last outcome. */
export function clearCompaction(): void {
  if (compactionRunning()) return;
  state = idleState();
  for (const listener of listeners) listener({ ...state });
}
