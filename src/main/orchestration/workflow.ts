import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  MAX_MESSAGE_CHARS,
  PRIME_ID,
  agentConversation,
  persistCriticalSwarmNow,
  requestWorkerBootstraps,
  requestWorkerRevivals,
  stageMessages,
  stageSpawn,
  statusForCaller,
  type Caller
} from '../agents.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { childEnv } from '../exec.js';
import type { Root } from '../../shared/types.js';
import {
  assignmentEvidenceForPrime,
  bindTaskWorktree,
  brokerFreeSlotsForPrime,
  brokerWorkersForPrime,
  messageEvidenceForPrime
} from './broker-assignment.js';
import { recoverOrchestrationState } from './recovery.js';
import { runSchedulerCycleForRuntime } from './scheduler.js';
import {
  appendOrchestrationEvent,
  appendOrchestrationEvents,
  type NewOrchestrationEvent
} from './store.js';
import { assignmentMarker } from './task-contract.js';
import type { TaskCompletionPackage, TaskRecord, TaskWorktreeRecord } from './types.js';

const execFileAsync = promisify(execFile);
const WORKFLOW_STATE = 'as3-workflow';
const WORKFLOW_VERSION = 1 as const;
const MAX_REVIEW_ROUNDS = 3;
const MAX_LIST = 100;
const MAX_ITEM = 1000;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const GATE_TIMEOUT_MS = 5 * 60_000;

export interface WorkflowRuntime {
  runId: string;
  managerAgentId: string;
  ownerPrimeConversationId: string;
}

export type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'BLOCKED';

export interface CompletionInput {
  taskId: string;
  revision: string;
  changedFiles: string[];
  verification: Array<{ command: string; outcome: 'passed' | 'failed'; revision: string }>;
  risks: string[];
  notes: string[];
}

export interface ReviewInput {
  taskId: string;
  verdict: ReviewVerdict;
  findings: string[];
}

export interface VerificationRecord {
  gate: string;
  command: string;
  passed: boolean;
  revision: string;
  outputDigest: string;
  startedAt: number;
  finishedAt: number;
}

export interface IntegrationWorktreeMeta {
  realPath: string;
  virtualPath: string;
  branch: string;
  baseRevision: string;
  headRevision: string;
}

export interface IntegrationOperationRecord {
  operationId: string;
  sourceRevision: string;
  startingRevision: string;
  integrationRevision: string | null;
  status: 'pending' | 'complete' | 'ambiguous';
  error: string | null;
}

export interface VerificationOperationRecord {
  operationId: string;
  revision: string;
  status: 'pending' | 'complete' | 'failed';
  error: string | null;
}

export interface ReviewRecord {
  operationId: string;
  reviewerId: string | null;
  round: number;
  verdict: ReviewVerdict | null;
  findings: string[];
  outcomeDelivered?: boolean;
}

export interface SystemReviewRecord {
  operationId: string;
  reviewerId: string | null;
  verdict: 'APPROVED' | 'BLOCKED' | null;
  findings: string[];
}

export interface RunWorkflowState {
  runId: string;
  status: 'running' | 'needs_verification' | 'awaiting_system_review' | 'verified' | 'blocked';
  completions: Record<string, TaskCompletionPackage>;
  reviews: Record<string, ReviewRecord>;
  reviewHistory: Record<string, ReviewRecord[]>;
  integrationWorktree: IntegrationWorktreeMeta | null;
  integrations: Record<string, IntegrationOperationRecord>;
  verifications: Record<string, VerificationRecord[]>;
  verificationOperations: Record<string, VerificationOperationRecord>;
  systemReview: SystemReviewRecord | null;
}

interface WorkflowStore {
  version: typeof WORKFLOW_VERSION;
  runs: Record<string, RunWorkflowState>;
}

export interface IntegrationResult {
  integrationRevision: string;
  integrationWorktree: IntegrationWorktreeMeta;
}

export interface VerificationResult {
  passed: boolean;
  records: VerificationRecord[];
  blockedReason?: string;
}

export interface WorkflowDependencies {
  assignReviewer(
    runtime: WorkflowRuntime,
    task: TaskRecord,
    completion: TaskCompletionPackage,
    operationId: string
  ): Promise<string | null>;
  sendWorkerMessage(runtime: WorkflowRuntime, workerId: string, text: string): Promise<boolean>;
  messageEvidence(runtime: WorkflowRuntime, marker: string): { workerId: string } | null;
  notifyManager(runtime: WorkflowRuntime, text: string): Promise<void>;
  integrateTask(
    runtime: WorkflowRuntime,
    task: TaskRecord,
    completion: TaskCompletionPackage,
    taskWorktree: TaskWorktreeRecord,
    existingIntegration: IntegrationWorktreeMeta | null,
    operation: IntegrationOperationRecord
  ): Promise<IntegrationResult>;
  verifyTask(
    runtime: WorkflowRuntime,
    task: TaskRecord,
    integration: IntegrationResult,
    allowCommands: boolean
  ): Promise<VerificationResult>;
  schedule(runtime: WorkflowRuntime, roots: readonly Root[]): Promise<void>;
  assignSystemReviewer(
    runtime: WorkflowRuntime,
    summary: string,
    operationId: string,
    excludedAgentIds: readonly string[],
    integrationWorktree: IntegrationWorktreeMeta | null
  ): Promise<string | null>;
}

let workflowTail: Promise<void> = Promise.resolve();

function enqueueWorkflow<T>(work: () => Promise<T>): Promise<T> {
  const queued = workflowTail.then(work);
  workflowTail = queued.then(() => undefined, () => undefined);
  return queued;
}

function emptyRun(runId: string): RunWorkflowState {
  return {
    runId,
    status: 'running',
    completions: {},
    reviews: {},
    reviewHistory: {},
    integrationWorktree: null,
    integrations: {},
    verifications: {},
    verificationOperations: {},
    systemReview: null
  };
}

function validRun(value: unknown, runId: string): RunWorkflowState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyRun(runId);
  const run = value as Partial<RunWorkflowState>;
  if (run.runId !== runId) return emptyRun(runId);
  return {
    ...emptyRun(runId),
    ...run,
    completions: run.completions && typeof run.completions === 'object' ? run.completions : {},
    reviews: run.reviews && typeof run.reviews === 'object' ? run.reviews : {},
    reviewHistory: run.reviewHistory && typeof run.reviewHistory === 'object' ? run.reviewHistory : {},
    integrations: run.integrations && typeof run.integrations === 'object' ? run.integrations : {},
    verifications: run.verifications && typeof run.verifications === 'object' ? run.verifications : {},
    verificationOperations: run.verificationOperations && typeof run.verificationOperations === 'object' ? run.verificationOperations : {}
  } as RunWorkflowState;
}

async function readStore(): Promise<WorkflowStore> {
  const value = await readDurable<unknown>(WORKFLOW_STATE);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { version: WORKFLOW_VERSION, runs: {} };
  const candidate = value as { version?: unknown; runs?: unknown };
  if (candidate.version !== WORKFLOW_VERSION || !candidate.runs || typeof candidate.runs !== 'object' || Array.isArray(candidate.runs)) {
    return { version: WORKFLOW_VERSION, runs: {} };
  }
  const runs: Record<string, RunWorkflowState> = {};
  for (const [runId, run] of Object.entries(candidate.runs as Record<string, unknown>)) runs[runId] = validRun(run, runId);
  return { version: WORKFLOW_VERSION, runs };
}

async function updateRun(runId: string, updater: (run: RunWorkflowState) => RunWorkflowState): Promise<RunWorkflowState> {
  return enqueueWorkflow(async () => {
    const store = await readStore();
    const next = updater(validRun(store.runs[runId], runId));
    await writeDurableNow(WORKFLOW_STATE, { version: WORKFLOW_VERSION, runs: { ...store.runs, [runId]: next } });
    return next;
  });
}

