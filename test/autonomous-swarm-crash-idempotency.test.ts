import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recoverAutonomousSwarmState } from '../src/main/orchestration/recovery.js';
import {
  appendOrchestrationEvent,
  initOrchestrationStore,
  readOrchestrationEvents,
  resetOrchestrationStoreForTests
} from '../src/main/orchestration/store.js';
import type { DispatchLease } from '../src/main/orchestration/types.js';

const cleanup: string[] = [];

afterEach(async () => {
  resetOrchestrationStoreForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-autonomous-crash-'));
  cleanup.push(dir);
  initOrchestrationStore(dir);
}

async function startAndQueue(): Promise<void> {
  await appendOrchestrationEvent({
    eventId: 'swarm-start',
    runId: 'goal-run-1',
    time: 1,
    type: 'SWARM_RUN_STARTED',
    actor: 'kernel',
    entityId: 'goal-run-1',
    payload: {
      primeConversationId: 'prime-A',
      bindingEpoch: 'prime-binding-1',
      objective: 'Complete T1.',
      graphVersion: 1
    }
  });
  await appendOrchestrationEvent({
    eventId: 'queue-T1',
    runId: 'goal-run-1',
    time: 2,
    type: 'DISPATCH_QUEUED',
    actor: 'kernel',
    entityId: 'T1',
    payload: { goalRunId: 'goal-run-1', taskId: 'T1', primeConversationId: 'prime-A' }
  });
}

function lease(browserEpoch: number | null = null): DispatchLease {
  return {
    leaseId: 'lease-1',
    goalRunId: 'goal-run-1',
    taskId: 'T1',
    primeConversationId: 'prime-A',
    workerId: 'worker-1',
    workerRunId: 'broker-run-1',
    conversationId: 'worker-chat-1',
    commandId: 'command-1',
    browserEpoch,
    turnId: null,
    createdAt: 3
  };
}

async function appendLease(value = lease()): Promise<void> {
  await appendOrchestrationEvent({
    eventId: 'lease-T1',
    runId: 'goal-run-1',
    time: 3,
    type: 'DISPATCH_LEASED',
    actor: 'kernel',
    entityId: value.leaseId,
    payload: { lease: value }
  });
}

function exactObservation(options: { browserEpoch?: number; turnId?: string | null; runId?: string } = {}) {
  return {
    ownership: {
      primeConversationId: 'prime-A',
      workerId: 'worker-1',
      runId: options.runId ?? 'broker-run-1'
    },
    browserCommand: {
      commandId: 'command-1',
      conversationId: 'worker-chat-1',
      browserEpoch: options.browserEpoch ?? 7,
      turnId: options.turnId ?? null
    }
  };
}

describe('Serialized Autonomous Swarms crash and idempotency matrix', () => {
  it('crash after queue before lease restores exactly one queued dispatch and publishes nothing', async () => {
    await tempStore();
    await startAndQueue();

    const first = await recoverAutonomousSwarmState(() => exactObservation());
    const second = await recoverAutonomousSwarmState(() => exactObservation());

    expect(first.queue).toHaveLength(1);
    expect(first.queue[0]).toMatchObject({ goalRunId: 'goal-run-1', taskId: 'T1', primeConversationId: 'prime-A' });
    expect(first.activeLeases).toEqual({});
    expect(first.actions).toEqual([]);
    expect(second.queue).toEqual(first.queue);
    expect(second.actions).toEqual([]);
  });

  it('crash after lease before browser publication recovers the same command identity on duplicate recovery', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();

    const observe = () => ({ ...exactObservation(), browserCommand: null });
    const first = await recoverAutonomousSwarmState(observe);
    const second = await recoverAutonomousSwarmState(observe);

    expect(first.actions).toEqual([{ type: 'republish', leaseId: 'lease-1', commandId: 'command-1' }]);
    expect(second.actions).toEqual(first.actions);
    expect(first.activeLeases['lease-1']?.commandId).toBe('command-1');
  });

  it('crash after browser publication before durable commit records the exact receipt and never asks for republish', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();

    const recovered = await recoverAutonomousSwarmState(() => exactObservation({ browserEpoch: 7 }));

    expect(recovered.actions).toEqual([
      { type: 'record_browser_commit', leaseId: 'lease-1', commandId: 'command-1', browserEpoch: 7 }
    ]);
    expect(recovered.actions.some((action) => action.type === 'republish')).toBe(false);
  });

  it('crash after durable browser commit before settlement does not replay the command', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();
    await appendOrchestrationEvent({
      eventId: 'browser-commit-T1',
      runId: 'goal-run-1',
      time: 4,
      type: 'DISPATCH_BROWSER_COMMITTED',
      actor: 'bridge',
      entityId: 'lease-1',
      payload: {
        leaseId: 'lease-1',
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A',
        workerId: 'worker-1',
        workerRunId: 'broker-run-1',
        conversationId: 'worker-chat-1',
        commandId: 'command-1',
        browserEpoch: 7
      }
    });

    const recovered = await recoverAutonomousSwarmState(() => exactObservation({ browserEpoch: 7 }));

    expect(recovered.actions).toEqual([]);
    expect(recovered.activeLeases['lease-1']).toMatchObject({ browserEpoch: 7, commandId: 'command-1' });
  });

  it('crash after settlement observation before durable settlement append preserves an actionable exact turn', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();
    await appendOrchestrationEvent({
      eventId: 'browser-commit-T1',
      runId: 'goal-run-1',
      time: 4,
      type: 'DISPATCH_BROWSER_COMMITTED',
      actor: 'bridge',
      entityId: 'lease-1',
      payload: {
        leaseId: 'lease-1',
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A',
        workerId: 'worker-1',
        workerRunId: 'broker-run-1',
        conversationId: 'worker-chat-1',
        commandId: 'command-1',
        browserEpoch: 7
      }
    });

    const recovered = await recoverAutonomousSwarmState(() => exactObservation({ browserEpoch: 7, turnId: 'turn-1' }));
    const actions = recovered.actions as Array<Record<string, unknown>>;

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ leaseId: 'lease-1', turnId: 'turn-1' });
    expect(actions[0]?.['type']).not.toBe('republish');
  });

  it('stale browser epoch fails closed and never republishes a committed command', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();
    await appendOrchestrationEvent({
      eventId: 'browser-commit-T1',
      runId: 'goal-run-1',
      time: 4,
      type: 'DISPATCH_BROWSER_COMMITTED',
      actor: 'bridge',
      entityId: 'lease-1',
      payload: {
        leaseId: 'lease-1',
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A',
        workerId: 'worker-1',
        workerRunId: 'broker-run-1',
        conversationId: 'worker-chat-1',
        commandId: 'command-1',
        browserEpoch: 7
      }
    });

    const recovered = await recoverAutonomousSwarmState(() => exactObservation({ browserEpoch: 8 }));

    expect(recovered.actions).toHaveLength(1);
    expect(recovered.actions[0]).toMatchObject({ type: 'block', leaseId: 'lease-1' });
    expect(recovered.actions.some((action) => action.type === 'republish')).toBe(false);
  });

  it('ownership incarnation drift fails closed and never republishes', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();

    const recovered = await recoverAutonomousSwarmState(() => ({
      ...exactObservation({ runId: 'broker-run-2' }),
      browserCommand: null
    }));

    expect(recovered.actions).toHaveLength(1);
    expect(recovered.actions[0]).toMatchObject({ type: 'block', leaseId: 'lease-1' });
    expect(recovered.actions.some((action) => action.type === 'republish')).toBe(false);
  });

  it('duplicate identical browser-commit eventId remains one durable journal transition', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();
    const browserCommit = {
      eventId: 'browser-commit-T1',
      runId: 'goal-run-1',
      time: 4,
      type: 'DISPATCH_BROWSER_COMMITTED' as const,
      actor: 'bridge',
      entityId: 'lease-1',
      payload: {
        leaseId: 'lease-1',
        goalRunId: 'goal-run-1',
        taskId: 'T1',
        primeConversationId: 'prime-A',
        workerId: 'worker-1',
        workerRunId: 'broker-run-1',
        conversationId: 'worker-chat-1',
        commandId: 'command-1',
        browserEpoch: 7
      }
    };

    await appendOrchestrationEvent(browserCommit);
    await appendOrchestrationEvent(browserCommit);

    expect((await readOrchestrationEvents()).filter((entry) => entry.eventId === browserCommit.eventId)).toHaveLength(1);
  });

  it('reload after durable settlement has no command left to replay', async () => {
    await tempStore();
    await startAndQueue();
    await appendLease();
    await appendOrchestrationEvent({
      eventId: 'browser-commit-T1',
      runId: 'goal-run-1',
      time: 4,
      type: 'DISPATCH_BROWSER_COMMITTED',
      actor: 'bridge',
      entityId: 'lease-1',
      payload: {
        leaseId: 'lease-1', goalRunId: 'goal-run-1', taskId: 'T1', primeConversationId: 'prime-A',
        workerId: 'worker-1', workerRunId: 'broker-run-1', conversationId: 'worker-chat-1', commandId: 'command-1', browserEpoch: 7
      }
    });
    await appendOrchestrationEvent({
      eventId: 'settled-T1',
      runId: 'goal-run-1',
      time: 5,
      type: 'DISPATCH_SETTLED',
      actor: 'bridge',
      entityId: 'lease-1',
      payload: {
        leaseId: 'lease-1', goalRunId: 'goal-run-1', taskId: 'T1', primeConversationId: 'prime-A',
        workerId: 'worker-1', workerRunId: 'broker-run-1', conversationId: 'worker-chat-1', commandId: 'command-1', browserEpoch: 7,
        turnId: 'turn-1', evidenceRef: 'browser-settled:turn-1'
      }
    });

    const recovered = await recoverAutonomousSwarmState(() => exactObservation({ browserEpoch: 7, turnId: 'turn-1' }));

    expect(recovered.activeLeases).toEqual({});
    expect(recovered.actions).toEqual([]);
  });
});
