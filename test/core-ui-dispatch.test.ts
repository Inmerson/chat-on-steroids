import { describe, expect, it, vi } from 'vitest';
import { createCoreUiDispatcher } from '../src/main/core/ui-dispatch.js';

function deps() {
  return {
    bridgeStatus: vi.fn(async () => ({ running: true, port: 8765, paired: true, present: true, lastSeenAt: 10, extensionVersion: '2.1.2' })),
    unpair: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => ({ sessions: [], total: 0, nextCursor: null, activeId: null, pressure: [] })),
    sessionEvents: vi.fn(async () => ({ summary: null, events: [], total: 0, nextFrom: 0 })),
    deleteSession: vi.fn(async () => true),
    handoff: vi.fn(async () => null),
    swarm: vi.fn(() => ({ running: false, agents: [] })),
    resetSwarm: vi.fn(async () => ({ running: false, agents: [] })),
    clearAgent: vi.fn(async () => ({ cleared: 'none', reason: 'not found', swarm: { running: false, agents: [] } })),
    controlCenter: vi.fn(async () => ({ state: 'idle' })),
    goalModels: vi.fn(async () => ({ models: [], total: 0 }))
  };
}

describe('Core-owned UI runtime dispatch', () => {
  it('routes bridge/session/swarm reads through the Core owner', async () => {
    const d = deps();
    const dispatch = createCoreUiDispatcher(d as never);

    await expect(dispatch('bridge-status', null)).resolves.toMatchObject({ running: true, port: 8765 });
    await expect(dispatch('session-list', { limit: 60 })).resolves.toMatchObject({ total: 0 });
    await expect(dispatch('swarm-get', null)).resolves.toMatchObject({ running: false });

    expect(d.bridgeStatus).toHaveBeenCalledTimes(1);
    expect(d.listSessions).toHaveBeenCalledWith({ limit: 60 });
    expect(d.swarm).toHaveBeenCalledTimes(1);
  });

  it('keeps mutating bridge/swarm operations inside Core', async () => {
    const d = deps();
    const dispatch = createCoreUiDispatcher(d as never);

    await dispatch('bridge-unpair', null);
    await dispatch('swarm-reset', null);
    await dispatch('swarm-clear-agent', { id: 'worker-1' });

    expect(d.unpair).toHaveBeenCalledTimes(1);
    expect(d.resetSwarm).toHaveBeenCalledTimes(1);
    expect(d.clearAgent).toHaveBeenCalledWith('worker-1');
  });

  it('validates payloads again at the Core trust boundary', async () => {
    const dispatch = createCoreUiDispatcher(deps() as never);

    await expect(dispatch('session-delete', { id: '../escape' })).rejects.toThrow();
    await expect(dispatch('swarm-clear-agent', { id: '' })).rejects.toThrow();
    await expect(dispatch('goal-models', { offset: -1 })).rejects.toThrow();
  });
});
