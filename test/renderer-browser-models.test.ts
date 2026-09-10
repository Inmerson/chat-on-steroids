import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

it('keeps browser choice and browser-owned preferences as explicit bounded controls', async () => {
  dom = new JSDOM(await readFile('src/renderer/index.html', 'utf8'));
  const doc = dom.window.document;
  const browser = doc.getElementById('chatBrowser') as HTMLSelectElement | null;
  expect(browser).not.toBeNull();
  expect([...browser!.options].map(option => option.value)).toEqual(['chrome', 'edge', 'brave']);
  expect(doc.getElementById('browserOverwrite')).not.toBeNull();
  expect(doc.getElementById('browserDurations')).not.toBeNull();
  expect(doc.getElementById('browserPreferencesRefresh')).not.toBeNull();
  const main = await readFile('src/renderer/main-app.ts', 'utf8');
  expect(main).toContain("chatBrowser: $<HTMLSelectElement>('chatBrowser').value");
});

it('displays only the latest model-catalog generation and discards a stale startup read', async () => {
  dom = new JSDOM('<button id="refreshChatModels"></button><p id="chatModelStatus"></p><div id="chatModelList"></div>');
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  let push!: (value: any) => void;
  let resolveStartup!: (value: any) => void;
  const getChatModels = vi.fn(() => new Promise(resolve => { resolveStartup = resolve; }));
  Object.assign(dom.window, { api: {
    getChatModels,
    requestChatModels: vi.fn(async () => ({ ok: true, data: { state: 'pending', requestedAt: 3, observedAt: null, models: [] } })),
    onChatModelsChanged: (listener: (value: any) => void) => { push = listener; return () => {}; }
  } });
  const { initChatModels } = await import('../src/renderer/chat-models.js');
  initChatModels();
  push({ state: 'ready', requestedAt: 2, observedAt: 20, models: [{ id: 'new', label: 'Newest', efforts: ['high'] }] });
  resolveStartup({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: 10, models: [{ id: 'old', label: 'Old', efforts: ['low'] }] } });
  await Promise.resolve(); await Promise.resolve();
  expect(dom.window.document.getElementById('chatModelList')!.textContent).toContain('Newest');
  expect(dom.window.document.getElementById('chatModelList')!.textContent).not.toContain('Old');
});
