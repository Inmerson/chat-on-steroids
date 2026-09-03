import { describe, expect, it } from 'vitest';

import {
  controlCenterEdgeEndpoints,
  controlCenterNodeTone,
  controlCenterRunMetrics,
  controlCenterTaskInspectorDetails,
  controlCenterTaskMeta,
  computeControlCenterLayout,
  createControlCenterGenerationGate
} from '../src/renderer/control-center.js';

describe('Control Center graph layout', () => {
  const agents = [
    { id: 'worker-2', label: 'Worker 2' },
    { id: 'manager', label: 'Manager' },
    { id: 'worker-1', label: 'Worker 1' }
  ];
  const tasks = [
    { id: 'task-c', dependencies: ['task-a', 'task-b'] },
    { id: 'task-a', dependencies: [] },
    { id: 'task-d', dependencies: ['task-c'] },
    { id: 'task-b', dependencies: ['task-a'] }
  ];

  it('places agents in one left lane and tasks into dependency-depth bands deterministically', () => {
    const first = computeControlCenterLayout({ agents, tasks } as any);
    const second = computeControlCenterLayout({
      agents: [...agents].reverse(),
      tasks: [...tasks].reverse()
    } as any);

    expect(second).toEqual(first);
    expect(first.taskDepths).toEqual({
      'task-a': 0,
      'task-b': 1,
      'task-c': 2,
      'task-d': 3
    });
    expect(new Set(Object.values(first.agents).map((position) => position.x))).toEqual(new Set([24]));
    expect(first.tasks['task-a']!.x).toBeLessThan(first.tasks['task-b']!.x);
    expect(first.tasks['task-b']!.x).toBeLessThan(first.tasks['task-c']!.x);
    expect(first.tasks['task-c']!.x).toBeLessThan(first.tasks['task-d']!.x);
  });

  it('bounds malformed dependency cycles instead of hanging or inventing unbounded depth', () => {
    const layout = computeControlCenterLayout({
      agents: [],
      tasks: [
        { id: 'task-a', dependencies: ['task-b'] },
        { id: 'task-b', dependencies: ['task-a'] }
      ]
    } as any);

    expect(layout.taskDepths).toEqual({ 'task-a': 0, 'task-b': 0 });
    expect(layout.height).toBeGreaterThan(0);
  });

  it('resolves the projector edge discriminants to graph endpoint ids', () => {
    expect(controlCenterEdgeEndpoints({ kind: 'dependency', fromTaskId: 'task-a', toTaskId: 'task-b' })).toEqual([
      'task-a',
      'task-b'
    ]);
    expect(controlCenterEdgeEndpoints({ kind: 'assignment', agentId: 'worker-1', taskId: 'task-a' })).toEqual([
      'worker-1',
      'task-a'
    ]);
    expect(controlCenterEdgeEndpoints({ kind: 'review', agentId: 'reviewer-1', taskId: 'task-a' })).toEqual([
      'reviewer-1',
      'task-a'
    ]);
  });

  it('reads run progress and task ownership from the concrete projector wire contract', () => {
    expect(
      controlCenterRunMetrics({
        run: { health: 'blocked', activeAgents: 4, progress: { verified: 2, total: 5 } },
        tasks: [{ id: 'task-a' }],
        agents: [],
        blockers: [{ id: 'b' }],
        needsAttention: [],
        browser: { budget: 5, used: null }
      })
    ).toMatchObject({ health: 'blocked', verified: 2, total: 5, activeAgents: 4, blockers: 1, browser: '— / 5' });

    expect(
      controlCenterTaskMeta({
        riskClass: 'high',
        assignedWorkerId: 'worker-2',
        verification: { status: 'failed', failed: 1 },
        blockers: ['Verification failed: npm test failed']
      })
    ).toBe('high risk · worker-2 · failed');
  });

  it('normalizes uppercase task machine states before applying semantic tones', () => {
    expect(controlCenterNodeTone('VERIFIED')).toBe(' is-good');
    expect(controlCenterNodeTone('BLOCKED')).toBe(' is-bad');
    expect(controlCenterNodeTone('REVIEWING')).toBe(' is-active');
  });

  it('whitelists projector task detail and can never surface a native worktree path', () => {
    const details = controlCenterTaskInspectorDetails({
      state: 'REVIEWING',
      riskClass: 'high',
      dependencies: ['task-a'],
      assignedWorkerId: 'worker-2',
      reviewerId: 'worker-1',
      reviewRound: 2,
      worktree: {
        id: 'wt-b',
        branch: 'as3/run/task-b',
        virtualPath: '/project/.worktrees/task-b',
        realPath: 'C:\\secret\\native\\task-b'
      },
      verification: {
        status: 'failed',
        total: 1,
        passed: 0,
        failed: 1,
        revision: 'abc123',
        lastFinishedAt: 123,
        error: 'npm test failed'
      },
      blockers: ['Verification failed: npm test failed'],
      changedFiles: ['src/a.ts']
    });

    expect(Object.fromEntries(details.map((entry) => [entry.label, entry.value]))).toMatchObject({
      Risk: 'high',
      Worker: 'worker-2',
      Reviewer: 'worker-1',
      Branch: 'as3/run/task-b',
      Worktree: '/project/.worktrees/task-b',
      Verification: 'failed · 0/1 passed · 1 failed',
      'Verification error': 'npm test failed',
      Blockers: 'Verification failed: npm test failed'
    });
    expect(JSON.stringify(details)).not.toContain('C:\\secret\\native\\task-b');
    expect(JSON.stringify(details)).not.toContain('realPath');
  });
});

describe('Control Center refresh generations', () => {
  it('accepts only the newest monotonically increasing generation', () => {
    const gate = createControlCenterGenerationGate();
    const first = gate.next();
    const second = gate.next();

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });
});
