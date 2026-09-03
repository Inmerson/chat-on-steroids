import { swarmStateForCaller } from '../agents.js';
import { browserAgentTabTelemetry, browserPresent, type BrowserAgentTabTelemetry } from '../bridge.js';
import type { AgentInfo, SwarmState } from '../../shared/session.js';
import {
  CONTROL_CENTER_BROWSER_BUDGET,
  CONTROL_CENTER_VERSION,
  type ControlCenterAgentRole,
  type ControlCenterAgentStatus,
  type ControlCenterBlocker,
  type ControlCenterEdge,
  type ControlCenterRunHealth,
  type ControlCenterStatus,
  type ControlCenterTaskStatus,
  type ControlCenterVerificationSummary
} from '../../shared/control-center.js';
import { recoverOrchestrationState } from './recovery.js';
import { managerRuntimeForRun } from './manager-authority.js';
import type { OrchestrationState } from './reducer.js';
import type { TaskRecord } from './types.js';
import { workflowStateForRun, type ReviewRecord, type RunWorkflowState } from './workflow.js';

const BROWSER_NOTE = 'Agent-tab lease telemetry is unavailable; unmanaged user ChatGPT tabs are never inferred as agent usage.';
// Keep telemetry no older than the bridge's existing one-minute browser-presence evidence window.
const BROWSER_TELEMETRY_FRESH_MS = 60_000;
const ROLE_ORDER: readonly ControlCenterAgentRole[] = ['prime', 'manager', 'worker', 'reviewer', 'system_reviewer'];

interface ReviewProjection {
  reviewerId: string | null;
  round: number;
}

interface AgentAccumulator {
  broker: AgentInfo | null;
  roles: Set<ControlCenterAgentRole>;
  boundTaskIds: Set<string>;
  reviewedTaskIds: Set<string>;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function knownNativePaths(state: OrchestrationState, workflow: RunWorkflowState | null): string[] {
  const paths = [
    ...Object.values(state.worktrees).map((worktree) => worktree.realPath),
    workflow?.integrationWorktree?.realPath ?? ''
  ].filter((value): value is string => value.length > 0);
  return [...new Set(paths)].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function redactNativePathText(value: string, paths: readonly string[]): string {
  let redacted = value;
  for (const nativePath of paths) {
    const variants = new Set([
      nativePath,
      nativePath.replace(/\\/g, '/'),
      nativePath.replace(/\//g, '\\')
    ]);
    for (const variant of variants) {
      if (!variant) continue;
      // Drive-letter paths are case-insensitive on Windows. Treat their textual variants the
      // same way even when this projector is exercised from a non-Windows test runner.
      const flags = /^[a-z]:[\\/]/i.test(variant) ? 'gi' : 'g';
      redacted = redacted.replace(new RegExp(regexEscape(variant), flags), '[native path hidden]');
    }
  }
  return redacted;
}

function redactProjectionValue<T>(value: T, paths: readonly string[]): T {
  if (typeof value === 'string') return redactNativePathText(value, paths) as T;
  if (Array.isArray(value)) return value.map((entry) => redactProjectionValue(entry, paths)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactProjectionValue(entry, paths)])
    ) as T;
  }
  return value;
}

function browserStatus(telemetry: BrowserAgentTabTelemetry | null, observedAt: number): ControlCenterStatus['browser'] {
  const age = telemetry ? observedAt - telemetry.receivedAt : Number.POSITIVE_INFINITY;
  if (telemetry && age >= 0 && age < BROWSER_TELEMETRY_FRESH_MS) {
    return {
      budget: CONTROL_CENTER_BROWSER_BUDGET,
      used: telemetry.used,
      queued: telemetry.queued,
      status: 'available',
      note: null
    };
  }
  return {
    budget: CONTROL_CENTER_BROWSER_BUDGET,
    used: null,
    queued: null,
    status: 'unavailable',
    note: BROWSER_NOTE
  };
}

function matchingWorkflow(state: OrchestrationState, workflow: RunWorkflowState | null): RunWorkflowState | null {
  if (!state.runId || workflow?.runId !== state.runId) return null;
  return workflow;
}

function latestReview(records: readonly ReviewRecord[]): ReviewRecord | null {
  return records.length > 0 ? (records[records.length - 1] ?? null) : null;
}

function reviewProjection(task: TaskRecord, workflow: RunWorkflowState | null): ReviewProjection {
  const current = workflow?.reviews[task.taskId] ?? null;
  const historical = latestReview(workflow?.reviewHistory[task.taskId] ?? []);
  const review = current ?? historical;
  return {
    reviewerId: review?.reviewerId ?? task.reviewerId,
    round: review?.round ?? task.reviewRound
  };
}

