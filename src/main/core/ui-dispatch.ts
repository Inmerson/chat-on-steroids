import { z } from 'zod';
import type { CoreUiOperation } from '../../shared/core-protocol.js';
import { tokenPressure } from '../../shared/session.js';
import { bridgeStatus, cancelWorkerCommands, unpair } from '../bridge.js';
import { getConfig } from '../config.js';
import { runDiagnostics } from '../diagnostics.js';
import { listGoalModels, MODEL_PAGE_SIZE } from '../goal.js';
import { controlCenterStatus } from '../orchestration/control-center.js';
import {
  clearAgent,
  persistAgentAuthorityNow,
  resetSwarm,
  swarmState
} from '../agents.js';
import { activeSessionId, forgetSession } from '../session/recorder.js';
import {
  deleteSession,
  getSession,
  listSessionPage,
  readEvents,
  readHandoff,
  readRecentEvents
} from '../session/store.js';

const idSchema = z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i);
const agentIdSchema = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i);

export interface CoreUiDispatcherDeps {
  bridgeStatus: () => Promise<unknown>;
  unpair: () => Promise<void>;
  listSessions: (payload: { cursor?: { updatedAt: number; id: string }; limit?: number }) => Promise<unknown>;
  sessionEvents: (payload: { id: string; from?: number; limit?: number }) => Promise<unknown>;
  deleteSession: (id: string) => Promise<boolean>;
  handoff: (payload: { id: string; handoffId?: string }) => Promise<unknown>;
  swarm: () => unknown;
  resetSwarm: () => Promise<unknown>;
  clearAgent: (id: string) => Promise<unknown>;
  controlCenter: () => Promise<unknown> | unknown;
  goalModels: (offset: number) => Promise<unknown>;
  diagnostics: () => Promise<unknown>;
}

export type CoreUiDispatcher = (operation: CoreUiOperation, payload: unknown) => Promise<unknown>;

export function createCoreUiDispatcher(deps: CoreUiDispatcherDeps): CoreUiDispatcher {
  return async (operation, payload) => {
    switch (operation) {
      case 'bridge-status':
        z.null().parse(payload);
        return deps.bridgeStatus();
      case 'bridge-unpair':
        z.null().parse(payload);
        await deps.unpair();
        return true;
      case 'session-list': {
        const value = z
          .object({
            cursor: z.object({ updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), id: idSchema }).optional(),
            limit: z.number().int().min(1).max(60).optional()
          })
          .parse(payload ?? {});
        return deps.listSessions(value);
      }
      case 'session-events': {
        const value = z
          .object({
            id: idSchema,
            from: z.number().int().min(0).max(10_000_000).optional(),
            limit: z.number().int().min(1).max(1000).optional()
          })
          .parse(payload);
        return deps.sessionEvents(value);
      }
      case 'session-delete': {
        const { id } = z.object({ id: idSchema }).parse(payload);
        return deps.deleteSession(id);
      }
      case 'handoff-get': {
        const value = z.object({ id: idSchema, handoffId: idSchema.optional() }).parse(payload);
        return deps.handoff(value);
      }
      case 'swarm-get':
        z.null().parse(payload);
        return deps.swarm();
      case 'swarm-reset':
        z.null().parse(payload);
        return deps.resetSwarm();
      case 'swarm-clear-agent': {
        const { id } = z.object({ id: agentIdSchema }).parse(payload);
        return deps.clearAgent(id);
      }
      case 'control-center-status':
        z.null().parse(payload);
        return deps.controlCenter();
      case 'goal-models': {
        const { offset } = z.object({ offset: z.number().int().min(0).max(2000).default(0) }).parse(payload ?? {});
        return deps.goalModels(offset);
      }
      case 'diagnostics-run':
        z.null().parse(payload);
        return deps.diagnostics();
    }
  };
}

const defaultDeps: CoreUiDispatcherDeps = {
  bridgeStatus,
  unpair,
  listSessions: async ({ cursor, limit }) => {
    const config = getConfig();
    const page = await listSessionPage({ cursor, limit: limit ?? 60 });
    return {
      sessions: page.sessions,
      total: page.total,
      nextCursor: page.nextCursor,
      activeId: activeSessionId(),
      pressure: page.sessions.map((summary) => ({
        id: summary.id,
        ...tokenPressure(summary.estimatedTokens, config.sessions.advisoryTokens, config.sessions.limitTokens)
      }))
    };
  },
  sessionEvents: async ({ id, from, limit }) => {
    const summary = await getSession(id);
    if (!summary) throw new Error('Session not found');
    const cap = limit ?? 160;
    if (from === undefined) {
      const events = await readRecentEvents(id, cap);
      const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
      return { summary, events, total: summary.events, nextFrom };
    }
    const events = await readEvents(id, { from, limit: cap });
    const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), from);
    return { summary, events, total: summary.events, nextFrom };
  },
  deleteSession: async (id) => {
    const detached = forgetSession(id);
    await deleteSession(id);
    void detached;
    return true;
  },
  handoff: async ({ id, handoffId }) => {
    if (handoffId) return readHandoff(id, handoffId);
    const summary = await getSession(id);
    return summary?.lastHandoffId ? readHandoff(id, summary.lastHandoffId) : null;
  },
  swarm: swarmState,
  resetSwarm: async () => {
    resetSwarm();
    if (!(await persistAgentAuthorityNow())) {
      throw new Error('The cleared run could not be made durable. Retry clearing the swarm.');
    }
    return swarmState();
  },
  clearAgent: async (id) => {
    const outcome = clearAgent(id);
    if (outcome.cleared !== 'none') {
      if (!(await persistAgentAuthorityNow())) {
        throw new Error('The agent clear could not be made durable. Retry the clear action.');
      }
      if (outcome.cleared === 'worker') cancelWorkerCommands(outcome.reason, id);
    }
    return { cleared: outcome.cleared, reason: outcome.reason, swarm: swarmState() };
  },
  controlCenter: controlCenterStatus,
  goalModels: (offset) => listGoalModels(offset, MODEL_PAGE_SIZE),
  diagnostics: runDiagnostics
};

export const coreUiDispatcher = createCoreUiDispatcher(defaultDeps);