export async function workflowStateForRun(runId: string): Promise<RunWorkflowState | null> {
  const store = await readStore();
  return store.runs[runId] ? validRun(store.runs[runId], runId) : null;
}

export async function resetWorkflowStateForTests(): Promise<void> {
  workflowTail = Promise.resolve();
  await writeDurableNow(WORKFLOW_STATE, null);
}

function boundedText(value: unknown, field: string, max = MAX_ITEM): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} must not be empty`);
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

function boundedList(values: unknown, field: string, maxItem = MAX_ITEM): string[] {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  if (values.length > MAX_LIST) throw new Error(`${field} has too many entries`);
  return values.map((value, index) => boundedText(value, `${field}[${index}]`, maxItem));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function regexEscape(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function scopeRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char !== '*') {
      source += regexEscape(char as string);
      continue;
    }
    if (normalized[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else {
      source += '[^/]*';
    }
  }
  return new RegExp(`^${source}$`);
}

function insideAllowedScope(file: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return false;
  const normalized = normalizePath(file);
  return scopes.some((scope) => scopeRegex(scope).test(normalized));
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env: childEnv(),
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT
  });
  return stdout.trim();
}

async function gitSucceeds(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function normalizeCompletionInput(input: CompletionInput): CompletionInput {
  const taskId = boundedText(input.taskId, 'task_id', 160);
  const revision = boundedText(input.revision, 'revision', 64).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('revision must be a full Git commit id');
  const changedFiles = boundedList(input.changedFiles, 'changed_files', 1000).map(normalizePath);
  const risks = boundedList(input.risks, 'risks');
  const notes = boundedList(input.notes, 'notes');
  if (!Array.isArray(input.verification) || input.verification.length > MAX_LIST) {
    throw new Error('verification must be a bounded array');
  }
  const verification = input.verification.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`verification[${index}] must be an object`);
    const command = boundedText(entry.command, `verification[${index}].command`, 1000);
    if (entry.outcome !== 'passed' && entry.outcome !== 'failed') throw new Error(`verification[${index}].outcome is invalid`);
    const evidenceRevision = boundedText(entry.revision, `verification[${index}].revision`, 64).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(evidenceRevision)) throw new Error(`verification[${index}].revision must be a full Git commit id`);
    return { command, outcome: entry.outcome, revision: evidenceRevision };
  });
  return { taskId, revision, changedFiles, verification, risks, notes };
}

async function inspectCompletion(
  task: TaskRecord,
  worktree: TaskWorktreeRecord,
  input: CompletionInput
): Promise<TaskCompletionPackage> {
  const normalized = normalizeCompletionInput(input);
  const status = await git(worktree.realPath, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (status) throw new Error('COMPLETION_WORKTREE_DIRTY: commit or remove uncommitted work before completion');
  const head = (await git(worktree.realPath, ['rev-parse', 'HEAD'])).toLowerCase();
  if (head !== normalized.revision) {
    throw new Error(`COMPLETION_REVISION_MISMATCH: Git HEAD ${head} does not match claimed revision ${normalized.revision}`);
  }
  if (!(await gitSucceeds(worktree.realPath, ['merge-base', '--is-ancestor', worktree.baseRevision, normalized.revision]))) {
    throw new Error('COMPLETION_REVISION_INVALID: claimed revision is not descended from the assigned worktree base');
  }
  const changedRaw = await git(worktree.realPath, ['diff', '--name-only', `${worktree.baseRevision}..${normalized.revision}`]);
  const actualChanged = changedRaw ? changedRaw.split(/\r?\n/).map(normalizePath).filter(Boolean).sort() : [];
  const claimed = [...new Set(normalized.changedFiles)].sort();
  if (JSON.stringify(actualChanged) !== JSON.stringify(claimed)) {
    throw new Error(`COMPLETION_CHANGED_FILES_MISMATCH: Git reports ${actualChanged.join(', ') || '(none)'}`);
  }
  const outside = actualChanged.filter((file) => !insideAllowedScope(file, task.allowedScope));
  if (outside.length > 0) throw new Error(`COMPLETION_SCOPE_VIOLATION: ${outside.join(', ')}`);
  return {
    status: 'ready_for_review',
    revision: normalized.revision,
    changedFiles: actualChanged,
    verification: normalized.verification,
    risks: normalized.risks,
    notes: normalized.notes
  };
}

function reviewContract(task: TaskRecord, completion: TaskCompletionPackage, worktree: TaskWorktreeRecord, operationId: string): string {
  const criteria = task.acceptanceCriteria.slice(0, 12).map((item) => `- ${item}`).join('\n');
  const files = completion.changedFiles.slice(0, 30).map((item) => `- ${item}`).join('\n') || '- (none)';
  const text = [
    assignmentMarker(operationId),
    `Role: ${task.riskClass === 'high' ? 'specialist reviewer' : 'reviewer'}`,
    `Task: ${task.taskId} — ${task.title}`,
    `Revision: ${completion.revision ?? '(none)'}`,
    `Review workspace: ${worktree.virtualPath}`,
    '',
    'Goal:', task.goal,
    '',
    'Acceptance criteria:', criteria,
    '',
    'Changed files:', files,
    '',
    'Review rules:',
    '- Inspect the implementation and evidence independently; worker self-report is not approval.',
    '- Do not edit implementation files. This is review-only work.',
    '- Return exactly one verdict through agents action=review_task: APPROVED, CHANGES_REQUESTED, or BLOCKED.',
    '- APPROVED means the task is safe to send to integration, not that the whole run is complete.'
  ].join('\n');
  if (text.length > MAX_MESSAGE_CHARS) throw new Error('REVIEW_CONTRACT_TOO_LARGE');
  return text;
}

async function stageReviewerMessage(
  runtime: WorkflowRuntime,
  workerId: string | null,
  label: string,
  contract: string,
  taskWorktree: TaskWorktreeRecord | null
): Promise<string | null> {
  if (brokerFreeSlotsForPrime(runtime.ownerPrimeConversationId) <= 0) return null;
  const staged = workerId
    ? stageMessages({ conversationId: runtime.ownerPrimeConversationId }, [{ to: workerId, text: contract }])
    : stageSpawn({ caller: { conversationId: runtime.ownerPrimeConversationId }, workers: [{ label, task: contract }] });
  const reviewerId = workerId ?? ('created' in staged ? staged.created[0]?.id ?? null : null);
  if (!reviewerId) {
    staged.rollback();
    throw new Error('REVIEWER_ASSIGNMENT_SHAPE: no reviewer worker was produced');
  }
  try {
    if (!(await persistCriticalSwarmNow())) {
      staged.rollback();
      return null;
    }
    staged.commit();
    const worker = brokerWorkersForPrime(runtime.ownerPrimeConversationId).find((entry) => entry.id === reviewerId);
    if (taskWorktree) bindTaskWorktree(reviewerId, worker?.conversationId ?? null, taskWorktree);
    if ('created' in staged) requestWorkerBootstraps([reviewerId]);
    else if (staged.waking.length > 0) requestWorkerRevivals(staged.waking);
    return reviewerId;
  } catch (error) {
    staged.rollback();
    throw error;
  }
}

function eligibleReviewer(
  runtime: WorkflowRuntime,
  excluded: ReadonlySet<string>
): string | null {
  const workers = brokerWorkersForPrime(runtime.ownerPrimeConversationId)
    .filter(
      (worker) =>
        worker.id !== runtime.managerAgentId &&
        !excluded.has(worker.id) &&
        worker.state === 'sleeping' &&
        worker.revivable &&
        Boolean(worker.conversationId)
    )
    .sort((a, b) => (b.sleptAt ?? b.lastSeenAt ?? 0) - (a.sleptAt ?? a.lastSeenAt ?? 0) || a.id.localeCompare(b.id));
  return workers[0]?.id ?? null;
}

async function defaultAssignReviewer(
  runtime: WorkflowRuntime,
  task: TaskRecord,
  completion: TaskCompletionPackage,
  operationId: string
): Promise<string | null> {
  const orchestration = await recoverOrchestrationState();
  const worktree = task.worktreeId ? orchestration.state.worktrees[task.worktreeId] : null;
  if (!worktree) throw new Error(`REVIEW_WORKTREE_MISSING: ${String(task.worktreeId)}`);
  const evidence = assignmentEvidenceForPrime(runtime.ownerPrimeConversationId, operationId);
  if (evidence) {
    const worker = brokerWorkersForPrime(runtime.ownerPrimeConversationId).find((entry) => entry.id === evidence.workerId);
    bindTaskWorktree(evidence.workerId, worker?.conversationId ?? null, worktree);
    requestWorkerBootstraps([evidence.workerId]);
    requestWorkerRevivals([evidence.workerId]);
    return evidence.workerId;
  }
  const excluded = new Set<string>([task.assignedWorkerId ?? '']);
  for (const review of Object.values((await workflowStateForRun(runtime.runId))?.reviews ?? {})) {
    if (review.reviewerId && review.verdict === null) excluded.add(review.reviewerId);
  }
  const reusable = eligibleReviewer(runtime, excluded);
  return stageReviewerMessage(
    runtime,
    reusable,
    task.riskClass === 'high' ? `Specialist reviewer ${task.taskId}` : `Reviewer ${task.taskId}`,
    reviewContract(task, completion, worktree, operationId),
    worktree
  );
}

async function defaultSendWorkerMessage(runtime: WorkflowRuntime, workerId: string, text: string): Promise<boolean> {
  try {
    const staged = stageMessages({ conversationId: runtime.ownerPrimeConversationId }, [{ to: workerId, text }]);
    if (!(await persistCriticalSwarmNow())) {
      staged.rollback();
      return false;
    }
    staged.commit();
    if (staged.waking.length > 0) requestWorkerRevivals(staged.waking);
    return true;
  } catch {
    return false;
  }
}

async function defaultNotifyManager(runtime: WorkflowRuntime, text: string): Promise<void> {
  await defaultSendWorkerMessage(runtime, runtime.managerAgentId, text);
}

function integrationPath(taskWorktree: TaskWorktreeRecord, runId: string): { realPath: string; branch: string; virtualPath: string } {
  const runShort = runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 8) || 'run';
  const parent = path.dirname(taskWorktree.realPath);
  const realPath = path.join(parent, `integration-${runShort}`);
  const virtualParent = taskWorktree.virtualPath.replace(/\/[^/]+$/, '');
  return { realPath, virtualPath: `${virtualParent}/integration-${runShort}`, branch: `as3/${runShort}/integration` };
}

async function ensureIntegrationWorktree(
  runtime: WorkflowRuntime,
  taskWorktree: TaskWorktreeRecord,
  existing: IntegrationWorktreeMeta | null
): Promise<IntegrationWorktreeMeta> {
  if (existing) {
    const top = path.resolve(await git(existing.realPath, ['rev-parse', '--show-toplevel']));
    const branch = await git(existing.realPath, ['branch', '--show-current']);
    if (top !== path.resolve(existing.realPath) || branch !== existing.branch) throw new Error('INTEGRATION_WORKTREE_AMBIGUOUS');
    const baseIsAncestor = await gitSucceeds(existing.realPath, ['merge-base', '--is-ancestor', existing.baseRevision, 'HEAD']);
    if (!baseIsAncestor) throw new Error('INTEGRATION_BASE_MISMATCH');
    return existing;
  }
  const target = integrationPath(taskWorktree, runtime.runId);
  let exists = true;
  try { await fs.access(target.realPath); } catch { exists = false; }
  if (!exists) {
    await fs.mkdir(path.dirname(target.realPath), { recursive: true });
    try {
      await git(taskWorktree.realPath, ['worktree', 'add', '-b', target.branch, target.realPath, taskWorktree.baseRevision]);
    } catch {
      await git(taskWorktree.realPath, ['worktree', 'add', target.realPath, target.branch]);
    }
  }
  const branch = await git(target.realPath, ['branch', '--show-current']);
  const head = (await git(target.realPath, ['rev-parse', 'HEAD'])).toLowerCase();
  if (branch !== target.branch) throw new Error('INTEGRATION_BRANCH_MISMATCH');
  if (!(await gitSucceeds(target.realPath, ['merge-base', '--is-ancestor', taskWorktree.baseRevision, head]))) {
    throw new Error('INTEGRATION_BASE_MISMATCH');
  }
  return { ...target, baseRevision: taskWorktree.baseRevision.toLowerCase(), headRevision: head };
}

async function exactCherryPickResult(cwd: string, sourceRevision: string, startingRevision: string, currentRevision: string): Promise<boolean> {
  let parent: string;
  let message: string;
  try {
    parent = (await git(cwd, ['rev-parse', `${currentRevision}^`])).toLowerCase();
    message = await git(cwd, ['show', '-s', '--format=%B', currentRevision]);
  } catch {
    return false;
  }
  return parent === startingRevision && message.includes(`(cherry picked from commit ${sourceRevision})`);
}

export async function integrateTaskWithGit(
  runtime: WorkflowRuntime,
  _task: TaskRecord,
  completion: TaskCompletionPackage,
  taskWorktree: TaskWorktreeRecord,
  existingIntegration: IntegrationWorktreeMeta | null,
  operation: IntegrationOperationRecord
): Promise<IntegrationResult> {
  const sourceRevision = completion.revision?.toLowerCase() ?? null;
  if (!sourceRevision) throw new Error('INTEGRATION_SOURCE_REVISION_MISSING');
  if (sourceRevision !== operation.sourceRevision.toLowerCase()) throw new Error('INTEGRATION_SOURCE_CHANGED');
  const startingRevision = operation.startingRevision.toLowerCase();
  const integrationWorktree = await ensureIntegrationWorktree(runtime, taskWorktree, existingIntegration);
  const status = await git(integrationWorktree.realPath, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (status) throw new Error('INTEGRATION_WORKTREE_DIRTY');
  const currentRevision = (await git(integrationWorktree.realPath, ['rev-parse', 'HEAD'])).toLowerCase();

  if (currentRevision !== startingRevision) {
    if (!(await exactCherryPickResult(integrationWorktree.realPath, sourceRevision, startingRevision, currentRevision))) {
      throw new Error('INTEGRATION_AMBIGUOUS: integration HEAD changed outside the pending operation');
    }
    return {
      integrationRevision: currentRevision,
      integrationWorktree: { ...integrationWorktree, headRevision: currentRevision }
    };
  }

  if (sourceRevision !== startingRevision) {
    try {
      await git(integrationWorktree.realPath, ['cherry-pick', '-x', sourceRevision]);
    } catch (error) {
      try { await git(integrationWorktree.realPath, ['cherry-pick', '--abort']); } catch { /* verify exact recovery below */ }
      const recoveredHead = (await git(integrationWorktree.realPath, ['rev-parse', 'HEAD'])).toLowerCase();
      const recoveredStatus = await git(integrationWorktree.realPath, ['status', '--porcelain=v1', '--untracked-files=normal']);
      if (recoveredHead !== startingRevision || recoveredStatus) {
        throw new Error('INTEGRATION_AMBIGUOUS: failed cherry-pick could not be restored to its starting revision');
      }
      throw new Error(`INTEGRATION_CONFLICT: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const integrationRevision = (await git(integrationWorktree.realPath, ['rev-parse', 'HEAD'])).toLowerCase();
  if (sourceRevision !== startingRevision && !(await exactCherryPickResult(integrationWorktree.realPath, sourceRevision, startingRevision, integrationRevision))) {
    throw new Error('INTEGRATION_AMBIGUOUS: completed cherry-pick could not be proven');
  }
  return { integrationRevision, integrationWorktree: { ...integrationWorktree, headRevision: integrationRevision } };
}

