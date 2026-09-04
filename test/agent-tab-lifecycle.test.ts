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
  removeFailures = 0,
  browserTabs: Map<number, string> = new Map()
) {
  const runtimeListeners = new Set<Listener>();
  const storageListeners = new Set<Listener>();
  const removedListeners = new Set<Listener>();
  const removed: number[] = [];
  const created: Array<Record<string, any>> = [];
  const executed: Array<{ tabId: number; files: string[] }> = [];
  let failuresLeft = removeFailures;

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
      async create(options: Record<string, any>) {
        created.push({ ...options });
        const id = 100 + created.length;
        browserTabs.set(id, String(options.url ?? ''));
        return { id, url: options.url };
      },
      async get(tabId: number) {
        const url = browserTabs.get(tabId);
        if (!url) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, url };
      },
      async remove(tabId: number) {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error('transient close failure');
        }
        removed.push(tabId);
        browserTabs.delete(tabId);
      },
      onRemoved: { addListener: (listener: Listener) => removedListeners.add(listener) },
      async query() {
        return [...browserTabs.entries()].map(([id, url]) => ({ id, url }));
      }
    },
    scripting: {
      async executeScript(input: { target: { tabId: number }; files: string[] }) {
        executed.push({ tabId: input.target.tabId, files: input.files });
      }
    }
  };

  const fastTimeout = (fn: (...args: any[]) => void) => {
    queueMicrotask(fn);
    return 0 as any;
  };
  const run = new Function('chrome', 'setTimeout', 'clearTimeout', source);
  run(chrome, fastTimeout, () => undefined);

  const settle = async (rounds = 30) => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  };

  return {
    sessionState,
    removed,
    created,
    executed,
    async message(message: Record<string, any>, sender: Record<string, any>) {
      const tabId = sender?.tab?.id;
      const url = sender?.tab?.url;
      if (Number.isInteger(tabId) && typeof url === 'string') browserTabs.set(tabId, url);
      for (const listener of runtimeListeners) await listener(message, sender, () => undefined);
      await settle();
    },
    async storageChange(newValue: unknown) {
      const change = { commandAckOutbox: { oldValue: [], newValue } };
      for (const listener of storageListeners) await listener(change, 'local');
      await settle();
    },
    navigate(tabId: number, url: string) {
      browserTabs.set(tabId, url);
    },
    async tabRemoved(tabId: number) {
      browserTabs.delete(tabId);
      for (const listener of removedListeners) await listener(tabId, {});
      await settle();
    },
    settle
  };
}

const marked = (id: string) => ({ tab: { id: 17, url: `https://chatgpt.com/?clf=${encodeURIComponent(id)}#clf=${encodeURIComponent(id)}` } });

