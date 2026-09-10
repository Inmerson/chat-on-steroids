import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const ipc = readFileSync(new URL('../src/main/ipc-ui.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');

it('proxies browser preferences and model discovery through fixed renderer IPC methods', () => {
  expect(ipc).toContain("handle('chatModels:get'");
  expect(ipc).toContain("handle('chatModels:request'");
  expect(ipc).toContain("handle('browser:preferences'");
  expect(ipc).toContain("callCoreUi<ChatModelCatalog>('chat-models-get'");
  expect(ipc).toContain("callCoreUi<ChatModelCatalog>('chat-models-request'");
  expect(preload).toContain("getChatModels: () => call<ChatModelCatalog>('chatModels:get')");
  expect(preload).toContain("requestChatModels: () => call<ChatModelCatalog>('chatModels:request')");
  expect(preload).toContain("browserPreferences: (patch: Partial<BrowserPreferences> = {})");
  expect(preload).toContain("onChatModelsChanged:");
  expect(preload).not.toContain("from './browser.js'");
});
