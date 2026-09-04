import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let source = '';

beforeAll(async () => {
  source = await fs.readFile(path.join(process.cwd(), 'extension', 'agent-tab-lifecycle.js'), 'utf8');
});

type Listener = (...args: any[]) => unknown;

function pick(state: Record<string, any>, keys: string | string[] | Record<string, any> | null | undefined) {
  if (keys == null) return { ...state };
  if (typeof keys === 'string') return { [keys]: state[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, state[key]]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, state[key] ?? fallback]));
}

function makeHarness(
  sessionState: Record<string, any> = {},
  browserTabs: Map<number, string> = new Map()
) {
  const runtimeListeners = new Set<Listener>();
  const storageListeners = new Set<Listener>();
  const removedListeners = new Set<Listener>();
  const removed: number[] = [];
  const created: Array<{ id: number; url: string }> = [];
  let nextTabId = 100;

  const chrome = {
    runtime: {
      onMessage: { addListener: (listener: Listener) => runtimeListeners.add(listener) },
      onInstalled: { addListener: (_listener: Listener) => undefined }
    },
    storage: {
      session: {
        async get(keys: any) {
          return pick(sessionState, keys);
        },
        async set(values: Record<string, any>) {
          Object.assign(sessionState, values);
        }
      },
      onChanged: { addListener: (listener: Listener) => storageListeners.add(listener) }
    },
    tabs: {
      async get(tabId: number) {
        const url = browserTabs.get(tabId);
        if (!url) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, url };
      },
      async remove(tabId: number) {
        removed.push(tabId);
        browserTabs.delete(tabId);
        for (const listener of removedListeners) listener(tabId, {});
      },
      async create(input: { url: string }) {
        const id = nextTabId++;
        browserTabs.set(id, input.url);
        const tab = { id, url: input.url };
        created.push(tab);
        return tab;
      },
      onRemoved: { addListener: (listener: Listener) => removedListeners.add(listener) },
      async query() {
        return [...browserTabs.entries()].map(([id, url]) => ({ id, url }));
      }
    },
    scripting: { async executeScript() {} }
  };

  const fastTimeout = (fn: (...args: any[]) => void) => {
    queueMicrotask(fn);
    return 0 as any;
  };
  const run = new Function('chrome', 'setTimeout', 'clearTimeout', source);
  run(chrome, fastTimeout, () => undefined);

  const settle = async (rounds = 50) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };

  return {
    sessionState,
    removed,
    created,
    browserTabs,
    async register(tabId: number, commandId: string) {
      const url = `https://chatgpt.com/?clf=${encodeURIComponent(commandId)}#clf=${encodeURIComponent(commandId)}`;
      browserTabs.set(tabId, url);
      const sender = { tab: { id: tabId, url }, url };
      for (const listener of runtimeListeners) await listener({ type: 'agent_tab_register', id: commandId }, sender, () => undefined);
      await settle();
    },
    async ack(commandId: string, agent = 'worker-1') {
      const change = { commandAckOutbox: { oldValue: [], newValue: [{ id: commandId, status: 'sent', agent }] } };
      for (const listener of storageListeners) await listener(change, 'local');
      await settle();
    },
    settle
  };
}

describe('agent tab hard budget', () => {
  it('keeps at most five system-owned agent leases and queues the sixth until capacity is released', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 6; i++) await h.register(i, `cmd-${i}`);

    expect(Object.keys(h.sessionState.agentTabLeases ?? {})).toHaveLength(5);
    expect(h.sessionState.agentTabLeaseQueue).toEqual([
      expect.objectContaining({ commandId: 'cmd-6' })
    ]);
    expect(h.removed).toContain(6);
    expect(h.created).toEqual([]);

    await h.ack('cmd-1', 'worker-1');

    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.url).toContain('clf=cmd-6');
    expect(h.sessionState.agentTabLeaseQueue ?? []).toEqual([]);
  });

  it('does not count or close unmarked user ChatGPT tabs against the five-tab budget', async () => {
    const h = makeHarness();
    h.browserTabs.set(90, 'https://chatgpt.com/c/user-owned-conversation');
    for (let i = 1; i <= 5; i++) await h.register(i, `cmd-${i}`);

    expect(Object.keys(h.sessionState.agentTabLeases ?? {})).toHaveLength(5);
    expect(h.browserTabs.has(90)).toBe(true);
    expect(h.removed).not.toContain(90);
  });

  it('releases the queue-drain lock after one drain so a later freed lease can drain again', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 7; i++) await h.register(i, `cmd-${i}`);

    expect((h.sessionState.agentTabLeaseQueue ?? []).map((entry: any) => entry.commandId)).toEqual(['cmd-6', 'cmd-7']);

    await h.ack('cmd-1', 'worker-1');
    expect(h.created.map((tab) => tab.url)).toEqual([expect.stringContaining('clf=cmd-6')]);
    expect((h.sessionState.agentTabLeaseQueue ?? []).map((entry: any) => entry.commandId)).toEqual(['cmd-7']);

    await h.ack('cmd-2', 'worker-2');
    expect(h.created.map((tab) => tab.url)).toEqual([
      expect.stringContaining('clf=cmd-6'),
      expect.stringContaining('clf=cmd-7')
    ]);
    expect(h.sessionState.agentTabLeaseQueue ?? []).toEqual([]);
    expect(Object.keys(h.sessionState.agentTabLeases ?? {})).toHaveLength(5);
  });

  it('reconciles stale persisted leases after service-worker restart before draining queued work', async () => {
    const sessionState: Record<string, any> = {
      agentTabLeases: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => {
          const tabId = index + 1;
          return [String(tabId), {
            commandId: `cmd-${tabId}`,
            tabId,
            registeredAt: 1,
            handoffDurable: false,
            leaseManagerCreated: true
          }];
        })
      ),
      agentTabLeaseQueue: [{
        commandId: 'cmd-6',
        url: 'https://chatgpt.com/?clf=cmd-6#clf=cmd-6',
        queuedAt: 2
      }]
    };
    const browserTabs = new Map<number, string>(
      Array.from({ length: 4 }, (_, index) => {
        const tabId = index + 1;
        return [tabId, `https://chatgpt.com/?clf=cmd-${tabId}#clf=cmd-${tabId}`];
      })
    );

    const restarted = makeHarness(sessionState, browserTabs);
    await restarted.settle();

    expect(sessionState.agentTabLeases?.['5']).toBeUndefined();
    expect(restarted.created).toHaveLength(1);
    expect(restarted.created[0]?.url).toContain('clf=cmd-6');
    expect(sessionState.agentTabLeaseQueue ?? []).toEqual([]);
    expect(Object.keys(sessionState.agentTabLeases ?? {})).toHaveLength(5);
    expect(restarted.removed).not.toContain(5);
  });
});
