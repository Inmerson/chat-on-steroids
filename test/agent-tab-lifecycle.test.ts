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

function makeHarness(sessionState: Record<string, any> = {}, removeFailures = 0) {
  const runtimeListeners = new Set<Listener>();
  const storageListeners = new Set<Listener>();
  const removedListeners = new Set<Listener>();
  const removed: number[] = [];
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
      async remove(tabId: number) {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error('transient close failure');
        }
        removed.push(tabId);
      },
      onRemoved: { addListener: (listener: Listener) => removedListeners.add(listener) },
      async query() {
        return [];
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
    executed,
    async message(message: Record<string, any>, sender: Record<string, any>) {
      for (const listener of runtimeListeners) await listener(message, sender, () => undefined);
      await settle();
    },
    async storageChange(newValue: unknown) {
      const change = { commandAckOutbox: { oldValue: [], newValue } };
      for (const listener of storageListeners) await listener(change, 'local');
      await settle();
    },
    async tabRemoved(tabId: number) {
      for (const listener of removedListeners) await listener(tabId, {});
      await settle();
    },
    settle
  };
}

const marked = (id: string) => ({ tab: { id: 17, url: `https://chatgpt.com/?clf=${encodeURIComponent(id)}#clf=${encodeURIComponent(id)}` } });

describe('ephemeral agent tab lifecycle', () => {
  it('closes a marker-owned worker tab only after its sent ACK is durable', async () => {
    const h = makeHarness();
    await h.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases?.['17']).toMatchObject({
      commandId: 'cmd-worker-1',
      tabId: 17,
      handoffDurable: false
    });

    await h.storageChange([{ id: 'cmd-worker-1', status: 'sent', agent: 'worker-1' }]);

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
    await h.storageChange([{ id: 'cmd-worker-1', status: 'sent', agent: 'worker-1' }]);

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases ?? {}).toEqual({});
  });

  it('does not close on a failed ACK or on a Prime/resume ACK with no agent id', async () => {
    const h = makeHarness();
    await h.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));

    await h.storageChange([{ id: 'cmd-worker-1', status: 'failed', agent: 'worker-1' }]);
    await h.storageChange([{ id: 'cmd-worker-1', status: 'sent', agent: null }]);

    expect(h.removed).toEqual([]);
    expect(h.sessionState.agentTabLeases?.['17']?.handoffDurable).toBe(false);
  });

  it('keeps a durable lease after bounded close failures and recovers it on service-worker restart', async () => {
    const sessionState: Record<string, any> = {};
    const first = makeHarness(sessionState, 3);
    await first.message({ type: 'agent_tab_register', id: 'cmd-worker-1' }, marked('cmd-worker-1'));
    await first.storageChange([{ id: 'cmd-worker-1', status: 'sent', agent: 'worker-1' }]);

    expect(first.removed).toEqual([]);
    expect(sessionState.agentTabLeases?.['17']).toMatchObject({
      commandId: 'cmd-worker-1',
      handoffDurable: true
    });

    const restarted = makeHarness(sessionState);
    await restarted.settle();

    expect(restarted.removed).toEqual([17]);
    expect(sessionState.agentTabLeases?.['17']).toBeUndefined();
  });
});
