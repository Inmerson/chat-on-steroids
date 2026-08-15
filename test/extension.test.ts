/**
 * Regression tests for the unpacked Chrome companion itself.
 *
 * These execute the shipped JavaScript rather than a TypeScript reimplementation. The
 * DOM adapter runs against tiny structural fakes for the ChatGPT shapes we have seen in
 * the browser, and the service worker runs in a VM with fake Chrome storage so its
 * restart/durability rules are exercised without needing a Chrome process in CI.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');

let domSource = '';
let backgroundSource = '';

beforeAll(async () => {
  [domSource, backgroundSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'background.js'), 'utf8')
  ]);
});

describe('extension release metadata', () => {
  it('keeps the app package, bundled extension and bridge protocol on the same release', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { version: string };
    expect(pkg.version).toBe(APP_VERSION);
    expect(manifest.version).toBe(APP_VERSION);
    expect(BRIDGE_PROTOCOL).toBe(3);
    expect(backgroundSource).toContain('const BRIDGE_PROTOCOL = 3;');
  });
});

// ---------------------------------------------------------------------- DOM

const TURN_SELECTOR = 'section[data-testid^="conversation-turn"]';
const TOOL_SELECTOR = 'span[class*="tool-message"]';

class FakeNode {
  textContent = '';
  innerText = '';
  className = '';
  tagName = 'DIV';
  children: FakeNode[] = [];
  private attrs = new Map<string, string>();
  private all = new Map<string, FakeNode[]>();
  private closestMatches = new Set<string>();

  constructor(attrs: Record<string, string> = {}, text = '') {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    this.textContent = text;
    this.innerText = text;
    this.className = attrs.class ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.all.get(selector) ?? [];
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  with(selector: string, nodes: FakeNode[]): this {
    this.all.set(selector, nodes);
    return this;
  }

  under(selector: string): this {
    this.closestMatches.add(selector);
    return this;
  }

  closest(selector: string): FakeNode | null {
    return this.closestMatches.has(selector) ? this : null;
  }
}

interface DomApi {
  turns(): Array<{ node: FakeNode; nodes: FakeNode[]; id: string | null; role: string | null }>;
  messages(): Array<{ id: string; role: string; text: string; turnId: string | null }>;
  progressLine(turn: unknown): string | null;
  interrupted(turn: unknown): boolean;
  markProgress(turn: unknown): number;
  toolBlocks(turn: unknown): FakeNode[];
  errors(): string[];
}

function loadDom(sections: FakeNode[]): DomApi {
  const document = {
    querySelectorAll: (selector: string) => (selector === TURN_SELECTOR ? sections : []),
    querySelector: () => null
  };
  const context = vm.createContext({ document, location: { pathname: '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } });
  vm.runInContext(domSource, context, { filename: 'chatgpt-dom.js' });
  return (context as unknown as { CLF_DOM: DomApi }).CLF_DOM;
}

function turn(role: 'user' | 'assistant', id: string): FakeNode {
  return new FakeNode({ 'data-testid': 'conversation-turn-1', 'data-turn': role, 'data-turn-id': id });
}

describe('ChatGPT DOM adapter', () => {
  it('groups split assistant sections that share one data-turn-id before counting tool blocks', () => {
    const user = turn('user', 'user-1');
    const a1 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [new FakeNode(), new FakeNode()]);
    const a2 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [new FakeNode(), new FakeNode(), new FakeNode()]);
    const dom = loadDom([user, a1, a2]);

    const turns = dom.turns();
    expect(turns).toHaveLength(2);
    const assistant = turns[1]!;
    expect(assistant.id).toBe('request-1');
    expect(assistant.nodes).toEqual([a1, a2]);
    expect(dom.toolBlocks(assistant)).toHaveLength(5);
  });

  it('does not mistake ChatGPT transport-failure markdown for a completed assistant answer', () => {
    const failure = new FakeNode({}, 'Message delivery timed out. Please try again. Retry');
    const assistant = turn('assistant', 'request-failed')
      .with('[data-message-id]', [])
      .with('.markdown', [failure])
      .with('[data-interrupted="true"]', []);
    const dom = loadDom([assistant]);

    expect(dom.messages()).toEqual([]);
    expect(dom.errors()).toEqual(['Message delivery timed out. Please try again. Retry']);
  });

  it('records assistant prose from .markdown when ChatGPT supplies no assistant data-message-id', () => {
    const userMessage = new FakeNode(
      { 'data-message-id': 'user-message-1', 'data-message-author-role': 'user' },
      'do the thing'
    );
    const user = turn('user', 'user-1').with('[data-message-id]', [userMessage]);

    const liveProgress = new FakeNode({}, 'Reading files').under('[data-interrupted]');
    const finalA = new FakeNode({}, 'First paragraph');
    const finalB = new FakeNode({}, 'Second paragraph');
    const assistant = turn('assistant', 'request-2')
      .with('[data-message-id]', [])
      .with('.markdown', [liveProgress, finalA, finalB])
      .with('[data-interrupted="true"]', []);

    const messages = loadDom([user, assistant]).messages();
    expect(messages).toEqual([
      { id: 'user-message-1', role: 'user', text: 'do the thing', turnId: 'user-1', interrupted: false },
      {
        id: 'assistant:request-2',
        role: 'assistant',
        text: 'First paragraph\n\nSecond paragraph',
        turnId: 'request-2',
        interrupted: false
      }
    ]);
  });

  it('marks only the observed progress containers so the overlay can make them legible', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tests');
    const a1 = turn('assistant', 'request-progress').with('[data-interrupted]', [firstBox]);
    const a2 = turn('assistant', 'request-progress').with('[data-interrupted]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;
    expect(dom.markProgress(logical)).toBe(2);
    expect(firstBox.getAttribute('data-clf-progress')).toBe('1');
    expect(secondBox.getAttribute('data-clf-progress')).toBe('1');
    expect(dom.markProgress(logical)).toBe(0);
  });

  it('reads the newest progress line across every data-interrupted section of a split request', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking\nReading files');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tool\nRunning tests');
    const a1 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [firstBox])
      .with('[data-interrupted="true"]', [firstBox]);
    const a2 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [secondBox])
      .with('[data-interrupted="true"]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;

    expect(dom.progressLine(logical)).toBe('Running tests');
    expect(dom.interrupted(logical)).toBe(true);
  });
});

// --------------------------------------------------------------- service worker

class FakeStorageArea {
  data: Record<string, unknown>;
  /** Optional quota used to make writes fail the way Chrome does. */
  maxBytes: number | null = null;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys: string[] | string): Promise<Record<string, unknown>> {
    const wanted = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }

  async set(values: Record<string, unknown>): Promise<void> {
    const next = { ...this.data, ...structuredClone(values) };
    if (this.maxBytes !== null && Buffer.byteLength(JSON.stringify(next), 'utf8') > this.maxBytes) {
      throw new Error('QUOTA_BYTES exceeded');
    }
    this.data = next;
  }
}

