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
  /** Real work duration when the tool measured it itself. */
  durationMs: number | null;
}

/**
 * What this call presented as proof of who is making it.
 *
 * Kept in the call context rather than threaded through every handler, and never
 * recorded: `secret` is a live capability, and the recorder strips it by name and by
 * value before anything is written.
 */
export interface CallCaller {
  transportKey: string | null;
  secret: string | null;
}

export interface CallContext {
  /** Stable per-conversation key when the transport offers one, else null. */
  transportKey: string | null;
  /** Resolved agent id in multi-agent mode, else null. */
  agent: string | null;
  /** Credentials this call carried, for the broker tools to authenticate against. */
  caller: CallCaller;
  /**
   * Set by the tool guard, which is the only code that can tell a refusal apart from
   * a genuine failure — both come back to the model as an error result.
   */
  outcome: ToolOutcome | null;
  evidence: CallEvidence;
}

const storage = new AsyncLocalStorage<CallContext>();

export function emptyEvidence(): CallEvidence {
  return { changes: [], assets: [], count: null, detail: null, exitCode: null, timedOut: false, durationMs: null };
}

export function runInCallContext<T>(context: CallContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentCall(): CallContext | null {
  return storage.getStore() ?? null;
}

/** Agent id for the call currently running, or null outside one. */
export function currentAgent(): string | null {
  return storage.getStore()?.agent ?? null;
}

/** Credentials the running call presented. Empty outside a call. */
export function currentCaller(): CallCaller {
  return storage.getStore()?.caller ?? { transportKey: null, secret: null };
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

export function noteExec(result: { exitCode: number | null; timedOut?: boolean; durationMs?: number }): void {
  const store = storage.getStore();
  if (!store) return;
  store.evidence.exitCode = result.exitCode;
  store.evidence.timedOut = result.timedOut === true;
  if (typeof result.durationMs === 'number') store.evidence.durationMs = result.durationMs;
}
