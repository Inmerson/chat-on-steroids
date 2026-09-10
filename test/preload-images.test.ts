import { expect, it, vi } from 'vitest';

const { invoke, expose, getPath } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true, data: [] })), expose: vi.fn(), getPath: vi.fn((file: any) => file.path ?? '')
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: { getPathForFile: getPath }
}));

it('transports pathless clipboard bytes and disk paths through one bounded image import', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const bytes = new Uint8Array([1, 2, 3]);
  const arrayBuffer = vi.fn(async () => bytes.buffer);
  await api.dropFiles([{ name: 'clipboard.png', size: 3, arrayBuffer }, { name: 'disk.png', size: 3, path: '/disk.png' }]);
  expect(invoke).toHaveBeenCalledWith('sessions:dropFiles', { files: [{ name: 'clipboard.png', bytes }, '/disk.png'] });
  expect(arrayBuffer).toHaveBeenCalledOnce();
  invoke.mockClear(); arrayBuffer.mockClear();
  expect(await api.dropFiles([{ name: 'huge.png', size: 12 * 1024 * 1024 + 1, arrayBuffer }])).toMatchObject({ ok: false });
  expect(await api.dropFiles(Array(21).fill({ name: 'clipboard.png', size: 3, arrayBuffer }))).toMatchObject({ ok: false });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});


it('exposes only named input and recorded-image IPC actions', async () => {
  vi.resetModules();
  expose.mockClear(); invoke.mockClear();
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  await api.chooseFiles();
  await api.attachText('pasted text');
  const input = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: null, text: 'hello', attachments: [], images: [] };
  await api.sendInput(input);
  await api.listInputs();
  await api.cancelInput(input.id);
  await api.getSessionImage('session-one', 'abcdef1234567890.bin');
  expect(invoke.mock.calls).toEqual([
    ['sessions:files', undefined],
    ['sessions:attachText', { text: 'pasted text' }],
    ['sessions:send', input],
    ['sessions:outbox', undefined],
    ['sessions:cancelInput', { id: input.id }],
    ['sessions:image', { id: 'session-one', assetId: 'abcdef1234567890.bin' }]
  ]);
});
