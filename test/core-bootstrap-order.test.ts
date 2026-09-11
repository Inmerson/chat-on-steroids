import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('Core Host bootstrap ordering', () => {
  it('claims the Core IPC endpoint before waiting for Electron readiness', () => {
    const bootstrap = readFileSync(path.join(root, 'src', 'main', 'bootstrap.ts'), 'utf8');
    const hostBranch = bootstrap.indexOf("if (mode.kind === 'core-host') {");
    const hostEntry = bootstrap.indexOf("await runCoreHost({ userDataDir: mode.userDataDir });", hostBranch);
    const helperReady = bootstrap.indexOf('await app.whenReady();', hostEntry);

    expect(hostBranch).toBeGreaterThan(-1);
    expect(hostEntry).toBeGreaterThan(hostBranch);
    expect(helperReady).toBeGreaterThan(hostEntry);

    const host = readFileSync(path.join(root, 'src', 'main', 'core', 'host-entry.ts'), 'utf8');
    const ipc = host.indexOf('const ipc = await startCoreIpcServer({');
    const runtimeReady = host.indexOf('await app.whenReady();', ipc);
    const runtime = host.indexOf('runtime = await startCoreRuntime(options.userDataDir);', runtimeReady);

    expect(ipc).toBeGreaterThan(-1);
    expect(runtimeReady).toBeGreaterThan(ipc);
    expect(runtime).toBeGreaterThan(runtimeReady);
  });
});
