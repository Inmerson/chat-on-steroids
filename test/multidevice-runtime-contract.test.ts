import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('installed 2.1.3 multi-device runtime surface', () => {
  it('keeps coordinator lifecycle and renderer IPC plumbing in source', async () => {
    const [host, connection, protocol, ipc, preload, renderer] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src/main/core/host-entry.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src/main/connection-local.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src/shared/core-protocol.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src/main/ipc-ui.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src/preload/index.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src/renderer/main-app.ts'), 'utf8')
    ]);

    expect(host).toContain('startCoordinatorTransport');
    expect(host).toContain('coordinatorTransport?.close()');
    expect(connection).toContain('multiDevice: { execute: executeRemote }');
    expect(protocol).toContain("'devices-revoke'");
    expect(ipc).toContain("handle('devices:revoke'");
    expect(preload).toContain('revokeDevice:');
    expect(renderer).toContain('device: previous.device');
  });
});