function verificationSummary(taskId: string, workflow: RunWorkflowState | null): ControlCenterVerificationSummary {
  const records = workflow?.verifications[taskId] ?? [];
  const operation = workflow?.verificationOperations[taskId] ?? null;
  const passed = records.filter((record) => record.passed).length;
  const failed = records.length - passed;
  const revisions = [...new Set(records.map((record) => record.revision))];
  const evidenceRevision = revisions.length === 1 ? (revisions[0] ?? null) : null;
  const revision = evidenceRevision ?? operation?.revision ?? null;
  const lastFinishedAt = records.length > 0 ? Math.max(...records.map((record) => record.finishedAt)) : null;
  const currentRevision = workflow?.integrationWorktree?.headRevision ?? null;

  let status: ControlCenterVerificationSummary['status'];
  if (operation?.status === 'pending') status = 'pending';
  else if (operation?.status === 'failed') status = 'failed';
  else if (records.length === 0) status = 'none';
  else if (failed > 0) status = 'failed';
  else if (!currentRevision || records.some((record) => record.revision !== currentRevision)) status = 'stale';
  else status = 'passed';

  return {
    status,
    revision,
    total: records.length,
    passed,
    failed,
    lastFinishedAt,
    error: operation?.error ?? null
  };
}

function reviewBlockedSummary(taskId: string, workflow: RunWorkflowState | null): string | null {
  const history = workflow?.reviewHistory[taskId] ?? [];
  const blocked = [...history].reverse().find((record) => record.verdict === 'BLOCKED') ?? null;
  if (!blocked) return null;
  const detail = blocked.findings.join(' | ').trim();
  return detail ? `Review blocked: ${detail}` : 'Review blocked.';
}

function blockerForTask(
  task: TaskRecord,
  workflow: RunWorkflowState | null,
  verification: ControlCenterVerificationSummary
): ControlCenterBlocker[] {
  const blockers: ControlCenterBlocker[] = [];

  if (task.state === 'BLOCKED') {
    blockers.push({
      id: `task:${task.taskId}:blocked`,
      kind: 'task',
      taskId: task.taskId,
      summary: reviewBlockedSummary(task.taskId, workflow) ?? 'Task is blocked.'
    });
  } else if (task.state === 'FAILED') {
    blockers.push({ id: `task:${task.taskId}:failed`, kind: 'task', taskId: task.taskId, summary: 'Task failed.' });
  }

  const integration = workflow?.integrations[task.taskId] ?? null;
  if (integration && (integration.status === 'ambiguous' || integration.error)) {
    blockers.push({
      id: `task:${task.taskId}:integration`,
      kind: 'integration',
      taskId: task.taskId,
      summary: `Integration blocked: ${integration.error ?? 'integration state is ambiguous'}`
    });
  }

  if (verification.status === 'failed') {
    const failedGates = (workflow?.verifications[task.taskId] ?? [])
      .filter((record) => !record.passed)
      .map((record) => record.gate)
      .sort();
    const detail = verification.error ?? (failedGates.length > 0 ? `${failedGates.join(', ')} failed` : 'verification operation failed');
    blockers.push({
      id: `task:${task.taskId}:verification`,
      kind: 'verification',
      taskId: task.taskId,
      summary: `Verification failed: ${detail}`
    });
  } else if (verification.status === 'stale') {
    blockers.push({
      id: `task:${task.taskId}:verification`,
      kind: 'verification',
      taskId: task.taskId,
      summary: 'Verification evidence is stale for the current integration revision.'
    });
  }

  return blockers;
}

function taskProjection(task: TaskRecord, state: OrchestrationState, workflow: RunWorkflowState | null): {
  task: ControlCenterTaskStatus;
  blockers: ControlCenterBlocker[];
  review: ReviewProjection;
} {
  const review = reviewProjection(task, workflow);
  const completion = workflow?.completions[task.taskId] ?? task.completionPackage;
  const verification = verificationSummary(task.taskId, workflow);
  const blockers = blockerForTask(task, workflow, verification);
  const worktree = task.worktreeId ? state.worktrees[task.worktreeId] ?? null : null;
  return {
    task: {
      id: task.taskId,
      title: task.title,
      goal: task.goal,
      state: task.state,
      riskClass: task.riskClass,
      dependencies: [...task.dependencies].sort((a, b) => a.localeCompare(b)),
      assignedWorkerId: task.assignedWorkerId,
      reviewerId: review.reviewerId,
      reviewRound: review.round,
      worktree: worktree ? { id: worktree.worktreeId, branch: worktree.branch, virtualPath: worktree.virtualPath } : null,
      changedFiles: [...new Set(completion?.changedFiles ?? [])].sort((a, b) => a.localeCompare(b)),
      verification,
      blockers: blockers.map((blocker) => blocker.summary),
      lastActivityAt: verification.lastFinishedAt
    },
    blockers,
    review
  };
}

