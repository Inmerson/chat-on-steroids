import { beforeEach, describe, expect, it } from 'vitest';
import {
  goalForSession,
  goalRevisionMatches,
  isGoalStopCommand,
  markGoalComplete,
  markGoalFailed,
  noteGoalAutoTurn,
  noteGoalStop,
  noteManualGoal,
  resetGoalStatesForTests,
  restoreGoalStates,
  snapshotGoalStates
} from '../src/main/goal-state.js';

beforeEach(() => resetGoalStatesForTests());

describe('durable session goal state', () => {
  it('creates and revises one active goal per durable session', () => {
    const one = noteManualGoal('s1', 'build it', 'm1');
    expect(one).toMatchObject({
      sessionId: 's1',
      revision: 1,
      status: 'active',
      text: 'build it',
      sourceMessageId: 'm1',
      consecutiveAutoTurns: 0
    });

    noteGoalAutoTurn('s1', 1);
    const two = noteManualGoal('s1', 'also run tests', 'm2');
    expect(two).toMatchObject({ revision: 2, status: 'active', text: 'also run tests', consecutiveAutoTurns: 0 });
    expect(goalRevisionMatches('s1', 1)).toBe(false);
    expect(goalRevisionMatches('s1', 2)).toBe(true);
  });

  it('recognizes only explicit local stop commands and resumes on the next manual goal', () => {
    expect(isGoalStopCommand('goalı durdur')).toBe(true);
    expect(isGoalStopCommand('Goal durdur!')).toBe(true);
    expect(isGoalStopCommand('stop goal')).toBe(true);
    expect(isGoalStopCommand('otomatik devamı kapat')).toBe(true);
    expect(isGoalStopCommand('investigate why goal stopped')).toBe(false);

    noteManualGoal('s1', 'do the work', 'm1');
    const stopped = noteGoalStop('s1', 'm-stop');
    expect(stopped).toMatchObject({ revision: 2, status: 'stopped', sourceMessageId: 'm-stop' });
    expect(goalRevisionMatches('s1', 1)).toBe(false);

    const resumed = noteManualGoal('s1', 'continue with this instead', 'm2');
    expect(resumed).toMatchObject({ revision: 3, status: 'active', text: 'continue with this instead' });
  });

  it('applies completion/failure only to the current revision', () => {
    noteManualGoal('s1', 'first', 'm1');
    noteManualGoal('s1', 'second', 'm2');

    expect(markGoalComplete('s1', 1)).toBe(false);
    expect(markGoalFailed('s1', 1)).toBe(false);
    expect(goalForSession('s1')?.status).toBe('active');
    expect(markGoalFailed('s1', 2)).toBe(true);
    expect(goalForSession('s1')?.status).toBe('failed');
  });

  it('pauses after 32 successful automatic turns without resetting across revisions accidentally', () => {
    noteManualGoal('s1', 'long unattended task', 'm1');
    for (let turn = 1; turn <= 31; turn += 1) {
      expect(noteGoalAutoTurn('s1', 1)).toMatchObject({ status: 'active', consecutiveAutoTurns: turn });
    }
    expect(noteGoalAutoTurn('s1', 1)).toMatchObject({ status: 'stopped', consecutiveAutoTurns: 32 });
    expect(noteGoalAutoTurn('s1', 1)).toBeNull();

    expect(noteManualGoal('s1', 'new instruction', 'm2')).toMatchObject({
      revision: 2,
      status: 'active',
      consecutiveAutoTurns: 0
    });
  });

  it('restores only valid bounded goal rows and never restores send/draft authority', () => {
    restoreGoalStates({
      version: 1,
      goals: [
        {
          sessionId: 's-good',
          revision: 7,
          status: 'active',
          text: 'keep going',
          sourceMessageId: 'm-7',
          updatedAt: 1234,
          consecutiveAutoTurns: 5,
          token: 'must-not-survive',
          clientId: 'must-not-survive'
        },
        { sessionId: '../bad', revision: -1, status: 'active', text: 'bad', sourceMessageId: '', updatedAt: 0, consecutiveAutoTurns: 0 }
      ]
    });

    expect(goalForSession('s-good')).toEqual({
      sessionId: 's-good',
      revision: 7,
      status: 'active',
      text: 'keep going',
      sourceMessageId: 'm-7',
      updatedAt: 1234,
      consecutiveAutoTurns: 5
    });
    expect(goalForSession('../bad')).toBeNull();
    expect(JSON.stringify(snapshotGoalStates())).not.toMatch(/token|clientId/);
  });

  it('bounds snapshots to 256 sessions while preserving active rows first', () => {
    for (let i = 0; i < 270; i += 1) {
      const state = noteManualGoal(`session-${i}`, `goal ${i}`, `message-${i}`);
      if (i < 10) continue;
      markGoalComplete(state.sessionId, state.revision);
    }
    const snapshot = snapshotGoalStates();
    expect(snapshot.goals).toHaveLength(256);
    for (let i = 0; i < 10; i += 1) expect(snapshot.goals.some((goal) => goal.sessionId === `session-${i}`)).toBe(true);
  });
});
