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
    expect(BRIDGE_PROTOCOL).toBe(5);
    expect(backgroundSource).toContain('const BRIDGE_PROTOCOL = 5;');
  });

  /**
   * The Fiber helper is the one piece of this extension that runs in ChatGPT's own
   * JavaScript context, and it only does so because the manifest says `"world": "MAIN"`.
   * Lose that one word and the file still loads, still finds nothing — `__reactFiber$` is
   * invisible from an isolated world — and fails closed, so every collapsed row silently
   * goes back to standing for one call. That is a regression with no symptom, which is
   * why it is pinned here.
   */
  it('runs the fiber helper in the page context, and nothing else there', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { content_scripts: Array<{ js: string[]; world?: string }> };

    const main = manifest.content_scripts.filter((entry) => entry.world === 'MAIN');
    expect(main).toHaveLength(1);
    expect(main[0]!.js).toEqual(['fiber.js']);
    // The rest stays isolated: the page must not be able to reach the code that talks to
    // the service worker, holds the bridge token, or decides what gets recorded.
    for (const entry of manifest.content_scripts) {
      if (entry.world === 'MAIN') continue;
      expect(entry.js).not.toContain('fiber.js');
      expect(entry.world ?? 'ISOLATED').toBe('ISOLATED');
    }
  });

  /**
   * The helper's whole justification is that it reads props the page owns. What it may
   * hand back is an allowlist, and these are the two things that must never be in it: a
   * tool's arguments, which are the user's text, and the secrets observed inside them.
   */
  it('never sends tool arguments or secrets out of the page context', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'extension', 'fiber.js'), 'utf8');
    // Comments discuss the secrets by name; the code must never touch them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/agent_key|authorization|access_token/i);
    // The payload is never turned into an object at all. It used to be parsed for its
    // `path`, which meant the arguments — the user's text, and the secrets observed inside
    // them — existed as live values in this scope, one careless line from crossing over.
    // The path is read off the front of the string instead, so `args` is never walked.
    expect(code).not.toMatch(/JSON\.parse/);
    expect(code).not.toMatch(/\bargs\b/);
    // Nor may a whole object be serialised across, which would defeat the allowlist.
    expect(code).not.toMatch(/JSON\.stringify/);
  });

  /**
   * The installed popup showed "Paired · port 8765" with a green dot and, underneath it,
   * a six-digit code field and a Pair button — a page contradicting itself about the one
   * thing it exists to report. There is nothing to type any more, so the way to keep that
   * from coming back is for the markup to have no field to type into.
   */
  it('has no pairing-code UI anywhere in the popup', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/000000|six[- ]digit|pairing code/i);
    expect(html).not.toMatch(/type=["'](?:text|number|password)["']/i);
    expect(js).not.toMatch(/\bcode\b/);
    // The message the worker understands carries no code either.
    expect(js).not.toMatch(/type: 'pair'[^}]*code/);
  });

  it('ships Overwrite on by default and exposes one persistent toggle that refreshes immediately', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [content, html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'content.js'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(content).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(content).toContain("const SHOW_TIMES_KEY = 'showStreamTimes';");
    expect(content).toContain('let RENDER_STREAM = TEST_MODE ? false : true;');
    expect(html).toContain('id="overwriteToggle"');
    expect(html).toContain('id="timeToggle"');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('id="overwriteBtn"');
    expect(js).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(js).toContain("const SHOW_TIMES_KEY = 'showStreamTimes';");
    expect(js).toContain('chrome.storage.local.set');
    expect(js).toContain("type: 'overwriteNow'");
    expect(backgroundSource).toContain('async overwriteNow()');
    expect(backgroundSource).toContain("chrome.tabs.sendMessage(id, { type: 'clf-overwrite-now' })");
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

  removeAttribute(name: string): void {
    this.attrs.delete(name);
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

  /** Flat fakes: a node only ever contains itself, which is all toolBlocks() asks. */
  contains(other: FakeNode): boolean {
    return other === this;
  }
}

/** A tool block as the live page renders it: a short header line and nothing else. */
function toolBlock(label = 'Called tool'): FakeNode {
  return new FakeNode({ class: 'pointer-events-none contents' }, label);
}

interface DomApi {
  turns(): Array<{ node: FakeNode; nodes: FakeNode[]; id: string | null; role: string | null }>;
  messages(): Array<{ id: string; role: string; text: string; turnId: string | null }>;
  progressLine(turn: unknown): string | null;
  interrupted(turn: unknown): boolean;
  markProgress(turn: unknown): number;
  hideProgress(turn: unknown, hidden: boolean): void;
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
    const a1 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock()]);
    const a2 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock(), toolBlock()]);
    const dom = loadDom([user, a1, a2]);

    const turns = dom.turns();
    expect(turns).toHaveLength(2);
    const assistant = turns[1]!;
    expect(assistant.id).toBe('request-1');
    expect(assistant.nodes).toEqual([a1, a2]);
    expect(dom.toolBlocks(assistant)).toHaveLength(5);
  });

  /**
   * `div.pointer-events-none.contents` is a layout shape ChatGPT also uses for containers
   * that hold a whole answer. Counting one of those as a tool block inflates the block
   * count of the turn, which is exactly what the relabelling has to match against.
   */
  it('refuses a display-contents container that holds prose rather than a tool label', () => {
    const prose = toolBlock('a very long assistant answer').with('.markdown', [new FakeNode({}, 'answer')]);
    const real = toolBlock();
    const assistant = turn('assistant', 'request-3').with(TOOL_SELECTOR, [prose, real]);
    const dom = loadDom([assistant]);

    expect(dom.toolBlocks(dom.turns()[0]!)).toEqual([real]);
  });

  it('does not mistake ChatGPT transport-failure markdown for a completed assistant answer', () => {
    const failure = new FakeNode({}, 'Message delivery timed out. Please try again. Retry');
    const assistant = turn('assistant', 'request-failed')
      .with('[data-message-id]', [])
      .with('.markdown', [failure])
      .with('[data-interrupted="true"]', []);
    const dom = loadDom([assistant]);

    expect(dom.messages()).toEqual([]);
    // An occurrence, not a bare string: the node is what tells one showing of this banner
    // apart from the next, and the turn is what scopes it.
    expect(dom.errors()).toMatchObject([
      { text: 'Message delivery timed out. Please try again. Retry', node: failure, turnId: 'request-failed' }
    ]);
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
    // toMatchObject rather than toEqual: each message also carries the section it was read
    // from, which is what lets the content script tell a message left behind by a chat it
    // has navigated away from apart from one belonging to the chat it is on now.
    expect(messages).toMatchObject([
      { id: 'user-message-1', role: 'user', text: 'do the thing', turnId: 'user-1', interrupted: false, node: user },
      {
        id: 'assistant:request-2',
        role: 'assistant',
        text: 'Second paragraph',
        turnId: 'request-2',
        interrupted: false,
        node: assistant
      }
    ]);
    expect(messages).toHaveLength(2);
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

  it('never hides a progress container that ChatGPT has put the answer inside', () => {
    // ChatGPT reparents the finished prose into a data-interrupted box on some turns.
    // Hiding by the attribute alone therefore hid the answer as well, which is what left
    // completed turns showing "Worked for 45s" over an empty gap with no way to get the
    // text back. Commentary is replaceable; the answer is not.
    const commentary = new FakeNode({ 'data-interrupted': 'false' }, 'Reading files');
    const answer = new FakeNode({ 'data-interrupted': 'false' }, 'Here is the summary');
    answer.with('.markdown', [new FakeNode({ class: 'markdown' }, 'Here is the summary')]);
    const section = turn('assistant', 'request-answer').with('[data-interrupted]', [commentary, answer]);
    const dom = loadDom([section]);
    const logical = dom.turns()[0]!;

    dom.hideProgress(logical, true);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBe('1');
    expect(answer.getAttribute('data-clf-native-hidden')).toBeNull();

    dom.hideProgress(logical, false);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('reads every progress container of the turn, in order, rather than only the last', () => {
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

    // Taking only the newest box made this value shrink whenever ChatGPT grew a new one,
    // and a shrink reads as new text to the delta logic, which printed it all over again.
    expect(dom.progressLine(logical)).toBe('Thinking\nReading files\nRunning tool\nRunning tests');
    expect(dom.interrupted(logical)).toBe(true);
  });
});

// --------------------------------------------------------------- service worker

class FakeStorageArea {
  data: Record<string, unknown>;
  /** Optional quota used to make writes fail the way Chrome does. */
  maxBytes: number | null = null;
  /**
   * Optional read latency, in milliseconds.
   *
   * Chrome answers a read from another process, so a read is not instant and two readers
   * do not advance in lockstep. The snapshot is still taken when the read is *issued* —
   * that is the whole point of modelling it: a read issued before someone else's write
   * can be answered after it, and then it carries stale data into live state.
   */
  lagMs = 0;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys: string[] | string): Promise<Record<string, unknown>> {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const snapshot = Object.fromEntries(
      wanted.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])])
    );
    if (this.lagMs > 0) await new Promise((resolve) => setTimeout(resolve, this.lagMs));
    return snapshot;
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
  /** Fires Chrome's real tab-close lifecycle event. */
  closeTab(tabId: number): Promise<void>;
  /** Fires the extension install/update lifecycle event. */
  installed(reason?: string): Promise<void>;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
  scriptingExecuteScript: ReturnType<typeof vi.fn>;
  scriptingInsertCSS: ReturnType<typeof vi.fn>;
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
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const installedListeners: Array<(details: { reason: string }) => void> = [];
  const tabsCreate = vi.fn(async () => ({ id: 99 }));
  const tabsQuery = vi.fn(async () => [] as Array<{ id?: number }>);
  const tabsUpdate = vi.fn(async (id: number) => ({ id, windowId: 7 }));
  const tabsSendMessage = vi.fn(async () => ({ ok: true }));
  const scriptingExecuteScript = vi.fn(async () => []);
  const scriptingInsertCSS = vi.fn(async () => undefined);
  const windowsUpdate = vi.fn(async () => ({ id: 7 }));
  const event = () => ({ addListener: () => undefined });
  const chrome = {
    storage: { local: options.local, session: options.session },
    runtime: {
      getManifest: () => ({ version: '1.6.0' }),
      onMessage: {
        addListener(fn: typeof listener) {
          listener = fn;
        }
      },
      onInstalled: {
        addListener(fn: (details: { reason: string }) => void) {
          installedListeners.push(fn);
        }
      },
      onStartup: event()
    },
    windows: { update: windowsUpdate },
    scripting: {
      executeScript: scriptingExecuteScript,
      insertCSS: scriptingInsertCSS
    },
    tabs: {
      create: tabsCreate,
      query: tabsQuery,
      update: tabsUpdate,
      sendMessage: tabsSendMessage,
      onRemoved: {
        addListener(fn: (tabId: number) => void) {
          tabRemovedListeners.push(fn);
        }
      }
    }
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
    tabsQuery,
    tabsUpdate,
    tabsSendMessage,
    scriptingExecuteScript,
    scriptingInsertCSS,
    async installed(reason = 'update') {
      for (const fn of installedListeners) fn({ reason });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async closeTab(tabId: number) {
      for (const fn of tabRemovedListeners) fn(tabId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
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

// ------------------------------------------------------------ command delivery

/**
 * The half of delivery that lives in the browser.
 *
 * The app opens the marked chat itself, so what is tested here is what the extension
 * does with a marker once a page has it, and the recovery path for commands the app
 * could not open — which is the only thing that runs while no ChatGPT page exists.
 */
describe('extension command delivery', () => {
  const paired = { port: 8765, token: 'paired-token' };

  it('redeems only the command id the page was opened for', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      if (url.pathname === '/commands/redeem') {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.id !== 'cmd-1') return response(404, { error: 'gone' });
        return response(200, { command: { id: 'cmd-1', kind: 'open-chat', text: 'do the thing', agent: null } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const mine = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(mine).toMatchObject({ ok: true, command: { id: 'cmd-1', text: 'do the thing' } });

    // A marker for a command that has been cancelled, superseded or already sent gets
    // nothing, so a stale URL in history types nothing into a chat.
    const stale = await worker.send({ type: 'redeem', id: 'cmd-gone', client: 'page-1' });
    expect(stale).toMatchObject({ ok: true, command: null, gone: true });
    // The page identifies itself, because a command belongs to one page: a second tab on
    // the same marker is a different claimant and the app refuses it.
    expect(bodies).toEqual([
      { id: 'cmd-1', client: 'page-1' },
      { id: 'cmd-gone', client: 'page-1' }
    ]);
  });

  it('never redeems a command this browser already delivered', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea({ settled: ['cmd-done'] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      return response(200, { command: { id: 'cmd-done', text: 'again?' } });
    });
    const worker = loadWorker({ local, session, fetch });

    expect(await worker.send({ type: 'redeem', id: 'cmd-done' })).toMatchObject({ ok: true, command: null });
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/commands/redeem'))).toBe(false);
  });

  /**
   * The extension does not go looking for work, and cannot open a chat of its own accord.
   *
   * This replaces the whole recovery-alarm path. A command used to be a thing the browser
   * fetched: a half-minute `chrome.alarms` tick pulled `GET /commands`, opened a marked tab
   * per unopened command, and persisted an `opened` list so a restarted service worker would
   * not open a second chat for the same job. Every part of that could act on a run the app
   * had already finished with, and every part of it was a clock. The app opens the chat now,
   * in the same transaction that creates the command, so the extension has nothing to poll
   * and nothing to remember. `chrome.alarms` is not even in the manifest — and it is absent
   * from the fake Chrome here, so reaching for it would throw rather than quietly pass.
   */
  it('opens no tabs and holds no alarm of its own', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // Starting up is not a reason to open anything, and neither is asking how things are.
    await worker.send({ type: 'status' });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(session.data.opened).toBeUndefined();

    // There is no listing route left to ask, so nothing here ever asks for one.
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
    expect(backgroundSource).not.toContain('chrome.alarms');
  });

  it('re-injects the recorder into already-open ChatGPT tabs after an extension reload', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }, { id: 42 }]);

    await worker.installed('update');

    expect(worker.tabsQuery).toHaveBeenCalledWith({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['chatgpt-dom.js'] }],
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 41 }, files: ['content.js'] }],
      [{ target: { tabId: 42 }, files: ['chatgpt-dom.js'] }],
      [{ target: { tabId: 42 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 42 }, files: ['content.js'] }]
    ]);
    expect(worker.scriptingInsertCSS.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['overlay.css'] }],
      [{ target: { tabId: 42 }, files: ['overlay.css'] }]
    ]);
  });

  it('leaves an already-live v8 recorder alone instead of stacking another content script', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }]);
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, recorderVersion: 8 });

    await worker.installed('update');

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(41, { type: 'clf-recorder-ping' });
    expect(worker.scriptingExecuteScript).not.toHaveBeenCalled();
    expect(worker.scriptingInsertCSS).not.toHaveBeenCalled();
  });

  it('has no way to ask the app for work at all', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // The old poll message, from a stale content script that was never reloaded. It is not
    // a route any more, so it is answered as the unknown message it is rather than
    // reopening a path the app has stopped serving.
    const reply = await worker.send({ type: 'poll' });
    expect(reply?.ok).not.toBe(true);
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
  });

  it('provisions itself silently on the first call and retries with the new token', async () => {
    const local = new FakeStorageArea({ port: 8765 });
    const session = new FakeStorageArea();
    const seen: Array<{ path: string; auth: unknown }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({ path: url.pathname, auth: headers.authorization });
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: false });
      if (url.pathname === '/pair') return response(200, { token: 'fresh-token' });
      if (url.pathname === '/commands/redeem') return response(200, { command: null });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const status = await worker.send({ type: 'status' });
    expect(status).toMatchObject({ connected: true, paired: true });
    expect(seen.some((call) => call.path === '/pair')).toBe(true);
    expect(local.data.token).toBe('fresh-token');

    await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(seen.find((call) => call.path === '/commands/redeem')?.auth).toBe('Bearer fresh-token');
    // Nothing anywhere asked for a code.
    expect(fetch.mock.calls.some(([, init]) => String((init as any)?.body ?? '').includes('code'))).toBe(false);
  });

  it('re-provisions once when the app no longer recognises the stored token', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'stale-token' });
    const session = new FakeStorageArea();
    const tokens: Array<unknown> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      if (url.pathname === '/pair') return response(200, { token: 'second-token' });
      if (url.pathname === '/commands/redeem') {
        tokens.push(headers.authorization);
        return headers.authorization === 'Bearer second-token'
          ? response(200, { command: null })
          : response(401, { error: 'unauthorised' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const result = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(result.ok).toBe(true);
    expect(tokens).toEqual(['Bearer stale-token', 'Bearer second-token']);
    expect(local.data.token).toBe('second-token');
  });
});

