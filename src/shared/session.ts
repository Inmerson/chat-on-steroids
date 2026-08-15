/**
 * Types for the session recorder, compaction and the multi-agent broker.
 *
 * Shared by the main process, the renderer and — in JSON form — the Chrome extension.
 * No runtime logic here beyond a couple of pure helpers the UI and the recorder must
 * agree on exactly.
 */

/** Where an event came from. The extension is untrusted UI observation; mcp is ours. */
export type EventSource = 'extension' | 'mcp' | 'app';

/**
 * How a ChatGPT turn ended.
 *
 * Deliberately more than "done" and "failed". Guessing "output limit reached" for
 * every unexplained stop is exactly the fake precision this project avoids, so an
 * unexplained stop stays `interrupted` or `unknown` unless ChatGPT actually said why.
 */
export type TurnOutcome =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'stalled'
  | 'unknown';

export const TURN_OUTCOME_LABELS: Record<TurnOutcome, string> = {
  completed: 'completed',
  failed: 'failed with a visible error',
  stopped: 'stopped by the user',
  interrupted: 'interrupted before it finished',
  stalled: 'stalled — no visible progress',
  unknown: 'ended for an unknown reason'
};

/**
 * Text stored in an event, with an explicit note when it was cut.
 *
 * The inline copy is bounded so the JSONL stays readable and one huge command output
 * cannot push a line past the reader's limit. Nothing is actually lost by that: when
 * the text is cut, the full redacted original is written beside the log as an asset
 * and named here, so recovery reads the whole thing. `truncated` therefore means
 * "not all of it is in this line", never "the rest is gone".
 */
export interface StoredText {
  text: string;
  /** True when the original was longer than the per-event cap. */
  truncated: boolean;
  /** Length of the original, so a summary can say what it lost. */
  chars: number;
  /** Asset holding the complete redacted text, present only when truncated. */
  assetId?: string;
}

/** A screenshot or other binary kept beside the log rather than inside it. */
export interface AssetRef {
  id: string;
  mimeType: string;
  bytes: number;
  /** Present only for images. */
  width?: number;
  height?: number;
}

/** Compact human-readable presentation of one tool call. */
export interface ActivitySummary {
  /** Short verb phrase: "Edited src/main/mcp/server.ts". */
  title: string;
  /** Optional qualifier: "lines 200–420", "30 matches". */
  detail?: string;
  /** Optional right-aligned metric: "+18 −4", "✓ 4.8s", "✕ exit 1". */
  metric?: string;
  tone: 'neutral' | 'good' | 'bad' | 'warn';
  /** Family the entry belongs to, for icons and filtering. */
  kind:
    | 'edit'
    | 'create'
    | 'delete'
    | 'move'
    | 'read'
    | 'search'
    | 'browse'
    | 'run'
    | 'process'
    | 'screen'
    | 'input'
    | 'clipboard'
    | 'session'
    | 'agent'
    | 'other';
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** True when the counts come from a bounded heuristic rather than a full diff. */
  approximate: boolean;
}

export type ToolOutcome = 'ok' | 'error' | 'rejected';

/**
 * How confident the recorder is that this call belongs to the session it landed in.
 *
 * `turn` means exactly one conversation had a turn in flight, `agent` means the call
 * carried a transport-bound or capability-proven agent identity, and `inferred` means
 * nothing identified the caller — those calls are stored in the unattributed stream
 * rather than guessed into somebody's history. The extension refuses to rewrite
 * ChatGPT's UI for an inferred call.
 */
export type CallAttribution = 'turn' | 'agent' | 'inferred';

export interface ToolCallRecord {
  callId: string;
  tool: string;
  attribution: CallAttribution;
  /** Exact arguments as JSON. Cut inline past the cap, with the whole text in an asset. */
  args: StoredText;
  result: StoredText;
  outcome: ToolOutcome;
  durationMs: number;
  summary: ActivitySummary;
  /** Files this call demonstrably changed, with line counts where computable. */
  changes?: FileChange[];
  assets?: AssetRef[];
}

