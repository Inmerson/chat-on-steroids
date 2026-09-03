import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import {
  applyControlCenterGraphFilter,
  applyControlCenterGraphFocus,
  applyControlCenterGraphSearch,
  controlCenterBlockerInspectorDetails,
  controlCenterConnectedNodeIds,
  controlCenterEdgeEndpoints,
  controlCenterFilterNodeIds,
  controlCenterFilterTaskIds,
  controlCenterFilterAvailable,
  controlCenterNodeTone,
  controlCenterRunMetrics,
  controlCenterSearchMatches,
  controlCenterSearchNodeIds,
  controlCenterTaskInspectorDetails,
  controlCenterTaskMeta,
  computeControlCenterLayout,
  createControlCenterGenerationGate,
  nextControlCenterFilter,
  nextControlCenterSelection
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

  it('places agents in one left lane and wraps deep dependency bands into two non-overlapping task columns', () => {
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
    expect(first.tasks['task-c']!.x).toBe(first.tasks['task-a']!.x);
    expect(first.tasks['task-d']!.x).toBe(first.tasks['task-b']!.x);
    expect(first.tasks['task-c']!.y).toBeGreaterThan(first.tasks['task-a']!.y + 68);
    expect(first.tasks['task-d']!.y).toBeGreaterThan(first.tasks['task-b']!.y + 68);
    expect(first.width).toBeLessThan(800);
  });

  it('keeps multiple tasks in the same wrapped depth from overlapping the next depth group', () => {
    const layout = computeControlCenterLayout({
      agents: [],
      tasks: [
        { id: 'root-a', dependencies: [] },
        { id: 'root-b', dependencies: [] },
        { id: 'middle-a', dependencies: ['root-a'] },
        { id: 'middle-b', dependencies: ['root-b'] },
        { id: 'deep', dependencies: ['middle-a', 'middle-b'] }
      ]
    } as any);

    expect(layout.tasks.deep!.x).toBe(layout.tasks['root-a']!.x);
    expect(layout.tasks.deep!.y).toBeGreaterThan(layout.tasks['root-b']!.y + 68);
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

  it('focuses only the selected node and its directly connected graph neighbours', () => {
    const status = {
      edges: [
        { kind: 'dependency', fromTaskId: 'task-a', toTaskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-1', taskId: 'task-b' },
        { kind: 'review', agentId: 'reviewer-1', taskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-2', taskId: 'task-c' }
      ]
    };

    expect(controlCenterConnectedNodeIds(status, { kind: 'task', id: 'task-b' })).toEqual([
      'reviewer-1',
      'task-a',
      'task-b',
      'worker-1'
    ]);
    expect(controlCenterConnectedNodeIds(status, { kind: 'agent', id: 'worker-1' })).toEqual(['task-b', 'worker-1']);
    expect(controlCenterConnectedNodeIds(status, null)).toEqual([]);
  });

  it('applies selection focus to the existing graph DOM without rebuilding nodes', () => {
    const dom = new JSDOM(`
      <button class="control-node" data-node-kind="task" data-node-id="task-a" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="task" data-node-id="task-b" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="agent" data-node-id="worker-1" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="agent" data-node-id="worker-2" aria-pressed="false"></button>
      <svg>
        <path class="control-edge" data-from-id="task-a" data-to-id="task-b"></path>
        <path class="control-edge" data-from-id="worker-1" data-to-id="task-b"></path>
        <path class="control-edge" data-from-id="worker-2" data-to-id="task-c"></path>
      </svg>
    `);
    const status = {
      edges: [
        { kind: 'dependency', fromTaskId: 'task-a', toTaskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-1', taskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-2', taskId: 'task-c' }
      ]
    };

    applyControlCenterGraphFocus(dom.window.document, status, { kind: 'task', id: 'task-b' });

    const taskB = dom.window.document.querySelector<HTMLElement>('[data-node-id="task-b"]')!;
    const worker1 = dom.window.document.querySelector<HTMLElement>('[data-node-id="worker-1"]')!;
    const worker2 = dom.window.document.querySelector<HTMLElement>('[data-node-id="worker-2"]')!;
    const edges = [...dom.window.document.querySelectorAll<HTMLElement>('.control-edge')];
    expect(taskB.getAttribute('aria-pressed')).toBe('true');
    expect(worker1.classList.contains('is-related')).toBe(true);
    expect(worker2.classList.contains('is-dimmed')).toBe(true);
    expect(edges[0]!.classList.contains('is-related')).toBe(true);
    expect(edges[2]!.classList.contains('is-dimmed')).toBe(true);
  });

  it('clears selection when the already-selected node is activated again', () => {
    const selected = { kind: 'task' as const, id: 'task-b' };
    expect(nextControlCenterSelection(selected, selected)).toBeNull();
    expect(nextControlCenterSelection(null, selected)).toEqual(selected);
  });

  it('groups task filters by observable state while treating explicit task blockers as blocked', () => {
    const status = {
      tasks: [
        { id: 'task-v', state: 'VERIFIED', blockers: [] },
        { id: 'task-a', state: 'ACTIVE', blockers: [] },
        { id: 'task-b', state: 'INTEGRATED', blockers: ['Verification failed'] },
        { id: 'task-n', state: 'READY', blockers: [] }
      ],
      edges: [
        { kind: 'dependency', fromTaskId: 'task-a', toTaskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-2', taskId: 'task-b' }
      ]
    };

    expect(controlCenterFilterTaskIds(status, 'verified')).toEqual(['task-v']);
    expect(controlCenterFilterTaskIds(status, 'active')).toEqual(['task-a']);
    expect(controlCenterFilterTaskIds(status, 'blocked')).toEqual(['task-b']);
    expect(controlCenterFilterTaskIds(status, 'neutral')).toEqual(['task-n']);
    expect(controlCenterFilterNodeIds(status, 'blocked')).toEqual(['task-a', 'task-b', 'worker-2']);
  });

  it('applies a task-state filter to the existing graph without pretending it is a node selection', () => {
    const dom = new JSDOM(`
      <button class="control-node" data-node-kind="task" data-node-id="task-a" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="task" data-node-id="task-b" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="agent" data-node-id="worker-1" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="agent" data-node-id="worker-2" aria-pressed="false"></button>
      <svg>
        <path class="control-edge" data-from-id="worker-1" data-to-id="task-a"></path>
        <path class="control-edge" data-from-id="worker-2" data-to-id="task-b"></path>
      </svg>
    `);
    const status = {
      tasks: [
        { id: 'task-a', state: 'ACTIVE', blockers: [] },
        { id: 'task-b', state: 'INTEGRATED', blockers: ['Verification failed'] }
      ],
      edges: [
        { kind: 'assignment', agentId: 'worker-1', taskId: 'task-a' },
        { kind: 'assignment', agentId: 'worker-2', taskId: 'task-b' }
      ]
    };

    applyControlCenterGraphFilter(dom.window.document, status, 'blocked');

    const taskA = dom.window.document.querySelector<HTMLElement>('[data-node-id="task-a"]')!;
    const taskB = dom.window.document.querySelector<HTMLElement>('[data-node-id="task-b"]')!;
    const worker2 = dom.window.document.querySelector<HTMLElement>('[data-node-id="worker-2"]')!;
    const edges = [...dom.window.document.querySelectorAll<HTMLElement>('.control-edge')];
    expect(taskA.classList.contains('is-dimmed')).toBe(true);
    expect(taskB.classList.contains('is-related')).toBe(true);
    expect(worker2.classList.contains('is-related')).toBe(true);
    expect(taskB.getAttribute('aria-pressed')).toBe('false');
    expect(edges[0]!.classList.contains('is-dimmed')).toBe(true);
    expect(edges[1]!.classList.contains('is-related')).toBe(true);
  });

  it('toggles the same task-state filter off without manufacturing an attention filter', () => {
    expect(nextControlCenterFilter(null, 'blocked')).toBe('blocked');
    expect(nextControlCenterFilter('blocked', 'blocked')).toBeNull();
    expect(nextControlCenterFilter('blocked', 'verified')).toBe('verified');
  });

  it('keeps a blocked focus available for global blockers even when no task node is blocked', () => {
    const status = {
      tasks: [{ id: 'task-a', state: 'ACTIVE', blockers: [] }],
      blockers: [{ id: 'integration:failed', kind: 'integration', taskId: null, summary: 'Integration failed.' }]
    };

    expect(controlCenterFilterTaskIds(status, 'blocked')).toEqual([]);
    expect(controlCenterFilterAvailable(status, 'blocked')).toBe(true);
    expect(controlCenterFilterAvailable(status, 'verified')).toBe(false);
  });

  it('whitelists authoritative blocker detail for the Inspector', () => {
    const details = controlCenterBlockerInspectorDetails({
      blockers: [
        { id: 'task:task-b:blocked', kind: 'task', taskId: 'task-b', summary: 'Waiting for dependency.' },
        { id: 'verification:failed', kind: 'verification', taskId: null, summary: 'Verification failed.' }
      ]
    });

    expect(details).toEqual([
      { id: 'task:task-b:blocked', kind: 'task', taskId: 'task-b', summary: 'Waiting for dependency.' },
      { id: 'verification:failed', kind: 'verification', taskId: null, summary: 'Verification failed.' }
    ]);
  });

  it('finds agents and tasks by durable id or visible label/title without case sensitivity', () => {
    const status = {
      agents: [
        { id: 'worker-2', label: 'Reviewer Alpha' },
        { id: 'manager', label: 'Manager' }
      ],
      tasks: [
        { id: 'task-control', title: 'Build Control Center projector' },
        { id: 'task-render', title: 'Render agent canvas' }
      ]
    };

    expect(controlCenterSearchMatches(status, ' CONTROL ')).toEqual([{ kind: 'task', id: 'task-control' }]);
    expect(controlCenterSearchMatches(status, 'WORKER-2')).toEqual([{ kind: 'agent', id: 'worker-2' }]);
    expect(controlCenterSearchMatches(status, 'reviewer alpha')).toEqual([{ kind: 'agent', id: 'worker-2' }]);
    expect(controlCenterSearchMatches(status, '')).toEqual([]);
  });

  it('keeps direct graph context around search matches instead of hiding unrelated structure', () => {
    const status = {
      agents: [
        { id: 'worker-1', label: 'Worker 1' },
        { id: 'worker-2', label: 'Worker 2' }
      ],
      tasks: [
        { id: 'task-a', title: 'Foundation' },
        { id: 'task-b', title: 'Control Center projector' },
        { id: 'task-c', title: 'Unrelated docs' }
      ],
      edges: [
        { kind: 'dependency', fromTaskId: 'task-a', toTaskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-2', taskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-1', taskId: 'task-c' }
      ]
    };

    expect(controlCenterSearchNodeIds(status, 'projector')).toEqual(['task-a', 'task-b', 'worker-2']);
  });

  it('applies search focus without marking any node as a selected inspector target', () => {
    const dom = new JSDOM(`
      <button class="control-node" data-node-kind="task" data-node-id="task-a" aria-pressed="true"></button>
      <button class="control-node" data-node-kind="task" data-node-id="task-b" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="agent" data-node-id="worker-1" aria-pressed="false"></button>
      <button class="control-node" data-node-kind="agent" data-node-id="worker-2" aria-pressed="false"></button>
      <svg>
        <path class="control-edge" data-from-id="task-a" data-to-id="task-b"></path>
        <path class="control-edge" data-from-id="worker-2" data-to-id="task-b"></path>
        <path class="control-edge" data-from-id="worker-1" data-to-id="task-c"></path>
      </svg>
    `);
    const status = {
      agents: [
        { id: 'worker-1', label: 'Worker 1' },
        { id: 'worker-2', label: 'Worker 2' }
      ],
      tasks: [
        { id: 'task-a', title: 'Foundation' },
        { id: 'task-b', title: 'Control Center projector' },
        { id: 'task-c', title: 'Unrelated docs' }
      ],
      edges: [
        { kind: 'dependency', fromTaskId: 'task-a', toTaskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-2', taskId: 'task-b' },
        { kind: 'assignment', agentId: 'worker-1', taskId: 'task-c' }
      ]
    };

    applyControlCenterGraphSearch(dom.window.document, status, 'projector');

    const taskB = dom.window.document.querySelector<HTMLElement>('[data-node-id="task-b"]')!;
    const worker2 = dom.window.document.querySelector<HTMLElement>('[data-node-id="worker-2"]')!;
    const worker1 = dom.window.document.querySelector<HTMLElement>('[data-node-id="worker-1"]')!;
    expect(taskB.classList.contains('is-related')).toBe(true);
    expect(worker2.classList.contains('is-related')).toBe(true);
    expect(worker1.classList.contains('is-dimmed')).toBe(true);
    expect(taskB.getAttribute('aria-pressed')).toBe('false');
    expect(dom.window.document.querySelector<HTMLElement>('[data-node-id="task-a"]')!.getAttribute('aria-pressed')).toBe('false');
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