describe('extension observation journal', () => {
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

  it('does not lose an observation when two tabs wake a cold service worker at once', async () => {
    // Chrome shuts the worker down after seconds of idling, so two tabs reporting at the
    // same moment after that is ordinary, not exotic. Both handlers used to walk the cold
    // load path concurrently, and the second one assigned the journal it had read — before
    // the first one's write — straight over the global, discarding an entry the first tab
    // had already been told was durable.
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    local.lagMs = 40;
    session.lagMs = 40;
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    // Tab one starts the cold load. Tab two arrives while that load is still in flight, so
    // its own reads are issued before tab one's journal write and answered after it.
    const first = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 1, text: 'from tab one' } }] },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 2, text: 'from tab two' } }] },
      2
    );
    const answers = await Promise.all([first, second]);

    for (const answer of answers) expect(answer).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map((entry) => entry.event.text)).toEqual(['from tab one', 'from tab two']);
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

  it('closes a conversation only when its final browser tab is actually gone', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chatgpt-local-files', paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    for (const tabId of [10, 11]) {
      await worker.send(
        {
          type: 'events',
          conversationId,
          entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text: `tab ${tabId}` } }]
        },
        tabId
      );
    }

    await worker.closeTab(10);
    expect(closed).toEqual([]);
    await worker.closeTab(11);
    expect(closed).toEqual([conversationId]);
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