interface BaseEvent {
  /** 1-based, strictly increasing within a session. Ordering never relies on time. */
  seq: number;
  time: number;
  source: EventSource;
  /** Multi-agent attribution. Absent when no swarm is running. */
  agent?: string;
  /** ChatGPT's own turn id when the extension could read it. */
  turnId?: string;
}

export type SessionEvent =
  | (BaseEvent & { kind: 'session_start'; conversationId: string | null; title: string })
  | (BaseEvent & { kind: 'user_message'; message: StoredText; messageId?: string })
  | (BaseEvent & { kind: 'assistant_message'; message: StoredText; messageId?: string; final: boolean })
  | (BaseEvent & { kind: 'progress'; message: StoredText })
  | (BaseEvent & { kind: 'turn_start' })
  | (BaseEvent & { kind: 'turn_end'; outcome: TurnOutcome; detail?: string })
  | (BaseEvent & { kind: 'chat_error'; message: StoredText })
  | (BaseEvent & { kind: 'tool_call'; call: ToolCallRecord })
  | (BaseEvent & { kind: 'note'; message: StoredText })
  /**
   * A message routed between agents.
   *
   * Recorded twice and deliberately so: once in the sender's session when the broker
   * accepts it, once in the recipient's when the recipient acknowledges it. Without the
   * second one a worker's report would exist only in the worker's own history and the
   * volatile queue, so compacting the prime — the whole point of Compact & Resume while
   * workers keep running — would silently omit everything the workers had told it.
   * `messageId` is stable across both, so the pair can be matched and re-offers of the
   * same message never produce a second record.
   */
  | (BaseEvent & {
      kind: 'agent_message';
      messageId: string;
      from: string;
      to: string;
      message: StoredText;
      delivery: 'sent' | 'delivered';
    })
  | (BaseEvent & {
      kind: 'handoff';
      handoffId: string;
      model: string;
      chars: number;
      /** What triggered it: manual compaction, resume, or an automatic suggestion. */
      reason: string;
    });

export type SessionEventKind = SessionEvent['kind'];

/**
 * An event before the store assigns its sequence number.
 *
 * Written as a distributive conditional because a plain Omit over a union keeps only
 * the keys every member shares, which would silently reduce every event to its base
 * fields and let a caller append a tool_call with no call in it.
 */
export type NewSessionEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

export interface SessionSummary {
  id: string;
  title: string;
  conversationId: string | null;
  startedAt: number;
  updatedAt: number;
  /** Null while the session is still the active one. */
  endedAt: number | null;
  events: number;
  userMessages: number;
  toolCalls: number;
  errors: number;
  /** Rough local estimate — never ChatGPT's private counter. See estimateTokens. */
  estimatedTokens: number;
  /** Id of the newest stored handoff, or null when the session was never compacted. */
  lastHandoffId: string | null;
  lastHandoffAt: number | null;
  /** Outcome of the most recent finished turn. */
  lastTurnOutcome: TurnOutcome | null;
  /** Agents seen in this session, prime first. Empty when no swarm ran. */
  agents: string[];
}

export interface Handoff {
  id: string;
  sessionId: string;
  createdAt: number;
  model: string;
  reasoning: string;
  /** The continuation brief itself. */
  text: string;
  /** How the raw session looked when this was made, for honest staleness reporting. */
  sourceEvents: number;
  sourceTokens: number;
  /** Set when the model stopped early or the pack dropped material. */
  notes: string[];
}

/** One step of a running compaction, mirrored into the UI. */
export type CompactionStage =
  | 'idle'
  | 'collecting'
  | 'preparing'
  | 'sending'
  | 'thinking'
  | 'streaming'
  | 'saving'
  | 'ready'
  | 'error';

export const COMPACTION_STAGE_LABELS: Record<CompactionStage, string> = {
  idle: 'Idle',
  collecting: 'Collecting session',
  preparing: 'Preparing history',
  sending: 'Sending to OpenRouter',
  thinking: 'Model working',
  streaming: 'Receiving output',
  saving: 'Saving handoff',
  ready: 'Ready',
  error: 'Failed'
};