const defaultIntegrateTask = integrateTaskWithGit;

function digestOutput(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function gitVerification(cwd: string, base: string, revision: string): Promise<VerificationRecord> {
  const startedAt = Date.now();
  const command = `git diff --check ${base}..${revision}`;
  try {
    const output = await git(cwd, ['diff', '--check', `${base}..${revision}`]);
    return { gate: 'git diff --check', command, passed: true, revision, outputDigest: digestOutput(output), startedAt, finishedAt: Date.now() };
  } catch (error) {
    return { gate: 'git diff --check', command, passed: false, revision, outputDigest: digestOutput(error instanceof Error ? error.message : String(error)), startedAt, finishedAt: Date.now() };
  }
}

async function runGate(cwd: string, gate: string, file: string, args: string[], revision: string): Promise<VerificationRecord> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      env: childEnv(),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: GATE_TIMEOUT_MS
    });
    return { gate, command: gate, passed: true, revision, outputDigest: digestOutput(`${stdout}\n${stderr}`), startedAt, finishedAt: Date.now() };
  } catch (error) {
    const held = error as Error & { stdout?: string; stderr?: string };
    return { gate, command: gate, passed: false, revision, outputDigest: digestOutput(`${held.message}\n${held.stdout ?? ''}\n${held.stderr ?? ''}`), startedAt, finishedAt: Date.now() };
  }
}

