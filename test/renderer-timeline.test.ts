import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentPlan } from '../src/shared/agent-plan.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
  vi.unstubAllGlobals();
});

function summary(id: string, title: string, conversationId: string): SessionSummary {
  const now = Date.now();
  return {
    id,
    title,
    conversationId,
    chatIds: [conversationId],
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    events: 0,
    userMessages: 1,
    toolCalls: 0,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 100,
    contextTokens: 100,
    autoCompactTriggeredAt: null,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    agents: [],
    origin: null
  };
}

const plan = (label: string): AgentPlan => ({
  updatedAt: Date.now(),
  plan: [{ step: label, status: 'in_progress' }]
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

it('switches plan identity immediately and ignores a late detail response from the previous session', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    Event: w.Event,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!w.HTMLElement.prototype.scrollIntoView) w.HTMLElement.prototype.scrollIntoView = () => undefined;

  const first = summary('2026-09-11-plan0001', 'First session', 'chat-plan-a');
  const second = summary('2026-09-11-plan0002', 'Second session', 'chat-plan-b');
  let resolveFirst!: (value: unknown) => void;
  const firstDetail = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const api: any = {
    listSessions: () => Promise.resolve({
      ok: true,
      data: { sessions: [first, second], total: 2, nextCursor: null, activeId: first.id, blocked: [], pressure: [] }
    }),
    getSession: (id: string) =>
      id === first.id
        ? firstDetail
        : Promise.resolve({
            ok: true,
            data: { summary: second, events: [], total: 0, nextFrom: 0, plan: plan('Plan B') }
          }),
    getHandoff: () => Promise.resolve({ ok: true, data: null }),
    getSwarm: () => Promise.resolve({ ok: true, data: { running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 } }),
    onSessionChanged: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    writeClipboard: () => Promise.resolve({ ok: true, data: true }),
    resetSwarm: () => Promise.resolve({ ok: true, data: { running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 } }),
    clearAgent: () => Promise.resolve({ ok: true, data: null }),
    unpairExtension: () => Promise.resolve({ ok: true, data: null }),
    openExtensionFolder: () => Promise.resolve({ ok: true, data: '' })
  };
  Object.defineProperty(w, 'api', { value: new Proxy(api, { get: (target, prop) => prop in target ? target[prop] : () => Promise.resolve({ ok: true, data: null }) }) });

  const { initChat, chatVisible } = await import('../src/renderer/chat.js');
  initChat({
    save: async () => undefined,
    state: () => ({ config: { sessions: { record: true } } }) as any
  });
  chatVisible(true);
  await settle();

  const host = w.document.getElementById('agentPlan')!;
  expect(host).not.toBeNull();
  const secondRow = w.document.querySelector<HTMLElement>(`#sessionList [data-id="${second.id}"]`)!;
  expect(secondRow).not.toBeNull();
  secondRow.click();
  expect(host.hidden).toBe(true);
  expect(host.childElementCount).toBe(0);
  await settle();
  expect(host.textContent).toContain('Plan B');

  resolveFirst({ ok: true, data: { summary: first, events: [], total: 0, nextFrom: 0, plan: plan('STALE PLAN A') } });
  await settle();
  expect(host.textContent).toContain('Plan B');
  expect(host.textContent).not.toContain('STALE PLAN A');
});
