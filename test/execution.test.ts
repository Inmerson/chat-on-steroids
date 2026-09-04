import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionSnapshot } from '../src/main/execution.js';

const durable = await import('../src/main/durable.js');
const execution = await import('../src/main/execution.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-execution-');
  durable.initDurableStore(dir);
});

afterAll(async () => {
  execution.resetExecutionsForTests();
  durable.resetDurableForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  execution.resetExecutionsForTests();
  await durable.writeDurableNow(execution.EXECUTION_STATE, null);
});

describe('durable autonomous execution runs', () => {
  it('persists the full approved plan before returning a starting run', async () => {
    const plan = 'Implement the approved recovery plan.';

    const run = await execution.createExecution({ plan, mode: 'standard' });
    const stored = await durable.readDurable<ExecutionSnapshot>(execution.EXECUTION_STATE);

    expect(run).toMatchObject({ plan, mode: 'standard', status: 'starting', conversationId: null, commandId: null });
    expect(stored?.runs.find((row) => row.id === run.id)?.plan).toBe(plan);
  });

  it('rejects empty and oversized plans before creating a run', async () => {
    await expect(execution.createExecution({ plan: '   ', mode: 'standard' })).rejects.toThrow(/plan/i);
    await expect(
      execution.createExecution({ plan: 'x'.repeat(execution.MAX_EXECUTION_PLAN_CHARS + 1), mode: 'standard' })
    ).rejects.toThrow(/plan/i);

    expect(execution.snapshotExecutions().runs).toEqual([]);
  });

  it('restores only valid bounded runs from a snapshot', async () => {
    const created = await execution.createExecution({
      plan: 'Finish the exact parser migration and verify it.',
      title: 'Parser migration',
      mode: 'infinite'
    });
    const snapshot = execution.snapshotExecutions();

    execution.resetExecutionsForTests();
    expect(execution.executionRun(created.id)).toBeNull();

    execution.restoreExecutions(snapshot);
    expect(execution.executionRun(created.id)).toEqual(created);
    expect(execution.executionForConversation('not-bound')).toBeNull();
  });

  it('keeps one conversation bound to at most one execution run', async () => {
    const first = await execution.createExecution({ plan: 'Run first plan.', mode: 'standard' });
    const second = await execution.createExecution({ plan: 'Run second plan.', mode: 'standard' });

    await execution.bindExecutionConversation(first.id, 'conversation-12345678');
    await expect(execution.bindExecutionConversation(second.id, 'conversation-12345678')).rejects.toThrow(
      /conversation.*execution/i
    );

    expect(execution.executionForConversation('conversation-12345678')?.id).toBe(first.id);
    expect(execution.executionRun(second.id)?.conversationId).toBeNull();
  });

  it('makes pause and stop idempotent without changing the original stop timestamp', async () => {
    const run = await execution.createExecution({ plan: 'Run the bounded plan.', mode: 'standard' });

    const paused = await execution.setExecutionStatus(run.id, 'paused');
    const pausedAgain = await execution.setExecutionStatus(run.id, 'paused');
    expect(pausedAgain).toEqual(paused);

    const stopped = await execution.setExecutionStatus(run.id, 'stopped');
    const stoppedAgain = await execution.setExecutionStatus(run.id, 'stopped');
    expect(stoppedAgain).toEqual(stopped);
    expect(stopped.stoppedAt).not.toBeNull();
  });

  it('rolls live state back when a durable mutation fails', async () => {
    const run = await execution.createExecution({ plan: 'Keep the durable boundary exact.', mode: 'standard' });
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));

    await expect(execution.setExecutionStatus(run.id, 'running')).rejects.toThrow('disk full');
    expect(execution.executionRun(run.id)?.status).toBe('starting');
  });
});

describe('execution bootstrap framing', () => {
  it('keeps standard mode inside the approved plan and uses English first-party framing', async () => {
    const plan = 'Implement only the approved durable execution model.';
    const run = await execution.createExecution({ plan, mode: 'standard' });

    const text = execution.executionBootstrapText(run.id);

    expect(text).toContain('@Chat On Steroids Core');
    expect(text).toContain('Execute only the approved plan below autonomously.');
    expect(text).toContain('Do not expand into unrelated feature work.');
    expect(text).toContain(`APPROVED PLAN\n${plan}`);
    expect(text).not.toMatch(/[\u00e7\u011f\u0131\u00f6\u015f\u00fc\u0130]/i);
  });

  it('allows infinite mode to choose a new improvement only after the current milestone is verified', async () => {
    const run = await execution.createExecution({ plan: 'Complete milestone A.', mode: 'infinite' });

    expect(execution.executionBootstrapText(run.id)).toContain(
      'Only after this milestone is verified complete, you may select the next highest-value improvement and continue.'
    );
  });
});
