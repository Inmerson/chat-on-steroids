/**
 * Durable autonomous desktop execution runs.
 *
 * A remote/phone chat is only a control plane. Once it asks Core to start an approved plan,
 * this module owns the durable execution identity independently of that caller's lifetime.
 * Browser tabs and conversations are replaceable views attached to this record later.
 */

import { randomUUID } from 'node:crypto';
import * as durable from './durable.js';

export const EXECUTION_STATE = 'execution-runs';
export const MAX_EXECUTION_PLAN_CHARS = 120_000;
const MAX_EXECUTION_TITLE_CHARS = 160;

export type ExecutionLoopMode = 'standard' | 'infinite';
export type ExecutionRunStatus = 'starting' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed';

export interface ExecutionRun {
  id: string;
  title: string | null;
  plan: string;
  mode: ExecutionLoopMode;
  status: ExecutionRunStatus;
  conversationId: string | null;
  commandId: string | null;
  createdAt: number;
  updatedAt: number;
  stoppedAt: number | null;
  lastError: string | null;
}

export interface ExecutionSnapshot {
  version: 1;
  runs: ExecutionRun[];
}

const runs = new Map<string, ExecutionRun>();

function cloneRun(run: ExecutionRun): ExecutionRun {
  return { ...run };
}

function normalizedTitle(value: string | undefined): string | null {
  if (value === undefined) return null;
  const title = value.trim();
  if (!title) return null;
  if (title.length > MAX_EXECUTION_TITLE_CHARS) {
    throw new Error(`Execution title must be at most ${MAX_EXECUTION_TITLE_CHARS} characters`);
  }
  return title;
}

function validPlan(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Execution plan is required');
  if (value.length > MAX_EXECUTION_PLAN_CHARS) {
    throw new Error(`Execution plan must be at most ${MAX_EXECUTION_PLAN_CHARS} characters`);
  }
  return value;
}

function validMode(value: unknown): value is ExecutionLoopMode {
  return value === 'standard' || value === 'infinite';
}

function validStatus(value: unknown): value is ExecutionRunStatus {
  return ['starting', 'running', 'paused', 'stopped', 'failed', 'completed'].includes(String(value));
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256;
}

function restoredRun(raw: unknown): ExecutionRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<ExecutionRun>;
  if (!validIdentifier(row.id)) return null;
  if (typeof row.plan !== 'string' || row.plan.trim().length === 0 || row.plan.length > MAX_EXECUTION_PLAN_CHARS) return null;
  if (!validMode(row.mode) || !validStatus(row.status)) return null;
  if (row.title !== null && (typeof row.title !== 'string' || row.title.length > MAX_EXECUTION_TITLE_CHARS)) return null;
  if (row.conversationId !== null && !validIdentifier(row.conversationId)) return null;
  if (row.commandId !== null && !validIdentifier(row.commandId)) return null;
  if (!Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt)) return null;
  if (row.stoppedAt !== null && !Number.isFinite(row.stoppedAt)) return null;
  if (row.lastError !== null && typeof row.lastError !== 'string') return null;
  return {
    id: row.id,
    title: row.title ?? null,
    plan: row.plan,
    mode: row.mode,
    status: row.status,
    conversationId: row.conversationId ?? null,
    commandId: row.commandId ?? null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    stoppedAt: row.stoppedAt === null ? null : Number(row.stoppedAt),
    lastError: row.lastError ?? null
  };
}

export function snapshotExecutions(): ExecutionSnapshot {
  return { version: 1, runs: [...runs.values()].map(cloneRun) };
}

export function restoreExecutions(snapshot: ExecutionSnapshot | null): void {
  runs.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) return;
  const conversations = new Set<string>();
  for (const raw of snapshot.runs) {
    const run = restoredRun(raw);
    if (!run || runs.has(run.id)) continue;
    if (run.conversationId && conversations.has(run.conversationId)) continue;
    runs.set(run.id, run);
    if (run.conversationId) conversations.add(run.conversationId);
  }
}

export function executionRun(id: string): ExecutionRun | null {
  const run = runs.get(id);
  return run ? cloneRun(run) : null;
}

export function executionForConversation(conversationId: string): ExecutionRun | null {
  for (const run of runs.values()) {
    if (run.conversationId === conversationId) return cloneRun(run);
  }
  return null;
}