interface WorkerHarness {
  send(message: Record<string, unknown>, tabId?: number): Promise<any>;
  tabsCreate: ReturnType<typeof vi.fn>;
}

function response(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(data);
    }
  };
}

function loadWorker(options: {
  local: FakeStorageArea;
  session: FakeStorageArea;
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
}): WorkerHarness {
  let listener: ((message: any, sender: any, sendResponse: (value: any) => void) => boolean) | null = null;
  const tabsCreate = vi.fn(async () => ({ id: 99 }));
  const chrome = {
    storage: { local: options.local, session: options.session },
    runtime: {
      getManifest: () => ({ version: '1.5.1' }),
      onMessage: {
        addListener(fn: typeof listener) {
          listener = fn;
        }
      }
    },
    tabs: { create: tabsCreate }
  };
  const fetch = options.fetch ?? (async () => response(503, {}));
  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    console
  }, { filename: 'background.js' });
  if (!listener) throw new Error('background.js did not register a message listener');

  return {
    tabsCreate,
    send(message, tabId = 1) {
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(message, { tab: { id: tabId } }, resolve);
          if (keep !== true) reject(new Error('listener did not keep the response channel open'));
        } catch (err) {
          reject(err);
        }
      });
    }
  };
}

function journalOf(session: FakeStorageArea): any[] {
  const value = session.data.journal;
  return Array.isArray(value) ? value : [];
}