// ---------------------------------------------------------------- connecting

/**
 * How this browser gets, keeps and gives up a credential.
 *
 * All three of these were the same shape of bug: a decision taken once being quietly
 * retaken a couple of seconds later by a poll that runs in every open tab.
 */
describe('extension connection', () => {
  /** Records every request the worker makes, and answers them the way the app would. */
  function app(): {
    calls: string[];
    fetch: (input: string, init?: Record<string, unknown>) => Promise<any>;
    tokens: number;
  } {
    const state = {
      calls: [] as string[],
      tokens: 0,
      async fetch(input: string) {
        state.calls.push(input);
        if (input.endsWith('/hello')) return response(200, { app: 'chatgpt-local-files', paired: true });
        if (input.endsWith('/pair')) {
          state.tokens++;
          return response(200, { token: `token-${state.tokens}` });
        }
        return response(200, {});
      }
    };
    return state;
  }

  /**
   * `/pair` mints a fresh credential and invalidates the one before it, so two callers
   * arriving together do not get two tokens — they get one working token and one that
   * has already been revoked, and then each 401 provisions again.
   */
  it('mints one token however many callers ask at once', async () => {
    const server = app();
    const worker = loadWorker({ local: new FakeStorageArea(), session: new FakeStorageArea(), fetch: server.fetch });

    await Promise.all([
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' })
    ]);
    expect(server.tokens).toBe(1);
  });

  /**
   * A `/hello` in front of every authenticated request doubled the traffic of a poll that
   * already runs every two seconds in every open tab, against a 900/min budget.
   */
  it('does not re-ask where the app is before every single request', async () => {
    const server = app();
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    for (let n = 0; n < 5; n++) {
      await worker.send({ type: 'activity', conversationId: 'abababab-cdcd-efef-1212-343434343434', since: 0 });
    }
    const hellos = server.calls.filter((url) => url.endsWith('/hello'));
    expect(hellos.length).toBeLessThanOrEqual(1);
    expect(server.calls.filter((url) => url.includes('/activity'))).toHaveLength(5);
  });

  it('stays disconnected once it has been disconnected', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    await worker.send({ type: 'status' });
    expect(server.tokens).toBe(1);

    await worker.send({ type: 'unpair' });
    expect(local.data.disconnected).toBe(true);

    // The two things that used to undo it: the next poll from a tab, and opening the
    // popup to check. Neither is a request to connect.
    const activity = await worker.send({
      type: 'activity',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      since: 0
    });
    expect(activity.ok).toBe(false);
    expect(activity.error).toBe('disconnected');
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(false);
    expect(status.disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  /** Persisted in `local`, not `session`: a choice a restart undoes is not a choice. */
  it('is still disconnected after the worker has been shut down and restarted', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const first = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    await first.send({ type: 'status' });
    await first.send({ type: 'unpair' });

    const second = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    expect((await second.send({ type: 'status' })).disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  it('connects again when the user asks it to, and only then', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    await worker.send({ type: 'status' });
    await worker.send({ type: 'unpair' });

    expect(await worker.send({ type: 'pair' })).toMatchObject({ ok: true });
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(true);
    expect(status.disconnected).toBe(false);
    expect(local.data.disconnected).toBe(false);
  });

  it('forces an immediate overwrite in known and newly discovered ChatGPT tabs', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: app().fetch });
    await worker.send({ type: 'bind', conversationId: '11111111-2222-3333-4444-555555555555' }, 11);
    await worker.send({ type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 12);
    worker.tabsQuery.mockResolvedValueOnce([{ id: 12 }, { id: 13 }]);

    const result = await worker.send({ type: 'overwriteNow' });

    expect(result).toMatchObject({ ok: true, tabs: 3, attempted: 3 });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(3);
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(11, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(12, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(13, { type: 'clf-overwrite-now' });
  });
});