async function persistReplacement(id: string, next: ExecutionRun): Promise<ExecutionRun> {
  const before = runs.get(id);
  runs.set(id, next);
  try {
    await durable.writeDurableNow(EXECUTION_STATE, snapshotExecutions());
  } catch (error) {
    if (before) runs.set(id, before);
    else runs.delete(id);
    durable.writeDurableSoon(EXECUTION_STATE, snapshotExecutions());
    throw error;
  }
  return cloneRun(next);
}

export async function createExecution(input: {
  plan: string;
  title?: string;
  mode: ExecutionLoopMode;
}): Promise<ExecutionRun> {
  const plan = validPlan(input.plan);
  if (!validMode(input.mode)) throw new Error('Execution mode must be standard or infinite');
  const now = Date.now();
  const run: ExecutionRun = {
    id: randomUUID(),
    title: normalizedTitle(input.title),
    plan,
    mode: input.mode,
    status: 'starting',
    conversationId: null,
    commandId: null,
    createdAt: now,
    updatedAt: now,
    stoppedAt: null,
    lastError: null
  };
  return persistReplacement(run.id, run);
}

export async function noteExecutionCommand(id: string, commandId: string): Promise<ExecutionRun> {
  const run = runs.get(id);
  if (!run) throw new Error(`Unknown execution run: ${id}`);
  if (!validIdentifier(commandId)) throw new Error('Execution command id is invalid');
  if (run.commandId === commandId) return cloneRun(run);
  if (run.status === 'stopped' || run.status === 'failed' || run.status === 'completed') {
    throw new Error(`Execution run ${id} is already terminal`);
  }
  return persistReplacement(id, { ...run, commandId, updatedAt: Date.now() });
}

export async function bindExecutionConversation(id: string, conversationId: string): Promise<ExecutionRun> {
  const run = runs.get(id);
  if (!run) throw new Error(`Unknown execution run: ${id}`);
  if (!validIdentifier(conversationId)) throw new Error('Execution conversation id is invalid');
  if (run.conversationId === conversationId) return cloneRun(run);
  const owner = executionForConversation(conversationId);
  if (owner && owner.id !== id) throw new Error(`Conversation already belongs to execution run ${owner.id}`);
  if (run.status === 'stopped' || run.status === 'failed' || run.status === 'completed') {
    throw new Error(`Execution run ${id} is already terminal`);
  }
  return persistReplacement(id, { ...run, conversationId, updatedAt: Date.now() });
}

export async function setExecutionStatus(
  id: string,
  status: ExecutionRunStatus,
  error: string | null = null
): Promise<ExecutionRun> {
  const run = runs.get(id);
  if (!run) throw new Error(`Unknown execution run: ${id}`);
  if (!validStatus(status)) throw new Error(`Invalid execution status: ${status}`);
  if (run.status === status && run.lastError === error) return cloneRun(run);
  if (run.status === 'stopped' || run.status === 'failed' || run.status === 'completed') {
    throw new Error(`Execution run ${id} is already terminal`);
  }
  const now = Date.now();
  const terminal = status === 'stopped' || status === 'failed' || status === 'completed';
  return persistReplacement(id, {
    ...run,
    status,
    updatedAt: now,
    stoppedAt: terminal ? now : null,
    lastError: error
  });
}

export function executionBootstrapText(id: string): string {
  const run = runs.get(id);
  if (!run) throw new Error(`Unknown execution run: ${id}`);
  const modeLine =
    run.mode === 'infinite'
      ? 'Only after this milestone is verified complete, you may select the next highest-value improvement and continue.'
      : 'Do not expand into unrelated feature work.';
  return [
    '@Chat On Steroids Core',
    '',
    'Execute only the approved plan below autonomously. Preserve unrelated working-tree changes. Make routine technical decisions yourself when safe. Use Chat On Steroids Core tools as needed. Verify the implementation before declaring completion. Stop and surface a blocker only for a real authorization, destructive, privacy, or unresolved ambiguity boundary.',
    modeLine,
    '',
    'APPROVED PLAN',
    run.plan
  ].join('\n');
}

export function resetExecutionsForTests(): void {
  runs.clear();
}