describe('extension observation journal', () => {
  it('releases a stale pending bootstrap even when the fresh tab never collected it', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea({
      bootstrap: {
        id: 'stale-command',
        text: 'bootstrap',
        agent: 'worker-1',
        leaseMs: 1_000,
        createdAt: Date.now() - 5_000
      },
      settled: []
    });
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      paths.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      if (url.pathname === '/commands/ack') return response(200, { ok: true });
      if (url.pathname === '/commands') return response(200, { commands: [] });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const result = await worker.send({ type: 'poll' });
    expect(result.ok).toBe(true);
    expect(session.data.bootstrap).toBeNull();
    expect(paths).toContain('/commands/ack');
    expect(paths).toContain('/commands');
  });

  it('does not permanently settle a worker command merely because its bootstrap message was sent', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      if (url.pathname === '/commands/ack') return response(200, { ok: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    await worker.send({ type: 'ack', id: 'worker-command', status: 'sent', agent: 'worker-1' });
    expect(session.data.settled ?? []).toEqual([]);

    await worker.send({ type: 'ack', id: 'resume-command', status: 'sent' });
    expect(session.data.settled).toEqual(['resume-command']);
  });

  it('keeps pre-conversation observations across page/service-worker reload and binds them when /c/<id> exists', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const first = loadWorker({ local, session });
    await first.send(
      {
        type: 'events',
        entries: [
          {
            conversationId: null,
            agent: null,
            event: { kind: 'user_message', time: Date.now(), text: 'opening requirement' }
          }
        ]
      },
      42
    );

    expect(journalOf(session)).toMatchObject([
      { conversationId: null, provisional: 'tab-42', event: { kind: 'user_message', text: 'opening requirement' } }
    ]);

    // Same Chrome tab after the page and service worker have both been recreated.
    const reloaded = loadWorker({ local, session });
    const bound = await reloaded.send(
      { type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      42
    );
    expect(bound).toMatchObject({ ok: true, bound: 1 });
    expect(journalOf(session)).toMatchObject([
      {
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        provisional: null,
        event: { kind: 'user_message', text: 'opening requirement' }
      }
    ]);
  });

  it('drains each conversation separately so navigation cannot file chat A observations into chat B', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const posted: Array<{ conversationId: string; events: Array<{ text?: string }> }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      if (url.pathname === '/events') {
        posted.push(JSON.parse(String(init.body)));
        return response(200, { sessionId: 'session', stored: 1 });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await worker.send({
      type: 'events',
      entries: [
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A1' } },
        { conversationId: b, event: { kind: 'progress', time: Date.now(), text: 'B1' } },
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A2' } }
      ]
    });

    expect(posted).toEqual([
      { conversationId: a, events: [{ kind: 'progress', time: expect.any(Number), text: 'A1' }, { kind: 'progress', time: expect.any(Number), text: 'A2' }] },
      { conversationId: b, events: [{ kind: 'progress', time: expect.any(Number), text: 'B1' }] }
    ]);
    expect(journalOf(session)).toEqual([]);
  });

  it('stays inside the count budget and leaves an explicit gap when progress has to be discarded', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `progress ${index}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(journal.length).toBeLessThanOrEqual(4000);
    expect(journal.some((entry) => entry.gap === true && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
  });

  it('stays inside the journal byte budget under large observations', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '99999999-8888-7777-6666-555555555555';
    const blob = 'x'.repeat(5000);
    const entries = Array.from({ length: 1200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${blob}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(Buffer.byteLength(JSON.stringify(journal), 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(journal.some((entry) => entry.gap === true)).toBe(true);
  });

  it('tightens and retries when Chrome rejects a session-storage write', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    // Below the journal's normal 4 MiB target but above its tightened 3 MiB target,
    // purely to force the "write rejected → compact harder → retry" path.
    session.maxBytes = 3_500_000;
    const worker = loadWorker({ local, session });
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const entries = Array.from({ length: 3200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${'y'.repeat(1500)}` }
    }));

    const reply = await worker.send({ type: 'events', entries });
    expect(reply.durable).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(session.data), 'utf8')).toBeLessThanOrEqual(3_500_000);
  });
});
