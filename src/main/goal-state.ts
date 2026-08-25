import { writeDurableSoon } from './durable.js';

export type { UserMessageProvenance } from '../shared/session.js';
export type GoalStatus = 'active' | 'stopped' | 'complete' | 'failed';

export interface ActiveGoalState {
  sessionId: string;
  revision: number;
  status: GoalStatus;
  text: string;
  sourceMessageId: string;
  updatedAt: number;
  consecutiveAutoTurns: number;
}

export interface GoalStateSnapshot {
  version: 1;
  goals: ActiveGoalState[];
}

export const GOALS_STATE = 'goals';
export const MAX_GOAL_AUTO_TURNS = 32;

const MAX_GOAL_SESSIONS = 256;
const MAX_GOAL_TEXT = 16_000;
const MAX_MESSAGE_ID = 200;
const SESSION_ID = /^[a-z0-9-]{1,64}$/i;
const STATUSES = new Set<GoalStatus>(['active', 'stopped', 'complete', 'failed']);
const goals = new Map<string, ActiveGoalState>();

function cloneGoal(goal: ActiveGoalState): ActiveGoalState {
  return { ...goal };
}

function snapshotRows(): ActiveGoalState[] {
  const rows = [...goals.values()];
  const active = rows.filter((row) => row.status === 'active').sort((a, b) => b.updatedAt - a.updatedAt);
  const inactive = rows.filter((row) => row.status !== 'active').sort((a, b) => b.updatedAt - a.updatedAt);
  return [...active, ...inactive].slice(0, MAX_GOAL_SESSIONS).map(cloneGoal);
}

function persist(): void {
  writeDurableSoon(GOALS_STATE, { version: 1, goals: snapshotRows() } satisfies GoalStateSnapshot);
}

function validText(value: string): string {
  const text = value.trim();
  if (!text) throw new Error('Goal text must not be empty.');
  if (text.length > MAX_GOAL_TEXT) throw new Error('Goal text is too long.');
  return text;
}

function validSessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error('Invalid goal session id.');
  return value;
}

function validMessageId(value: string): string {
  const id = value.trim();
  if (!id || id.length > MAX_MESSAGE_ID) throw new Error('Invalid goal source message id.');
  return id;
}

function setGoal(goal: ActiveGoalState): ActiveGoalState {
  goals.set(goal.sessionId, goal);
  persist();
  return cloneGoal(goal);
}

export function isGoalStopCommand(text: string): boolean {
  const normalized = text
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ');
  return /^(?:goal[ıi]? durdur|goal durdur|stop goal|otomatik devam[ıi]? kapat)$/.test(normalized);
}

export function goalForSession(sessionId: string): ActiveGoalState | null {
  const goal = goals.get(sessionId);
  return goal ? cloneGoal(goal) : null;
}

export function noteManualGoal(sessionId: string, text: string, messageId: string): ActiveGoalState {
  validSessionId(sessionId);
  const goalText = validText(text);
  const sourceMessageId = validMessageId(messageId);
  const previous = goals.get(sessionId);
  return setGoal({
    sessionId,
    revision: (previous?.revision ?? 0) + 1,
    status: 'active',
    text: goalText,
    sourceMessageId,
    updatedAt: Date.now(),
    consecutiveAutoTurns: 0
  });
}

export function noteGoalStop(sessionId: string, messageId: string): ActiveGoalState | null {
  validSessionId(sessionId);
  const sourceMessageId = validMessageId(messageId);
  const previous = goals.get(sessionId);
  if (!previous) return null;
  if (previous.status === 'stopped') return cloneGoal(previous);
  return setGoal({
    ...previous,
    revision: previous.revision + 1,
    status: 'stopped',
    sourceMessageId,
    updatedAt: Date.now()
  });
}

function markStatus(sessionId: string, revision: number, status: 'complete' | 'failed'): boolean {
  const previous = goals.get(sessionId);
  if (!previous || previous.revision !== revision || previous.status !== 'active') return false;
  setGoal({ ...previous, status, updatedAt: Date.now() });
  return true;
}

export function markGoalComplete(sessionId: string, revision: number): boolean {
  return markStatus(sessionId, revision, 'complete');
}

export function markGoalFailed(sessionId: string, revision: number): boolean {
  return markStatus(sessionId, revision, 'failed');
}

export function noteGoalAutoTurn(sessionId: string, revision: number): ActiveGoalState | null {
  const previous = goals.get(sessionId);
  if (!previous || previous.revision !== revision || previous.status !== 'active') return null;
  const consecutiveAutoTurns = previous.consecutiveAutoTurns + 1;
  return setGoal({
    ...previous,
    status: consecutiveAutoTurns >= MAX_GOAL_AUTO_TURNS ? 'stopped' : 'active',
    consecutiveAutoTurns,
    updatedAt: Date.now()
  });
}

export function goalRevisionMatches(sessionId: string, revision: number): boolean {
  const goal = goals.get(sessionId);
  return goal?.revision === revision && goal.status === 'active';
}

export function snapshotGoalStates(): GoalStateSnapshot {
  return { version: 1, goals: snapshotRows() };
}

function restoredGoal(value: unknown): ActiveGoalState | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row['sessionId'] !== 'string' || !SESSION_ID.test(row['sessionId'])) return null;
  if (typeof row['revision'] !== 'number' || !Number.isSafeInteger(row['revision']) || row['revision'] < 1) return null;
  if (typeof row['status'] !== 'string' || !STATUSES.has(row['status'] as GoalStatus)) return null;
  if (typeof row['text'] !== 'string' || !row['text'].trim() || row['text'].length > MAX_GOAL_TEXT) return null;
  if (typeof row['sourceMessageId'] !== 'string' || !row['sourceMessageId'].trim() || row['sourceMessageId'].length > MAX_MESSAGE_ID) {
    return null;
  }
  if (typeof row['updatedAt'] !== 'number' || !Number.isSafeInteger(row['updatedAt']) || row['updatedAt'] < 0) return null;
  if (
    typeof row['consecutiveAutoTurns'] !== 'number' ||
    !Number.isSafeInteger(row['consecutiveAutoTurns']) ||
    row['consecutiveAutoTurns'] < 0 ||
    row['consecutiveAutoTurns'] > MAX_GOAL_AUTO_TURNS
  ) {
    return null;
  }
  return {
    sessionId: row['sessionId'],
    revision: row['revision'],
    status: row['status'] as GoalStatus,
    text: row['text'].trim(),
    sourceMessageId: row['sourceMessageId'].trim(),
    updatedAt: row['updatedAt'],
    consecutiveAutoTurns: row['consecutiveAutoTurns']
  };
}

export function restoreGoalStates(snapshot: unknown): void {
  goals.clear();
  if (!snapshot || typeof snapshot !== 'object') return;
  const raw = snapshot as Record<string, unknown>;
  if (raw['version'] !== 1 || !Array.isArray(raw['goals'])) return;
  const accepted: ActiveGoalState[] = [];
  for (const value of raw['goals'].slice(0, MAX_GOAL_SESSIONS * 4)) {
    const goal = restoredGoal(value);
    if (goal) accepted.push(goal);
  }
  const active = accepted.filter((row) => row.status === 'active').sort((a, b) => b.updatedAt - a.updatedAt);
  const inactive = accepted.filter((row) => row.status !== 'active').sort((a, b) => b.updatedAt - a.updatedAt);
  for (const row of [...active, ...inactive].slice(0, MAX_GOAL_SESSIONS)) {
    if (!goals.has(row.sessionId)) goals.set(row.sessionId, row);
  }
}

export function resetGoalStatesForTests(): void {
  goals.clear();
}