export interface CompactionState {
  stage: CompactionStage;
  sessionId: string | null;
  /**
   * Which pass is running, when a session is too large for one and has to be
   * compacted in stages, e.g. "part 2 of 4". Empty for the ordinary single pass.
   */
  step: string;
  /** Characters of brief received so far, so the UI can show real movement. */
  received: number;
  /** Reasoning text, only when the provider actually streams it. */
  reasoning: string;
  /** Tail of the brief as it streams, bounded for the UI. */
  preview: string;
  model: string;
  startedAt: number | null;
  finishedAt: number | null;
  handoffId: string | null;
  error: string | null;
  /** True when the flow should open a fresh ChatGPT chat once the handoff is saved. */
  resume: boolean;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** True when the model advertises reasoning support of any kind. */
  reasoning: boolean;
  /**
   * Efforts this model actually accepts, from its live metadata.
   *
   * Empty means "do not send a reasoning setting at all". OpenRouter's catalogue
   * advertises that a model takes a reasoning parameter but not, in general, which
   * efforts it accepts, so the standard three are assumed when it does and anything
   * further (xhigh) only appears when the metadata names it.
   */
  reasoningLevels: ReasoningEffort[];
  /** Unix seconds the model was listed, for newest-first ordering. Null if absent. */
  created: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'xhigh'];

// ---------------------------------------------------------------- agents

export type AgentRole = 'prime' | 'worker';
export type AgentState = 'invited' | 'active' | 'finished' | 'failed';

export interface AgentInfo {
  id: string;
  role: AgentRole;
  label: string;
  task: string;
  state: AgentState;
  createdAt: number;
  joinedAt: number | null;
  finishedAt: number | null;
  /** Result text the worker reported when it finished. */
  result: string | null;
  /** Messages waiting for this agent, including offered-but-unacknowledged ones. */
  pending: number;
  /** Of those, how many have gone out at least once and are awaiting proof of receipt. */
  awaitingAck: number;
  /** Messages this agent has demonstrably received. */
  delivered: number;
  conversationId: string | null;
  /** Files the agent declared it is working on, for the overlap warning. */
  claims: string[];
}

/**
 * One brokered message, with delivery tracked at-least-once.
 *
 * Marking a message delivered at the moment it is written into a tool result would be
 * a lie the moment the connector drops between the result being built and ChatGPT
 * receiving it — a failure this project has already reproduced — and the message would
 * be gone for good. So a message is only *offered* when it goes out, and retired when
 * the recipient proves it got it by making another authenticated call. The cost is
 * that a message can be shown twice; `id` is stable so the model and the recorder can
 * both tell a repeat from a new message, and a repeat is much cheaper than a loss.
 */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  time: number;
  text: string;
  /** When it was last written into a tool result. Re-offered until acknowledged. */
  offeredAt: number | null;
  /** How many times it has been offered, so a repeat can be labelled as one. */
  offers: number;
  /** Set once the recipient has demonstrably received it. */
  ackedAt: number | null;
}

export interface SwarmState {
  enabled: boolean;
  /** True while at least one worker is invited or active. */
  running: boolean;
  agents: AgentInfo[];
}

// ---------------------------------------------------------------- helpers

/**
 * Rough token estimate for locally held text.
 *
 * Four characters per token is the usual English approximation. It is deliberately
 * not presented as ChatGPT's context counter: hidden reasoning, system prompts and
 * the tool schema are all invisible from here, so the number is only ever used to
 * suggest compaction, never to claim a limit was reached.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Token weight of one stored event, using the text we actually kept. */
export function eventTokens(event: SessionEvent): number {
  switch (event.kind) {
    case 'user_message':
    case 'assistant_message':
    case 'progress':
    case 'chat_error':
    case 'note':
      return estimateTokens(event.message.text);
    case 'tool_call':
      return (
        estimateTokens(event.call.args.text) +
        estimateTokens(event.call.result.text) +
        estimateTokens(event.call.summary.title)
      );
    case 'handoff':
      return 0;
    default:
      return 0;
  }
}

export interface TokenPressure {
  estimated: number;
  advisory: number;
  limit: number;
  level: 'ok' | 'large' | 'huge';
}

export function tokenPressure(estimated: number, advisory: number, limit: number): TokenPressure {
  return {
    estimated,
    advisory,
    limit,
    level: estimated >= limit ? 'huge' : estimated >= advisory ? 'large' : 'ok'
  };
}
