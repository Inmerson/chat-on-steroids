import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { runAntigravity, type AntigravityRunResult } from './runtime.js';

export type GoalDriverResult =
  | { kind: 'no-reply'; raw: 'NO_REPLY' }
  | { kind: 'message'; text: string };

export interface GoalDriverInput {
  goal: string;
  messages: readonly { role: 'user' | 'assistant'; content: string }[];
}

type GoalDriver = (input: GoalDriverInput) => Promise<GoalDriverResult>;

const GOAL_TIMEOUT_MS = 90_000;
const MAX_GOAL_REPLY_CHARS = 4_000;
let goalDriverOverride: GoalDriver | null = null;

function goalPrompt(input: GoalDriverInput): string {
  const transcript = input.messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join('\n\n');
  return [
    'You are continuing a ChatGPT conversation as the user. Decide only the next user message needed to finish the active goal.',
    'Return exactly one short next-user message, or exactly NO_REPLY when the active goal is fully complete.',
    'Do not output analysis, labels, JSON, markdown fences, tool requests, file requests, or explanations.',
    '',
    'ACTIVE GOAL:',
    input.goal,
    '',
    'TRANSCRIPT:',
    transcript
  ].join('\n');
}

function validateRuntimeEvidence(result: AntigravityRunResult): void {
  if (result.toolCalls !== 0 || result.toolErrors.length !== 0 || result.observedFiles.length !== 0) {
    throw new Error('Goal Driver rejected tool-derived evidence.');
  }
  if (result.partial || result.budgetExceeded) {
    throw new Error('Goal Driver rejected partial or budget-exceeded output.');
  }
}

function parseGoalOutput(raw: string): GoalDriverResult {
  const text = raw.trim();
  if (!text) throw new Error('Goal Driver returned empty output.');
  if (text === 'NO_REPLY') return { kind: 'no-reply', raw: 'NO_REPLY' };
  if (text.length > MAX_GOAL_REPLY_CHARS) throw new Error('Goal Driver output is too long.');
  if (/^NO_REPLY$/m.test(text) || /[\u0000\u001e]/.test(text)) {
    throw new Error('Goal Driver output is protocol-contaminated.');
  }
  return { kind: 'message', text };
}

async function runGoalDriver(input: GoalDriverInput): Promise<GoalDriverResult> {
  const parent = path.join(app.getPath('userData'), 'antigravity-goal-scratch');
  await fs.mkdir(parent, { recursive: true });
  const cwd = await fs.mkdtemp(path.join(parent, 'run-'));
  try {
    const result = await runAntigravity({
      prompt: goalPrompt(input),
      cwd,
      timeoutMs: GOAL_TIMEOUT_MS,
      hardToolCalls: 0,
      allowPartial: false
    });
    validateRuntimeEvidence(result);
    return parseGoalOutput(result.finalText);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function draftGoalWithAntigravity(input: GoalDriverInput): Promise<GoalDriverResult> {
  if (goalDriverOverride) return goalDriverOverride(input);
  return runGoalDriver(input);
}

export function setGoalDriverForTests(driver: GoalDriver | null): void {
  goalDriverOverride = driver;
}

export const goalPromptForTests = goalPrompt;