describe('ephemeral agent tab lifecycle', () => {
  it('opens a queued agent tab in the background when capacity becomes available', async () => {
    const h = makeHarness();
    for (let index = 0; index < 5; index++) {
      const id = `cmd-worker-${index + 1}`;
      await h.message(
        { type: 'agent_tab_register', id },
        { tab: { id: 20 + index, url: `https://chatgpt.com/?clf=${id}#clf=${id}` } }
      );
    }
    const queuedId = 'cmd-worker-6';
    await h.message(
      { type: 'agent_tab_register', id: queuedId },
      { tab: { id: 30, url: `https://chatgpt.com/?clf=${queuedId}#clf=${queuedId}` } }
    );
    expect(h.removed).toContain(30);
    expect(h.created).toEqual([]);

    await h.tabRemoved(20);

    expect(h.created).toEqual([
      { url: `https://chatgpt.com/?clf=${queuedId}#clf=${queuedId}`, active: false }
    ]);
  });

  it('keeps a marker-owned worker tab open after bootstrap ACK and closes only after broker lifecycle says releasable', async () => {
    const h = makeHarness();
    await h.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases?.['17']).toMatchObject({
      commandId: 'cmd-worker-1',
      tabId: 17,
      bootstrapSent: false,
      releasable: false
    });

    await h.storageChange([
      {
        id: 'cmd-worker-1',
        status: 'sent',
        agent: 'worker-1',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      }
    ]);

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases?.['17']).toMatchObject({
      commandId: 'cmd-worker-1',
      bootstrapSent: true,
      releasable: false
    });

    h.navigate(17, 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    await h.message(
      { type: 'agent_tab_releasable' },
      { tab: { id: 17, url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }
    );

    expect(h.removed).toEqual([17]);
    expect(h.sessionState.agentTabLeases?.['17']).toBeUndefined();
  });

  it('remembers bootstrap ACK when it wins the registration race but still waits for releasable evidence', async () => {
    const h = makeHarness();

    await h.storageChange([
      {
        id: 'cmd-worker-1',
        status: 'sent',
        agent: 'worker-1',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      }
    ]);
    await h.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases?.['17']).toMatchObject({ bootstrapSent: true, releasable: false });

    await h.message({ type: 'agent_tab_releasable' }, marked('cmd-worker-1'));

    expect(h.removed).toEqual([17]);
    expect(h.sessionState.agentTabLeases?.['17']).toBeUndefined();
  });

  it('never registers or closes an unmarked or marker-mismatched ChatGPT tab', async () => {
    const h = makeHarness();
    await h.message(
      { type: 'agent_tab_register', id: 'cmd-worker-1' },
      { tab: { id: 17, url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }
    );
    await h.message({ type: 'agent_tab_register', id: 'other' }, marked('cmd-worker-1'));
    await h.storageChange([
      {
        id: 'cmd-worker-1',
        status: 'sent',
        agent: 'worker-1',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      }
    ]);

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases ?? {}).toEqual({});
  });

  it('closes a releasable registered tab that stayed on ChatGPT, but releases ownership if it navigated away', async () => {
    const h = makeHarness();
    await h.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));
    h.navigate(17, 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    await h.storageChange([
      {
        id: 'cmd-worker-1',
        status: 'sent',
        agent: 'worker-1',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      }
    ]);
    expect(h.removed).toEqual([]);
    await h.message(
      { type: 'agent_tab_releasable' },
      { tab: { id: 17, url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }
    );

    expect(h.removed).toEqual([17]);
    expect(h.sessionState.agentTabLeases?.['17']).toBeUndefined();

    const h2 = makeHarness();
    await h2.message({ type: 'agent_tab_register', id: 'cmd-worker-2' }, { tab: { id: 18, url: 'https://chatgpt.com/?clf=cmd-worker-2' } });
    h2.navigate(18, 'https://example.com/other');

    await h2.storageChange([
      {
        id: 'cmd-worker-2',
        status: 'sent',
        agent: 'worker-2',
        conversationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
      }
    ]);
    await h2.message({ type: 'agent_tab_releasable' }, { tab: { id: 18, url: 'https://example.com/other' } });

    expect(h2.removed).toEqual([]);
    expect(h2.sessionState.agentTabLeases?.['18']).toBeUndefined();
  });

  it('does not close on a failed ACK or on a Prime/resume ACK with no agent id', async () => {
    const h = makeHarness();
    await h.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));

    await h.storageChange([{ id: 'cmd-worker-1', status: 'failed', agent: 'worker-1' }]);
    await h.storageChange([{ id: 'cmd-worker-1', status: 'sent', agent: null }]);

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases?.['17']?.bootstrapSent).toBe(false);
    expect(h.sessionState.agentTabLeases?.['17']?.releasable).toBe(false);
  });

  it('keeps a releasable lease after bounded close failures and recovers it on service-worker restart', async () => {
    const sessionState: Record<string, any> = {};
    const browserTabs = new Map<number, string>();
    const first = makeHarness(sessionState, 3, browserTabs);
    await first.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));
    await first.storageChange([
      {
        id: 'cmd-worker-1',
        status: 'sent',
        agent: 'worker-1',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      }
    ]);
    await first.message({ type: 'agent_tab_releasable' }, marked('cmd-worker-1'));

    expect(first.removed).toEqual([]);
    expect(sessionState.agentTabLeases?.['17']).toMatchObject({
      commandId: 'cmd-worker-1',
      bootstrapSent: true,
      releasable: true
    });

    const restarted = makeHarness(sessionState, 0, browserTabs);
    await restarted.settle();

    expect(restarted.removed).toEqual([17]);
    expect(sessionState.agentTabLeases?.['17']).toBeUndefined();
  });
});