async function maybeShareNodeModules(integrationPathValue: string): Promise<void> {
  const target = path.join(integrationPathValue, 'node_modules');
  try { await fs.access(target); return; } catch { /* continue */ }
  try {
    const common = await git(integrationPathValue, ['rev-parse', '--git-common-dir']);
    const commonPath = path.resolve(integrationPathValue, common);
    const sourceRepo = path.basename(commonPath) === '.git' ? path.dirname(commonPath) : path.dirname(commonPath);
    const sourceModules = path.join(sourceRepo, 'node_modules');
    await fs.access(sourceModules);
    await fs.symlink(sourceModules, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Verification will report the actual command failure; never install or fetch dependencies implicitly.
  }
}

async function defaultVerifyTask(
  _runtime: WorkflowRuntime,
  _task: TaskRecord,
  integration: IntegrationResult,
  allowCommands: boolean
): Promise<VerificationResult> {
  const revision = integration.integrationRevision;
  const records: VerificationRecord[] = [
    await gitVerification(integration.integrationWorktree.realPath, integration.integrationWorktree.baseRevision, revision)
  ];
  if (!records[0]?.passed) return { passed: false, records };
  if (!allowCommands) return { passed: false, records, blockedReason: 'Command permission is required for project verification gates.' };

  const packagePath = path.join(integration.integrationWorktree.realPath, 'package.json');
  let pkg: any = null;
  try { pkg = JSON.parse(await fs.readFile(packagePath, 'utf8')); } catch { /* non-Node project: Git gate is the deterministic baseline */ }
  if (!pkg) return { passed: true, records };
  await maybeShareNodeModules(integration.integrationWorktree.realPath);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Record<string, unknown> : {};
  const gates: Array<[string, string[]]> = [];
  if (typeof scripts['verify:ci'] === 'string') {
    gates.push(['npm run verify:ci', ['run', 'verify:ci']]);
  } else if (typeof scripts.verify === 'string') {
    gates.push(['npm run verify', ['run', 'verify']]);
  } else {
    for (const name of ['typecheck', 'lint', 'build']) {
      if (typeof scripts[name] === 'string') gates.push([`npm run ${name}`, ['run', name]]);
    }
    const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, unknown>;
    if (typeof scripts.test === 'string' && dependencies.vitest !== undefined) gates.push(['npm test -- --run', ['test', '--', '--run']]);
  }
  for (const [gate, args] of gates) {
    const record = await runGate(integration.integrationWorktree.realPath, gate, process.platform === 'win32' ? 'npm.cmd' : 'npm', args, revision);
    records.push(record);
    if (!record.passed) return { passed: false, records };
  }
  return { passed: true, records };
}

async function defaultSchedule(runtime: WorkflowRuntime, roots: readonly Root[]): Promise<void> {
  await runSchedulerCycleForRuntime(runtime, roots);
}

function systemReviewContract(summary: string, operationId: string): string {
  const text = [
    assignmentMarker(operationId),
    'Role: System Reviewer',
    'Review the integrated Agent System 3.0 run as a whole.',
    '',
    summary,
    '',
    'Return agents action=review_run with verdict APPROVED or BLOCKED.',
    'Do not edit files, push, deploy, or perform destructive actions.'
  ].join('\n');
  if (text.length > MAX_MESSAGE_CHARS) throw new Error('SYSTEM_REVIEW_CONTRACT_TOO_LARGE');
  return text;
}

async function defaultAssignSystemReviewer(
  runtime: WorkflowRuntime,
  summary: string,
  operationId: string,
  excludedAgentIds: readonly string[],
  integrationWorktree: IntegrationWorktreeMeta | null
): Promise<string | null> {
  const evidence = assignmentEvidenceForPrime(runtime.ownerPrimeConversationId, operationId);
  if (evidence) return evidence.workerId;
  const reusable = eligibleReviewer(runtime, new Set(excludedAgentIds));
  const pseudoWorktree: TaskWorktreeRecord | null = integrationWorktree
    ? { worktreeId: `integration-${runtime.runId}`, taskId: '__system__', branch: integrationWorktree.branch, baseRevision: integrationWorktree.baseRevision, realPath: integrationWorktree.realPath, virtualPath: integrationWorktree.virtualPath }
    : null;
  return stageReviewerMessage(runtime, reusable, 'System Reviewer', systemReviewContract(summary, operationId), pseudoWorktree);
}

const DEFAULT_DEPS: WorkflowDependencies = {
  assignReviewer: defaultAssignReviewer,
  sendWorkerMessage: defaultSendWorkerMessage,
  messageEvidence: (runtime, marker) => messageEvidenceForPrime(runtime.ownerPrimeConversationId, marker),
  notifyManager: defaultNotifyManager,
  integrateTask: defaultIntegrateTask,
  verifyTask: defaultVerifyTask,
  schedule: defaultSchedule,
  assignSystemReviewer: defaultAssignSystemReviewer
};

async function appendTaskEvent(runtime: WorkflowRuntime, taskId: string, type: Parameters<typeof appendOrchestrationEvent>[0]['type'], payload: Record<string, unknown> = {}): Promise<void> {
  await appendOrchestrationEvent({
    eventId: `workflow:${type}:${taskId}:${randomUUID()}`,
    runId: runtime.runId,
    time: Date.now(),
    type,
    actor: 'kernel',
    entityId: taskId,
    payload
  });
}

async function archiveSettledReview(
  runtime: WorkflowRuntime,
  taskId: string,
  review: ReviewRecord,
  status: RunWorkflowState['status']
): Promise<void> {
  await updateRun(runtime.runId, (current) => {
    const history = current.reviewHistory[taskId] ?? [];
    const archived = history.some((entry) => entry.operationId === review.operationId) ? history : [...history, review];
    return {
      ...current,
      status,
      reviewHistory: { ...current.reviewHistory, [taskId]: archived },
      reviews: Object.fromEntries(Object.entries(current.reviews).filter(([id]) => id !== taskId)),
      completions: Object.fromEntries(Object.entries(current.completions).filter(([id]) => id !== taskId))
    };
  });
}

function reviewOutcomeMarker(operationId: string): string {
  return `AS3-Review-Outcome: ${operationId}`;
}

async function markReviewOutcomeDelivered(runId: string, taskId: string, operationId: string): Promise<void> {
  await updateRun(runId, (current) => {
    const history = current.reviewHistory[taskId] ?? [];
    const index = history.findIndex((entry) => entry.operationId === operationId);
    if (index < 0 || history[index]?.outcomeDelivered === true) return current;
    const nextHistory = [...history];
    nextHistory[index] = { ...(nextHistory[index] as ReviewRecord), outcomeDelivered: true };
    return {
      ...current,
      reviewHistory: { ...current.reviewHistory, [taskId]: nextHistory }
    };
  });
}

async function ensureReviewOutcomeDeliveries(runtime: WorkflowRuntime, deps: WorkflowDependencies): Promise<void> {
  const orchestration = await recoverOrchestrationState();
  const run = await workflowStateForRun(runtime.runId);
  if (!run) return;

  for (const task of Object.values(orchestration.state.tasks)) {
    const history = run.reviewHistory[task.taskId] ?? [];
    const review = history.at(-1);
    if (!review || review.outcomeDelivered === true) continue;

    const marker = reviewOutcomeMarker(review.operationId);
    const evidence = deps.messageEvidence(runtime, marker);

    const terminalBlocked = task.state === 'BLOCKED' && (
      review.verdict === 'BLOCKED'
      || (review.verdict === 'CHANGES_REQUESTED' && review.round >= MAX_REVIEW_ROUNDS)
    );
    if (terminalBlocked) {
      if (evidence) {
        if (evidence.workerId !== runtime.managerAgentId) {
          throw new Error(`REVIEW_OUTCOME_EVIDENCE_MISMATCH: ${review.operationId} belongs to ${evidence.workerId}`);
        }
        await markReviewOutcomeDelivered(runtime.runId, task.taskId, review.operationId);
        continue;
      }

      const feedback = `[${task.taskId} blocked] ${review.findings.join(' | ') || 'Review round limit exhausted.'}\n${marker}`;
      await deps.notifyManager(runtime, feedback);
      const deliveredEvidence = deps.messageEvidence(runtime, marker);
      if (deliveredEvidence) {
        if (deliveredEvidence.workerId !== runtime.managerAgentId) {
          throw new Error(`REVIEW_OUTCOME_EVIDENCE_MISMATCH: ${review.operationId} belongs to ${deliveredEvidence.workerId}`);
        }
        await markReviewOutcomeDelivered(runtime.runId, task.taskId, review.operationId);
      }
      continue;
    }

    if (
      task.state !== 'ACTIVE'
      || !task.assignedWorkerId
      || review.verdict !== 'CHANGES_REQUESTED'
      || review.round >= MAX_REVIEW_ROUNDS
    ) continue;

    if (evidence) {
      if (evidence.workerId !== task.assignedWorkerId) {
        throw new Error(`REVIEW_OUTCOME_EVIDENCE_MISMATCH: ${review.operationId} belongs to ${evidence.workerId}`);
      }
      await markReviewOutcomeDelivered(runtime.runId, task.taskId, review.operationId);
      continue;
    }

    const feedback = `${marker}\n[${task.taskId} changes requested — review round ${review.round}/${MAX_REVIEW_ROUNDS}] ${review.findings.join(' | ')}`;
    const delivered = await deps.sendWorkerMessage(runtime, task.assignedWorkerId, feedback);
    if (delivered) {
      await markReviewOutcomeDelivered(runtime.runId, task.taskId, review.operationId);
    } else {
      await deps.notifyManager(runtime, `${feedback} Worker wake is waiting for execution capacity.`);
    }
  }
}

async function reconcileSettledReviewBookkeeping(runtime: WorkflowRuntime): Promise<void> {
  const orchestration = await recoverOrchestrationState();
  const existing = await workflowStateForRun(runtime.runId);
  if (!existing) return;

  const candidates = Object.values(orchestration.state.tasks).filter((task) => {
    const review = existing.reviews[task.taskId];
    if (!review?.verdict) return false;
    const terminalReview = review.verdict === 'BLOCKED' || (review.verdict === 'CHANGES_REQUESTED' && review.round >= MAX_REVIEW_ROUNDS);
    if (terminalReview) return task.state === 'BLOCKED';
    return review.verdict === 'CHANGES_REQUESTED' && task.state === 'ACTIVE';
  });
  if (candidates.length === 0) return;

  await updateRun(runtime.runId, (current) => {
    const reviews = { ...current.reviews };
    const completions = { ...current.completions };
    const reviewHistory = { ...current.reviewHistory };
    let status = current.status;
    let changed = false;

    for (const task of candidates) {
      const review = reviews[task.taskId];
      if (!review?.verdict) continue;
      const terminalReview = review.verdict === 'BLOCKED' || (review.verdict === 'CHANGES_REQUESTED' && review.round >= MAX_REVIEW_ROUNDS);
      const journalApplied = terminalReview
        ? task.state === 'BLOCKED'
        : review.verdict === 'CHANGES_REQUESTED' && task.state === 'ACTIVE';
      if (!journalApplied) continue;

      const history = reviewHistory[task.taskId] ?? [];
      if (!history.some((entry) => entry.operationId === review.operationId)) {
        reviewHistory[task.taskId] = [...history, review];
      }
      delete reviews[task.taskId];
      delete completions[task.taskId];
      if (terminalReview) status = 'blocked';
      changed = true;
    }

    return changed ? { ...current, status, reviews, completions, reviewHistory } : current;
  });
}

async function routePendingReviews(runtime: WorkflowRuntime, deps: WorkflowDependencies): Promise<void> {
  let orchestration = await recoverOrchestrationState();
  for (const task of Object.values(orchestration.state.tasks)) {
    if (task.state !== 'READY_FOR_REVIEW') continue;
    const run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
    const completion = run.completions[task.taskId];
    if (!completion) throw new Error(`REVIEW_COMPLETION_MISSING: ${task.taskId}`);
    let review = run.reviews[task.taskId];
    if (!review || review.verdict !== null) {
      const round = (run.reviewHistory[task.taskId]?.length ?? 0) + 1;
      review = { operationId: randomUUID(), reviewerId: null, round, verdict: null, findings: [] };
      await updateRun(runtime.runId, (current) => ({ ...current, reviews: { ...current.reviews, [task.taskId]: review as ReviewRecord } }));
    }
    if (review.reviewerId) {
      await appendTaskEvent(runtime, task.taskId, 'TASK_REVIEWING', { reviewerId: review.reviewerId, round: review.round });
      continue;
    }
    const reviewerId = await deps.assignReviewer(runtime, task, completion, review.operationId);
    if (!reviewerId) continue;
    await updateRun(runtime.runId, (current) => ({
      ...current,
      reviews: { ...current.reviews, [task.taskId]: { ...(current.reviews[task.taskId] as ReviewRecord), reviewerId } }
    }));
    await appendTaskEvent(runtime, task.taskId, 'TASK_REVIEWING', { reviewerId, round: review.round });
    orchestration = await recoverOrchestrationState();
  }
}

function recordsFreshForRevision(records: readonly VerificationRecord[], revision: string): boolean {
  return records.length > 0 && records.every((record) => record.passed && record.revision === revision);
}

async function integrateAndVerify(runtime: WorkflowRuntime, roots: readonly Root[], allowCommands: boolean, deps: WorkflowDependencies): Promise<void> {
  let orchestration = await recoverOrchestrationState();
  for (const task of Object.values(orchestration.state.tasks)) {
    if (task.state !== 'APPROVED' && task.state !== 'INTEGRATING') continue;
    const run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
    const completion = run.completions[task.taskId];
    if (!completion?.revision || !task.worktreeId) continue;
    const taskWorktree = orchestration.state.worktrees[task.worktreeId];
    if (!taskWorktree) throw new Error(`INTEGRATION_TASK_WORKTREE_MISSING: ${task.taskId}`);
    let integrationMeta = run.integrations[task.taskId];
    if (!integrationMeta) {
      const startingRevision = (run.integrationWorktree?.headRevision ?? taskWorktree.baseRevision).toLowerCase();
      integrationMeta = {
        operationId: randomUUID(),
        sourceRevision: completion.revision,
        startingRevision,
        integrationRevision: null,
        status: 'pending',
        error: null
      };
      await updateRun(runtime.runId, (current) => ({ ...current, integrations: { ...current.integrations, [task.taskId]: integrationMeta! } }));
    }
    if (integrationMeta.sourceRevision !== completion.revision) throw new Error(`INTEGRATION_SOURCE_CHANGED: ${task.taskId}`);
    if (!integrationMeta.startingRevision || !integrationMeta.status) {
      await updateRun(runtime.runId, (current) => ({
        ...current,
        status: 'blocked',
        integrations: {
          ...current.integrations,
          [task.taskId]: {
            ...(current.integrations[task.taskId] as IntegrationOperationRecord),
            status: 'ambiguous',
            error: 'INTEGRATION_AMBIGUOUS: legacy pending integration is missing recovery coordinates'
          }
        }
      }));
      await deps.notifyManager(runtime, `[${task.taskId} integration blocked] INTEGRATION_AMBIGUOUS: missing recovery coordinates`);
      return;
    }
    if (task.state === 'APPROVED') await appendTaskEvent(runtime, task.taskId, 'TASK_INTEGRATING', { operationId: integrationMeta.operationId, revision: completion.revision });

    let integration: IntegrationResult | null = null;
    if (integrationMeta.status === 'complete' && integrationMeta.integrationRevision && run.integrationWorktree) {
      integration = {
        integrationRevision: integrationMeta.integrationRevision,
        integrationWorktree: run.integrationWorktree
      };
    } else {
      try {
        integration = await deps.integrateTask(runtime, task, completion, taskWorktree, run.integrationWorktree, integrationMeta);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const ambiguous = /INTEGRATION_.*AMBIGUOUS|INTEGRATION_AMBIGUOUS/i.test(reason);
        await updateRun(runtime.runId, (current) => ({
          ...current,
          status: 'blocked',
          integrations: {
            ...current.integrations,
            [task.taskId]: {
              ...(current.integrations[task.taskId] as IntegrationOperationRecord),
              status: ambiguous ? 'ambiguous' : 'pending',
              error: reason
            }
          }
        }));
        await deps.notifyManager(runtime, `[${task.taskId} integration blocked] ${reason}`);
        return;
      }
      await updateRun(runtime.runId, (current) => ({
        ...current,
        integrationWorktree: integration!.integrationWorktree,
        integrations: {
          ...current.integrations,
          [task.taskId]: {
            ...(current.integrations[task.taskId] as IntegrationOperationRecord),
            integrationRevision: integration!.integrationRevision,
            status: 'complete',
            error: null
          }
        }
      }));
    }
    orchestration = await recoverOrchestrationState();
    if (orchestration.state.tasks[task.taskId]?.state === 'INTEGRATING') {
      await appendTaskEvent(runtime, task.taskId, 'TASK_INTEGRATED', { revision: integration.integrationRevision, operationId: integrationMeta.operationId });
    }
    orchestration = await recoverOrchestrationState();
  }

  orchestration = await recoverOrchestrationState();
  let run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
  const finalIntegration = run.integrationWorktree;
  const finalRevision = finalIntegration?.headRevision;
  if (!finalIntegration || !finalRevision) return;

  for (const task of Object.values(orchestration.state.tasks)) {
    if (task.state !== 'INTEGRATED' && task.state !== 'VERIFIED') continue;
    const integrationMeta = run.integrations[task.taskId];
    if (!integrationMeta || integrationMeta.status !== 'complete' || integrationMeta.error) continue;
    const currentRecords = run.verifications[task.taskId] ?? [];
    if (recordsFreshForRevision(currentRecords, finalRevision)) {
      if (task.state === 'INTEGRATED') {
        await appendTaskEvent(runtime, task.taskId, 'TASK_VERIFIED', { revision: finalRevision });
        await deps.schedule(runtime, roots);
        orchestration = await recoverOrchestrationState();
      }
      continue;
    }

    let verificationOperation = run.verificationOperations[task.taskId];
    if (!verificationOperation || verificationOperation.revision !== finalRevision) {
      verificationOperation = {
        operationId: randomUUID(),
        revision: finalRevision,
        status: 'pending',
        error: null
      };
    } else {
      verificationOperation = { ...verificationOperation, status: 'pending', error: null };
    }
    await updateRun(runtime.runId, (current) => ({
      ...current,
      verificationOperations: { ...current.verificationOperations, [task.taskId]: verificationOperation! }
    }));

    let verified: VerificationResult;
    try {
      verified = await deps.verifyTask(
        runtime,
        task,
        { integrationRevision: finalRevision, integrationWorktree: finalIntegration },
        allowCommands
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await updateRun(runtime.runId, (current) => ({
        ...current,
        status: 'needs_verification',
        verificationOperations: {
          ...current.verificationOperations,
          [task.taskId]: { ...(current.verificationOperations[task.taskId] as VerificationOperationRecord), status: 'failed', error: reason }
        }
      }));
      await deps.notifyManager(runtime, `[${task.taskId} verification failed] ${reason}`);
      run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
      continue;
    }

    const fresh = recordsFreshForRevision(verified.records, finalRevision);
    const acceptedVerification = verified.passed && fresh;
    const blockedReason = verified.blockedReason ?? (!fresh ? 'Verification evidence is stale or not bound to the final integration revision.' : undefined);
    await updateRun(runtime.runId, (current) => ({
      ...current,
      status: acceptedVerification && current.status === 'needs_verification' ? 'running' : (acceptedVerification ? current.status : 'needs_verification'),
      verifications: { ...current.verifications, [task.taskId]: verified.records },
      verificationOperations: {
        ...current.verificationOperations,
        [task.taskId]: {
          ...(current.verificationOperations[task.taskId] as VerificationOperationRecord),
          status: acceptedVerification ? 'complete' : 'failed',
          error: acceptedVerification ? null : (blockedReason ?? 'verification gate failed')
        }
      }
    }));
    if (acceptedVerification) {
      const latest = await recoverOrchestrationState();
      if (latest.state.tasks[task.taskId]?.state === 'INTEGRATED') {
        await appendTaskEvent(runtime, task.taskId, 'TASK_VERIFIED', { revision: finalRevision });
        await deps.schedule(runtime, roots);
      }
    } else if (blockedReason) {
      await deps.notifyManager(runtime, `[${task.taskId} needs verification] ${blockedReason}`);
    } else {
      await deps.notifyManager(runtime, `[${task.taskId} verification failed] Inspect the recorded verification evidence before retrying integration or replanning.`);
    }
    orchestration = await recoverOrchestrationState();
    run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
  }
}

function systemSummary(tasks: readonly TaskRecord[], run: RunWorkflowState): string {
  const lines = ['Integrated run summary:'];
  for (const task of tasks.slice(0, 40)) {
    const revision = run.integrations[task.taskId]?.integrationRevision ?? '(none)';
    const gates = (run.verifications[task.taskId] ?? []).map((record) => `${record.gate}:${record.passed ? 'PASS' : 'FAIL'}`).join(', ');
    lines.push(`- ${task.taskId} ${task.title}: ${task.state}; revision ${revision}; ${gates || 'no gates'}`);
  }
  return lines.join('\n');
}

async function routeSystemReview(runtime: WorkflowRuntime, deps: WorkflowDependencies): Promise<void> {
  const orchestration = await recoverOrchestrationState();
  const tasks = Object.values(orchestration.state.tasks);
  if (tasks.length === 0 || tasks.some((task) => task.state !== 'VERIFIED')) return;
  let run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
  if (run.status === 'verified' || run.status === 'blocked') return;
  let review = run.systemReview;
  if (!review) {
    review = { operationId: randomUUID(), reviewerId: null, verdict: null, findings: [] };
    run = await updateRun(runtime.runId, (current) => ({ ...current, status: 'awaiting_system_review', systemReview: review }));
  }
  if (review.reviewerId) return;
  const excluded = tasks.map((task) => task.assignedWorkerId).filter((value): value is string => Boolean(value));
  excluded.push(runtime.managerAgentId);
  const reviewerId = await deps.assignSystemReviewer(runtime, systemSummary(tasks, run), review.operationId, excluded, run.integrationWorktree);
  if (!reviewerId) return;
  await updateRun(runtime.runId, (current) => ({ ...current, systemReview: { ...(current.systemReview as SystemReviewRecord), reviewerId } }));
  await deps.notifyManager(runtime, `System Reviewer ${reviewerId} is checking the fully verified integrated run.`);
}

export async function advanceWorkflowForRuntime(
  runtime: WorkflowRuntime,
  roots: readonly Root[],
  allowCommands: boolean,
  deps: WorkflowDependencies = DEFAULT_DEPS
): Promise<void> {
  const orchestration = await recoverOrchestrationState();
  if (orchestration.state.runId !== runtime.runId || orchestration.state.managerAgentId !== runtime.managerAgentId) {
    throw new Error('WORKFLOW_AUTHORITY_MISMATCH');
  }
  await reconcileSettledReviewBookkeeping(runtime);
  await ensureReviewOutcomeDeliveries(runtime, deps);
  await routePendingReviews(runtime, deps);
  await integrateAndVerify(runtime, roots, allowCommands, deps);
  await routeSystemReview(runtime, deps);
}

export async function submitTaskCompletionForRuntime(
  runtime: WorkflowRuntime,
  actorAgentId: string,
  input: CompletionInput,
  roots: readonly Root[],
  allowCommands: boolean,
  deps: WorkflowDependencies = DEFAULT_DEPS
): Promise<{ taskId: string; reviewerId: string | null }> {
  await reconcileSettledReviewBookkeeping(runtime);
  const orchestration = await recoverOrchestrationState();
  const task = orchestration.state.tasks[input.taskId];
  if (!task) throw new Error(`Unknown orchestration task: ${input.taskId}`);
  if (task.assignedWorkerId !== actorAgentId) throw new Error(`${actorAgentId} is not the assigned worker for ${task.taskId}`);
  if (!task.worktreeId) throw new Error(`Task ${task.taskId} has no worktree`);
  const worktree = orchestration.state.worktrees[task.worktreeId];
  if (!worktree) throw new Error(`Task ${task.taskId} worktree record is missing`);

  const existingRun = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
  const existing = existingRun.completions[task.taskId];
  if (task.state === 'READY_FOR_REVIEW' || task.state === 'REVIEWING') {
    if (!existing || existing.revision !== input.revision.toLowerCase()) throw new Error('Task completion is already in review with different evidence');
    await advanceWorkflowForRuntime(runtime, roots, allowCommands, deps);
    return { taskId: task.taskId, reviewerId: (await workflowStateForRun(runtime.runId))?.reviews[task.taskId]?.reviewerId ?? null };
  }
  if (task.state !== 'ASSIGNED' && task.state !== 'ACTIVE') throw new Error(`Task ${task.taskId} cannot complete from ${task.state}`);

  const completion = await inspectCompletion(task, worktree, input);
  await updateRun(runtime.runId, (run) => ({ ...run, status: 'running', completions: { ...run.completions, [task.taskId]: completion } }));
  const events: NewOrchestrationEvent[] = [];
  if (task.state === 'ASSIGNED') {
    events.push({ eventId: `completion-active:${task.taskId}:${randomUUID()}`, runId: runtime.runId, time: Date.now(), type: 'TASK_ACTIVATED', actor: 'kernel', entityId: task.taskId, payload: {} });
  }
  events.push({ eventId: `completion-ready:${task.taskId}:${completion.revision}`, runId: runtime.runId, time: Date.now(), type: 'TASK_REVIEW_READY', actor: actorAgentId, entityId: task.taskId, payload: { revision: completion.revision } });
  await appendOrchestrationEvents(events);
  await advanceWorkflowForRuntime(runtime, roots, allowCommands, deps);
  return { taskId: task.taskId, reviewerId: (await workflowStateForRun(runtime.runId))?.reviews[task.taskId]?.reviewerId ?? null };
}

function normalizeReview(input: ReviewInput): ReviewInput {
  const taskId = boundedText(input.taskId, 'task_id', 160);
  if (input.verdict !== 'APPROVED' && input.verdict !== 'CHANGES_REQUESTED' && input.verdict !== 'BLOCKED') throw new Error('Invalid review verdict');
  return { taskId, verdict: input.verdict, findings: boundedList(input.findings, 'findings') };
}

export async function submitTaskReviewForRuntime(
  runtime: WorkflowRuntime,
  actorAgentId: string,
  input: ReviewInput,
  roots: readonly Root[],
  allowCommands: boolean,
  deps: WorkflowDependencies = DEFAULT_DEPS
): Promise<{ taskId: string; verdict: ReviewVerdict }> {
  const normalized = normalizeReview(input);
  const orchestration = await recoverOrchestrationState();
  const task = orchestration.state.tasks[normalized.taskId];
  if (!task) throw new Error(`Unknown orchestration task: ${normalized.taskId}`);
  if (task.state !== 'REVIEWING') throw new Error(`Task ${task.taskId} is not being reviewed`);
  const run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
  const review = run.reviews[task.taskId];
  if (!review?.reviewerId || review.reviewerId !== actorAgentId) throw new Error(`${actorAgentId} is not the assigned reviewer for ${task.taskId}`);
  if (review.verdict !== null) {
    if (review.verdict !== normalized.verdict) throw new Error('Review was already settled with a different verdict');
    if (review.verdict === 'APPROVED') {
      await appendTaskEvent(runtime, task.taskId, 'TASK_APPROVED', { reviewerId: actorAgentId, round: review.round });
      await advanceWorkflowForRuntime(runtime, roots, allowCommands, deps);
    } else if (review.verdict === 'CHANGES_REQUESTED' && review.round >= MAX_REVIEW_ROUNDS) {
      await appendTaskEvent(runtime, task.taskId, 'TASK_BLOCKED', {
        reviewerId: actorAgentId,
        round: review.round,
        reason: 'MAX_REVIEW_ROUNDS exhausted'
      });
      await archiveSettledReview(runtime, task.taskId, review, 'blocked');
      await ensureReviewOutcomeDeliveries(runtime, deps);
    } else if (review.verdict === 'CHANGES_REQUESTED') {
      await appendOrchestrationEvents([
        { eventId: `review-changes:${task.taskId}:${randomUUID()}`, runId: runtime.runId, time: Date.now(), type: 'TASK_CHANGES_REQUESTED', actor: actorAgentId, entityId: task.taskId, payload: { round: review.round } },
        { eventId: `review-reactivate:${task.taskId}:${randomUUID()}`, runId: runtime.runId, time: Date.now(), type: 'TASK_ACTIVATED', actor: 'kernel', entityId: task.taskId, payload: {} }
      ]);
      await archiveSettledReview(runtime, task.taskId, review, 'running');
      await ensureReviewOutcomeDeliveries(runtime, deps);
    } else if (review.verdict === 'BLOCKED') {
      await appendTaskEvent(runtime, task.taskId, 'TASK_BLOCKED', {
        reviewerId: actorAgentId,
        round: review.round,
        reason: review.findings.join(' | ')
      });
      await archiveSettledReview(runtime, task.taskId, review, 'blocked');
      await ensureReviewOutcomeDeliveries(runtime, deps);
    }
    return { taskId: task.taskId, verdict: normalized.verdict };
  }
  const settled: ReviewRecord = { ...review, verdict: normalized.verdict, findings: normalized.findings };
  await updateRun(runtime.runId, (current) => ({ ...current, reviews: { ...current.reviews, [task.taskId]: settled } }));

  if (normalized.verdict === 'APPROVED') {
    await appendTaskEvent(runtime, task.taskId, 'TASK_APPROVED', { reviewerId: actorAgentId, round: review.round });
    await advanceWorkflowForRuntime(runtime, roots, allowCommands, deps);
    return { taskId: task.taskId, verdict: normalized.verdict };
  }

  if (normalized.verdict === 'BLOCKED' || review.round >= MAX_REVIEW_ROUNDS) {
    await appendTaskEvent(runtime, task.taskId, 'TASK_BLOCKED', {
      reviewerId: actorAgentId,
      round: review.round,
      reason: normalized.verdict === 'BLOCKED' ? normalized.findings.join(' | ') : 'MAX_REVIEW_ROUNDS exhausted'
    });
    await archiveSettledReview(runtime, task.taskId, settled, 'blocked');
    await ensureReviewOutcomeDeliveries(runtime, deps);
    return { taskId: task.taskId, verdict: normalized.verdict };
  }

  await appendOrchestrationEvents([
    { eventId: `review-changes:${task.taskId}:${randomUUID()}`, runId: runtime.runId, time: Date.now(), type: 'TASK_CHANGES_REQUESTED', actor: actorAgentId, entityId: task.taskId, payload: { round: review.round } },
    { eventId: `review-reactivate:${task.taskId}:${randomUUID()}`, runId: runtime.runId, time: Date.now(), type: 'TASK_ACTIVATED', actor: 'kernel', entityId: task.taskId, payload: {} }
  ]);
  await archiveSettledReview(runtime, task.taskId, settled, 'running');
  await ensureReviewOutcomeDeliveries(runtime, deps);
  return { taskId: task.taskId, verdict: normalized.verdict };
}

async function runtimeForCaller(caller: Caller): Promise<{ runtime: WorkflowRuntime; agentId: string }> {
  const status = statusForCaller(caller);
  const orchestration = await recoverOrchestrationState();
  if (!orchestration.state.runId || !orchestration.state.managerAgentId) throw new Error('No Agent System 3.0 run is active');
  const ownerPrimeConversationId = agentConversation(PRIME_ID);
  if (!ownerPrimeConversationId) throw new Error('WORKFLOW_PRIME_IDENTITY_LOST');
  return {
    runtime: {
      runId: orchestration.state.runId,
      managerAgentId: orchestration.state.managerAgentId,
      ownerPrimeConversationId
    },
    agentId: status.self.id
  };
}

export async function submitTaskCompletionForCaller(
  caller: Caller,
  input: CompletionInput,
  roots: readonly Root[],
  allowCommands: boolean
) {
  const { runtime, agentId } = await runtimeForCaller(caller);
  return submitTaskCompletionForRuntime(runtime, agentId, input, roots, allowCommands);
}

export async function submitTaskReviewForCaller(
  caller: Caller,
  input: ReviewInput,
  roots: readonly Root[],
  allowCommands: boolean
) {
  const { runtime, agentId } = await runtimeForCaller(caller);
  return submitTaskReviewForRuntime(runtime, agentId, input, roots, allowCommands);
}

export async function submitRunReviewForRuntime(
  runtime: WorkflowRuntime,
  actorAgentId: string,
  verdict: 'APPROVED' | 'BLOCKED',
  findings: string[],
  deps: WorkflowDependencies = DEFAULT_DEPS
): Promise<{ verdict: 'APPROVED' | 'BLOCKED' }> {
  const run = (await workflowStateForRun(runtime.runId)) ?? emptyRun(runtime.runId);
  const review = run.systemReview;
  if (!review?.reviewerId || review.reviewerId !== actorAgentId) throw new Error(`${actorAgentId} is not the assigned System Reviewer`);
  const boundedFindings = boundedList(findings, 'findings');
  if (verdict === 'APPROVED') {
    const orchestration = await recoverOrchestrationState();
    const tasks = Object.values(orchestration.state.tasks);
    if (
      orchestration.state.runId !== runtime.runId ||
      orchestration.state.managerAgentId !== runtime.managerAgentId ||
      tasks.length === 0 ||
      tasks.some((task) => task.state !== 'VERIFIED')
    ) {
      throw new Error('SYSTEM_REVIEW_NOT_READY: all required tasks must be VERIFIED under the current run before approval');
    }
    for (const task of tasks) {
      const integration = run.integrations[task.taskId];
      const records = run.verifications[task.taskId] ?? [];
      if (
        !integration?.integrationRevision ||
        integration.error ||
        records.length === 0 ||
        records.some((record) => !record.passed || record.revision !== integration.integrationRevision)
      ) {
        throw new Error(`SYSTEM_REVIEW_NOT_READY: ${task.taskId} does not have fresh passing verification for its integrated revision`);
      }
    }
  }
  await updateRun(runtime.runId, (current) => ({
    ...current,
    status: verdict === 'APPROVED' ? 'verified' : 'blocked',
    systemReview: { ...(current.systemReview as SystemReviewRecord), verdict, findings: boundedFindings }
  }));
  if (verdict === 'APPROVED') {
    const orchestration = await recoverOrchestrationState();
    if (orchestration.state.runStatus !== 'RUN_VERIFIED') {
      await appendOrchestrationEvent({
        eventId: `workflow:RUN_VERIFIED:${runtime.runId}:${review.operationId}`,
        runId: runtime.runId,
        time: Date.now(),
        type: 'RUN_VERIFIED',
        actor: actorAgentId,
        entityId: runtime.runId,
        payload: { systemReviewOperationId: review.operationId }
      });
    }
  }
  await deps.notifyManager(
    runtime,
    verdict === 'APPROVED'
      ? 'SYSTEM REVIEW APPROVED: all tasks are integrated and fresh verification evidence is green. Report the verified result to Prime.'
      : `SYSTEM REVIEW BLOCKED: ${boundedFindings.join(' | ')}`
  );
  return { verdict };
}

export async function submitRunReviewForCaller(
  caller: Caller,
  verdict: 'APPROVED' | 'BLOCKED',
  findings: string[]
) {
  const { runtime, agentId } = await runtimeForCaller(caller);
  return submitRunReviewForRuntime(runtime, agentId, verdict, findings);
}

export async function advanceWorkflowForCaller(caller: Caller, roots: readonly Root[], allowCommands: boolean): Promise<void> {
  const { runtime, agentId } = await runtimeForCaller(caller);
  if (agentId !== runtime.managerAgentId) throw new Error('Only the designated Manager may manually advance orchestration');
  await advanceWorkflowForRuntime(runtime, roots, allowCommands);
}