function ensureAgent(accumulators: Map<string, AgentAccumulator>, id: string): AgentAccumulator {
  const existing = accumulators.get(id);
  if (existing) return existing;
  const created: AgentAccumulator = { broker: null, roles: new Set(), boundTaskIds: new Set(), reviewedTaskIds: new Set() };
  accumulators.set(id, created);
  return created;
}

function addReviewerReference(accumulators: Map<string, AgentAccumulator>, taskId: string, reviewerId: string | null): void {
  if (!reviewerId) return;
  const agent = ensureAgent(accumulators, reviewerId);
  agent.roles.add('reviewer');
  agent.reviewedTaskIds.add(taskId);
}

function projectAgents(
  state: OrchestrationState,
  workflow: RunWorkflowState | null,
  swarm: SwarmState,
  projectedTasks: readonly ControlCenterTaskStatus[]
): ControlCenterAgentStatus[] {
  const accumulators = new Map<string, AgentAccumulator>();

  for (const broker of swarm.agents) {
    const agent = ensureAgent(accumulators, broker.id);
    agent.broker = broker;
    agent.roles.add(broker.role === 'prime' ? 'prime' : 'worker');
  }

  if (state.managerAgentId) ensureAgent(accumulators, state.managerAgentId).roles.add('manager');

  for (const task of projectedTasks) {
    if (task.assignedWorkerId) {
      const agent = ensureAgent(accumulators, task.assignedWorkerId);
      agent.roles.add('worker');
      agent.boundTaskIds.add(task.id);
    }
    addReviewerReference(accumulators, task.id, task.reviewerId);
  }

  for (const [taskId, history] of Object.entries(workflow?.reviewHistory ?? {})) {
    for (const review of history) addReviewerReference(accumulators, taskId, review.reviewerId);
  }
  for (const [taskId, review] of Object.entries(workflow?.reviews ?? {})) addReviewerReference(accumulators, taskId, review.reviewerId);

  if (workflow?.systemReview?.reviewerId) {
    ensureAgent(accumulators, workflow.systemReview.reviewerId).roles.add('system_reviewer');
  }

  return [...accumulators.entries()]
    .map(([id, accumulated]): ControlCenterAgentStatus => {
      const broker = accumulated.broker;
      return {
        id,
        label: broker?.label ?? id,
        state: broker?.state ?? 'unknown',
        roles: ROLE_ORDER.filter((role) => accumulated.roles.has(role)),
        boundTaskIds: [...accumulated.boundTaskIds].sort((a, b) => a.localeCompare(b)),
        reviewedTaskIds: [...accumulated.reviewedTaskIds].sort((a, b) => a.localeCompare(b)),
        chatBound: Boolean(broker?.conversationId),
        lastSeenAt: broker?.lastSeenAt ?? null,
        broker: {
          pending: broker?.pending ?? null,
          awaitingAck: broker?.awaitingAck ?? null,
          delivered: broker?.delivered ?? null
        }
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function projectEdges(tasks: readonly ControlCenterTaskStatus[]): ControlCenterEdge[] {
  const edges: ControlCenterEdge[] = [];
  for (const task of tasks) {
    for (const dependency of task.dependencies) edges.push({ kind: 'dependency', fromTaskId: dependency, toTaskId: task.id });
    if (task.assignedWorkerId) edges.push({ kind: 'assignment', agentId: task.assignedWorkerId, taskId: task.id });
    if (task.reviewerId) edges.push({ kind: 'review', agentId: task.reviewerId, taskId: task.id });
  }
  const order: Record<ControlCenterEdge['kind'], number> = { dependency: 0, assignment: 1, review: 2 };
  return edges.sort((left, right) => {
    const byKind = order[left.kind] - order[right.kind];
    if (byKind !== 0) return byKind;
    const leftKey = left.kind === 'dependency' ? `${left.fromTaskId}\u0000${left.toTaskId}` : `${left.agentId}\u0000${left.taskId}`;
    const rightKey = right.kind === 'dependency' ? `${right.fromTaskId}\u0000${right.toTaskId}` : `${right.agentId}\u0000${right.taskId}`;
    return leftKey.localeCompare(rightKey);
  });
}

function runHealth(state: OrchestrationState, workflow: RunWorkflowState | null, blockers: readonly ControlCenterBlocker[]): ControlCenterRunHealth {
  if (state.runStatus === 'RUN_VERIFIED' && workflow?.status === 'verified') return 'verified';
  if (Object.values(state.tasks).some((task) => task.state === 'FAILED')) return 'failed';
  if (blockers.length > 0 || workflow?.status === 'blocked') return 'blocked';
  return 'running';
}

function globalBlockers(workflow: RunWorkflowState | null, taskBlockers: ControlCenterBlocker[]): ControlCenterBlocker[] {
  const blockers = [...taskBlockers];
  if (workflow?.systemReview?.verdict === 'BLOCKED') {
    const detail = workflow.systemReview.findings.join(' | ').trim();
    blockers.push({
      id: 'system-review:blocked',
      kind: 'system_review',
      taskId: null,
      summary: detail ? `System review blocked: ${detail}` : 'System review blocked.'
    });
  }
  if (workflow?.status === 'blocked' && blockers.length === 0) {
    blockers.push({ id: 'workflow:blocked', kind: 'workflow', taskId: null, summary: 'Workflow is blocked.' });
  }
  return blockers.sort((a, b) => a.id.localeCompare(b.id));
}

function isActiveAgent(agent: ControlCenterAgentStatus): boolean {
  return agent.state === 'invited' || agent.state === 'active' || agent.state === 'detached' || agent.state === 'waking';
}

export function projectControlCenterStatus(
  state: OrchestrationState,
  workflowState: RunWorkflowState | null,
  swarm: SwarmState,
  observedAt: number,
  browserTelemetry: BrowserAgentTabTelemetry | null = null
): ControlCenterStatus {
  if (!state.runId) {
    return {
      version: CONTROL_CENTER_VERSION,
      observedAt,
      run: null,
      tasks: [],
      agents: [],
      edges: [],
      blockers: [],
      needsAttention: [],
      browser: browserStatus(browserTelemetry, observedAt)
    };
  }

  const workflow = matchingWorkflow(state, workflowState);
  const taskRows = Object.values(state.tasks)
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((task) => taskProjection(task, state, workflow));
  const tasks = taskRows.map((row) => row.task);
  const blockers = globalBlockers(workflow, taskRows.flatMap((row) => row.blockers));
  const agents = projectAgents(state, workflow, swarm, tasks);
  const verified = tasks.filter((task) => task.state === 'VERIFIED').length;

  const status: ControlCenterStatus = {
    version: CONTROL_CENTER_VERSION,
    observedAt,
    run: {
      id: state.runId,
      planId: state.managerPlanId,
      managerAgentId: state.managerAgentId,
      orchestrationStatus: state.runStatus,
      workflowStatus: workflow?.status ?? 'none',
      health: runHealth(state, workflow, blockers),
      progress: { verified, total: tasks.length },
      activeAgents: agents.filter(isActiveAgent).length
    },
    tasks,
    agents,
    edges: projectEdges(tasks),
    blockers,
    // No current durable orchestration/workflow record proves an L4 user-authority decision.
    // A blocked task therefore stays a blocker instead of being promoted by wording or guesswork.
    needsAttention: [],
    browser: browserStatus(browserTelemetry, observedAt)
  };
  // Error/findings text is less trusted than structural worktree fields. Scrub every known
  // native task/integration worktree spelling at the final projection boundary so a Git/runtime
  // error cannot bypass the explicit `{ id, branch, virtualPath }` worktree contract.
  return redactProjectionValue(status, knownNativePaths(state, workflow));
}

export async function controlCenterStatus(): Promise<ControlCenterStatus> {
  const recovered = await recoverOrchestrationState();
  const workflow = recovered.state.runId ? await workflowStateForRun(recovered.state.runId) : null;
  const runtime = recovered.state.runId ? await managerRuntimeForRun(recovered.state.runId) : null;
  // Fail closed on the identity join. A different Prime may currently own an active swarm with
  // the same reusable worker slot names; without the durable owner row those rows are not proof
  // of liveness for this orchestration run.
  const broker = runtime
    ? swarmStateForCaller({ conversationId: runtime.ownerPrimeConversationId })
    : { enabled: false, running: false, agents: [] };
  const observedAt = Date.now();
  const browserTelemetry = browserPresent() ? browserAgentTabTelemetry() : null;
  return projectControlCenterStatus(recovered.state, workflow, broker, observedAt, browserTelemetry);
}
