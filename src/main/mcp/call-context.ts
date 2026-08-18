/**
 * Per-tool-call context.
 *
 * Two problems are solved by the same small store. Tool handlers know things the
 * generic recorder cannot infer — which files changed by how many lines, what a
 * command exited with, how many matches a search found — and the recorder wants that
 * evidence without every handler growing an extra parameter. And in multi-agent mode
 * every log line and every recorded call has to be attributed to the agent that made
 * it, which is decided once per request rather than at each call site.
 *
 * AsyncLocalStorage keeps this correct while several tool calls are in flight: each
 * call sees its own store, and code running outside a call sees nothing at all.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssetRef, FileChange, ToolOutcome } from '../../shared/session.js';

export interface CallEvidence {
  changes: FileChange[];
  assets: AssetRef[];
  /** Result count for searches and listings. */
  count: number | null;
  /** Free-form qualifier the summariser may use, e.g. "lines 200-420". */
  detail: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Child/process lifetime when the command surface measured it itself. */
  durationMs: number | null;
  /** Explicit child state; null for non-process tools and older call sites. */
  running: boolean | null;
  /** Managed-process id when the command continues beyond one MCP response. */
  processSessionId: string | null;
}

/**
 * What this call was proven to be, rather than what it claimed.
 *
 * Kept in the call context rather than threaded through every handler. There is nothing
 * secret in it: identity here is a conversation id gathered from page evidence, which the
 * recorder writes down on purpose.
 */
export interface CallCaller {
  transportKey: string | null;
  /**
   * ChatGPT's own id for this request, from the `x-request-id` header the connector
   * arrives with, trimmed to the part before the `/`.
   *
   * This is the join. ChatGPT stamps the same id on the request in its own message model,
   * the extension reports it, and the two meet here — so a call names the conversation
   * that issued it outright, rather than being placed by when it happened to arrive.
   * Measured live on 2026-08-18: header `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`
   * against page evidence `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`.
   */
  requestId: string | null;
  /**
   * The ChatGPT conversation this call was proven to come from, when this call's own
   * evidence named one. Never anything the model wrote.
   */
  conversationId: string | null;
}

export interface CallContext {
  /** Stable per-conversation key when the transport offers one, else null. */
  transportKey: string | null;
  /** Resolved agent id in multi-agent mode, else null. */
  agent: string | null;
  /** Who this call was proven to be, for the broker tools to route by. */
  caller: CallCaller;
  /**
   * Set by the tool guard, which is the only code that can tell a refusal apart from
   * a genuine failure — both come back to the model as an error result.
   */
  outcome: ToolOutcome | null;
  evidence: CallEvidence;
  /**
   * An agent whose chat this call would identify, if the recorder can place the call.
   *
   * Only `agents action=spawn` sets it, and only for the prime: the prime's chat is the user's
   * own, so nothing opened it on the app's behalf and there is no report to bind it from.
   * The binding therefore waits for the same evidence the record itself waits for —
   * resolved after the call, because the page renders the block for a call while it is
   * still running and reports it on its own tick, which is usually after the answer.
   */
  bindOnAttribution?: string;
}

const storage = new AsyncLocalStorage<CallContext>();

export function emptyEvidence(): CallEvidence {
  return {
    changes: [],
    assets: [],
    count: null,
    detail: null,
    exitCode: null,
    timedOut: false,
    durationMs: null,
    running: null,
    processSessionId: null
  };
}

export function runInCallContext<T>(context: CallContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Local tool calls this process is running right now.
 *
 * Needed by ChatGPT-native compaction. Interrupting the turn stops ChatGPT, but a call
 * already inside this process keeps going: a handoff written while a `run_powershell` or
 * an edit is still mid-flight describes a machine state that changes a second later, and
 * it is the *fresh* chat that then acts on the stale description. The page waits for this
 * to reach zero before it submits the handoff instruction.
 *
 * Lives here rather than in `tools.ts` so the bridge can read it without importing the
 * whole tool surface (and, through it, Electron).
 */
let inFlight = 0;

export function inFlightToolCalls(): number {
  return inFlight;
}

/** Counts one call for as long as it runs, however it ends. */
export async function trackInFlight<T>(fn: () => Promise<T>): Promise<T> {
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
  }
}

export function currentCall(): CallContext | null {
  return storage.getStore() ?? null;
}

/** Agent id for the call currently running, or null outside one. */
export function currentAgent(): string | null {
  return storage.getStore()?.agent ?? null;
}

/** Who the running call was proven to be. Empty outside a call. */
export function currentCaller(): CallCaller {
  return storage.getStore()?.caller ?? { transportKey: null, requestId: null, conversationId: null };
}

/** Asks for `agent` to be bound to this call's conversation once it can be identified. */
export function bindOnAttribution(agent: string): void {
  const context = storage.getStore();
  if (context) context.bindOnAttribution = agent;
}

export function noteOutcome(outcome: ToolOutcome): void {
  const store = storage.getStore();
  if (store) store.outcome = outcome;
}

export function noteChange(change: FileChange): void {
  storage.getStore()?.evidence.changes.push(change);
}

export function noteChanges(changes: readonly FileChange[]): void {
  const store = storage.getStore();
  if (store) store.evidence.changes.push(...changes);
}

export function noteAsset(asset: AssetRef): void {
  storage.getStore()?.evidence.assets.push(asset);
}

export function noteCount(count: number): void {
  const store = storage.getStore();
  if (store) store.evidence.count = count;
}

export function noteDetail(detail: string): void {
  const store = storage.getStore();
  if (store) store.evidence.detail = detail;
}

export function noteProcess(result: {
  id?: string;
  running?: boolean;
  exitCode: number | null;
  durationMs?: number;
}): void {
  const store = storage.getStore();
  if (!store) return;
  store.evidence.exitCode = result.exitCode;
  if (typeof result.running === 'boolean') store.evidence.running = result.running;
  if (typeof result.id === 'string' && result.id) store.evidence.processSessionId = result.id;
  if (typeof result.durationMs === 'number') store.evidence.durationMs = result.durationMs;
}

export function noteExec(result: {
  id?: string;
  running?: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  durationMs?: number;
}): void {
  const store = storage.getStore();
  if (!store) return;
  noteProcess(result);
  store.evidence.timedOut = result.timedOut === true;
  // A command that ran and failed is not an `ok` call. The dispatcher's fallback only sees
  // `result.isError`, and a completed non-zero shell result is not a transport error, so a
  // failed build was being stored beside a successful one with nothing to tell them apart.
  // A still-running process has `exitCode === null` and has not failed yet; leave it alone,
  // and never overwrite an outcome a tool set deliberately.
  if (!store.outcome && (result.timedOut === true || (result.exitCode !== null && result.exitCode !== 0))) {
    store.outcome = 'error';
  }
}
