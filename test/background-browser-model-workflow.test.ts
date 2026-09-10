import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const firstId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secondId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

type Tab = { id: number; url?: string; pendingUrl?: string; windowId?: number; active?: boolean };

async function worker(modelCatalogRequest?: { nonce: string; expiresAt: number; allowOpen?: boolean }) {
  const tabs: Tab[] = [];
  const event = { addListener: () => {} };
  const localSaved: Record<string, unknown> = { port: 8765, token: 'test-pairing' };
  const local = {
    get: async (keys?: string | string[]) => {
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, localSaved[key]]));
      return { ...localSaved };
    },
    set: vi.fn(async (value: object) => { Object.assign(localSaved, value); }),
    remove: async () => {}
  };
  const saved: Record<string, unknown> = {};
  const session = {
    get: async () => ({ ...saved }),
    set: async (value: object) => { Object.assign(saved, value); },
    remove: async (key: string) => { delete saved[key]; }
  };
  const create = vi.fn(async ({ url, active }: { url: string; active?: boolean }) => {
    const tab = { id: tabs.length + 1, pendingUrl: url, active };
    tabs.push(tab);
    return tab;
  });
  const remove = vi.fn(async (_id: number) => {});
  const sendMessage = vi.fn(async (_id: number, _message: unknown): Promise<{ ok: boolean; ready?: boolean }> => ({ ok: true, ready: true }));
  const update = vi.fn(async (id: number, patch: Partial<Tab>) => {
    const tab = tabs.find((entry) => entry.id === id)!;
    Object.assign(tab, patch);
    delete tab.pendingUrl;
    return tab;
  });
  const fetch = vi.fn(async (input: string, _init?: RequestInit): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => ({
    ok: true,
    status: 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs: [], background: true, modelCatalogRequest }
  }));
  const context = vm.createContext({
    chrome: {
      storage: { local, session, onChanged: event },
      windows: { onRemoved: event },
      runtime: { getManifest: () => ({ version: '2.1.4' }), onMessage: event, onInstalled: event, onStartup: event },
      tabs: {
        query: async () => [...tabs],
        get: async (id: number) => tabs.find((entry) => entry.id === id),
        remove,
        create,
        update,
        sendMessage,
        onCreated: event,
        onUpdated: event,
        onRemoved: event
      },
      alarms: { onAlarm: event, create: () => {}, clear: async () => true },
      scripting: { executeScript: async () => [], insertCSS: async () => {} }
    },
    fetch,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    TextEncoder,
    console
  });
  vm.runInContext(
    `${source}\nglobalThis.testBrowserModel = { load, maintain, authorizeDocument, inspectRequestedModels, catalog: HANDLERS.model_catalog, applyRequestedBrowserPreferences };`,
    context
  );
  const api = context.testBrowserModel as {
    load(): Promise<void>;
    maintain(): Promise<void>;
    authorizeDocument(sender: unknown, message: unknown): Promise<any>;
    inspectRequestedModels(request: unknown): Promise<void>;
    catalog(message: unknown, sender: unknown, source: unknown): Promise<any>;
    applyRequestedBrowserPreferences(request: object): Promise<void>;
  };
  await api.load();
  return { ...api, tabs, create, remove, sendMessage, fetch, local, localSaved, saved };
}

describe('browser model workflow', () => {
  it('acknowledges preferences once without replaying a write over a newer popup value', async () => {
    const h = await worker();
    const request = { nonce: firstId, expiresAt: Date.now() + 60_000, patch: { overwrite: false, durations: true } };
    await h.applyRequestedBrowserPreferences(request);
    expect(h.localSaved).toMatchObject({ renderStreamEnabled: false, showStreamTimes: true });

    h.localSaved.renderStreamEnabled = true;
    await h.applyRequestedBrowserPreferences(request);
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.localSaved.renderStreamEnabled).toBe(true);

    const receipts = h.fetch.mock.calls
      .filter(([url]) => new URL(url).pathname === '/browser/preferences')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(receipts).toEqual([
      expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } }),
      expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } })
    ]);

    await h.applyRequestedBrowserPreferences({ nonce: secondId, expiresAt: Date.now() + 60_000, patch: {} });
    expect(JSON.parse(String(h.fetch.mock.calls.at(-1)?.[1]?.body)).values).toEqual({ overwrite: true, durations: true });
  });

  it('accepts a model observation only from the exact elected browser document', async () => {
    const h = await worker();
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'catalog-document', frameId: 0, url: h.tabs[0]!.url };
    const owner = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    expect(owner.ok).toBe(true);
    const observation = { nonce: firstId, models: null };

    expect((await h.catalog(observation, sender, owner)).ok).toBe(false);
    h.sendMessage.mockImplementation(async (_id: number, request: any) => {
      if (request.type === 'clf-model-catalog-state') return { ok: true, ready: true };
      expect((await h.catalog(observation, sender, owner)).ok).toBe(true);
      return { ok: true };
    });
    await h.inspectRequestedModels({ nonce: firstId, expiresAt: Date.now() + 60_000, allowOpen: true });
    expect(h.remove).not.toHaveBeenCalled();

    h.tabs[0]!.url = 'https://chatgpt.com/c/another-chat';
    expect((await h.catalog(observation, sender, owner)).ok).toBe(false);
    h.tabs[0]!.url = `https://chatgpt.com/?cos-model-catalog=${firstId}`;
    await h.authorizeDocument({ ...sender, documentId: 'replacement-document' }, { navigationEpoch: 1 });
    expect((await h.catalog(observation, sender, owner)).ok).toBe(false);
  });

  it('opens at most one inactive catalog helper when Core explicitly allows opening', async () => {
    const request = { nonce: firstId, expiresAt: Date.now() + 120_000, allowOpen: true };
    const h = await worker(request);
    await h.maintain();
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.create).toHaveBeenCalledWith({
      url: `https://chatgpt.com/?cos-model-catalog=${firstId}`,
      active: false
    });
    await vi.waitFor(() => expect(h.saved.modelCatalogOwner).toEqual({ nonce: firstId, tab: 1 }));

    let finish!: () => void;
    h.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ ok: true, ready: true }); }));
    await h.maintain();
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalled());
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    finish();
  });
});
