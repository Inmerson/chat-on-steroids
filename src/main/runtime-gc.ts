import { agentInfoForOwnedConversation } from './agents.js';
import { unifiedExecManager } from './codex/manager.js';
import { execOwner, forgetExecOwner } from './codex/ownership.js';
import type {
  ConditionalTerminationResult,
  ManagedProcessRuntimeInfo
} from './codex/unified-exec.js';
import type { AgentInfo } from '../shared/session.js';

export const AGENT_RUNTIME_RETENTION_MS = 30 * 60_000;
export const AGENT_RUNTIME_SWEEP_MS = 30_000;

export interface RuntimeGcDependencies {
  listRuntimeProcesses(): ManagedProcessRuntimeInfo[];
  execOwner(processId: number): string | null;
  forgetExecOwner(processId: number): void;
  agentInfoForOwnedConversation(conversationId: string): AgentInfo | null;
  terminateProcessIfUnusedSince(processId: number, cutoff: number): Promise<ConditionalTerminationResult>;
}

export interface RuntimeGcSummary {
  checked: number;
  eligible: number;
  terminated: number;
  exited: number;
  missing: number;
  busy: number;
  recent: number;
  unowned: number;
  ineligible: number;
  changed: number;
}

const defaultDependencies: RuntimeGcDependencies = {
  listRuntimeProcesses: () => unifiedExecManager.listRuntimeProcesses(),
  execOwner,
  forgetExecOwner,
  agentInfoForOwnedConversation,
  terminateProcessIfUnusedSince: (processId, cutoff) =>
    unifiedExecManager.terminateProcessIfUnusedSince(processId, cutoff)
};

function emptySummary(): RuntimeGcSummary {
  return {
    checked: 0,
    eligible: 0,
    terminated: 0,
    exited: 0,
    missing: 0,
    busy: 0,
    recent: 0,
    unowned: 0,
    ineligible: 0,
    changed: 0
  };
}

function collectibleWorker(info: AgentInfo | null, owner: string, cutoff: number): boolean {
  return Boolean(
    info &&
      info.role === 'worker' &&
      info.state === 'sleeping' &&
      info.revivable &&
      info.conversationId === owner &&
      info.sleptAt !== null &&
      info.sleptAt <= cutoff
  );
}

function sessionGone(result: ConditionalTerminationResult): boolean {
  return result === 'terminated' || result === 'exited' || result === 'missing';
}

/**
 * Retires only UnifiedExec sessions whose exact conversation owner is still a long-sleeping,
 * revivable worker. Broker/history state is read-only here: the worker remains reusable.
 */
export async function sweepAgentRuntimeGc(
  now = Date.now(),
  dependencies: RuntimeGcDependencies = defaultDependencies
): Promise<RuntimeGcSummary> {
  const cutoff = now - AGENT_RUNTIME_RETENTION_MS;
  const summary = emptySummary();

  for (const runtime of dependencies.listRuntimeProcesses()) {
    summary.checked += 1;
    const owner = dependencies.execOwner(runtime.processId);
    if (!owner) {
      summary.unowned += 1;
      continue;
    }
    if (!collectibleWorker(dependencies.agentInfoForOwnedConversation(owner), owner, cutoff)) {
      summary.ineligible += 1;
      continue;
    }

    // The first reads select a candidate. These second reads are the authority immediately
    // before termination: a wake or ownership move that raced this sweep always wins.
    const currentOwner = dependencies.execOwner(runtime.processId);
    if (currentOwner !== owner) {
      summary.changed += 1;
      continue;
    }
    if (!collectibleWorker(dependencies.agentInfoForOwnedConversation(currentOwner), currentOwner, cutoff)) {
      summary.changed += 1;
      continue;
    }

    summary.eligible += 1;
    const result = await dependencies.terminateProcessIfUnusedSince(runtime.processId, cutoff);
    summary[result] += 1;

    if (sessionGone(result)) {
      // A numeric process id is reusable. Never erase attribution that a new session acquired
      // while the awaited process-tree termination was completing.
      if (dependencies.execOwner(runtime.processId) === owner) dependencies.forgetExecOwner(runtime.processId);
    }
  }

  return summary;
}

export interface StartAgentRuntimeGcOptions {
  onError?: (error: Error) => void;
  /** Test seam; production always uses sweepAgentRuntimeGc. */
  sweep?: () => Promise<unknown>;
}

/** Starts one coarse, non-overlapping process-lifetime maintenance loop. */
export function startAgentRuntimeGc(options: StartAgentRuntimeGcOptions = {}): () => void {
  const sweep = options.sweep ?? (() => sweepAgentRuntimeGc());
  let inFlight = false;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void Promise.resolve()
      .then(() => sweep())
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        inFlight = false;
      });
  }, AGENT_RUNTIME_SWEEP_MS);
  (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
