import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = { fn: (...args: any[]) => void; once: boolean };
  class Emitter {
    private listeners = new Map<string, Listener[]>();
    on(event: string, fn: (...args: any[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: false }]);
      return this;
    }
    once(event: string, fn: (...args: any[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once: true }]);
      return this;
    }
    emit(event: string, ...args: any[]) {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(event, listeners.filter((entry) => !entry.once));
      for (const listener of listeners) listener.fn(...args);
    }
  }

  const requests: Array<Record<string, any>> = [];
  const children: Transport[] = [];
  class Transport extends Emitter {
    readonly pid = 9300 + children.length;
    exitCode: number | null = null;
    readonly stdout = new Emitter();
    readonly stderr = new Emitter();
    readonly stdin = {
      write: (line: string, _encoding: string, callback: (error: null) => void) => {
        callback(null);
        this.answer(JSON.parse(line));
        return true;
      },
      end: () => this.close()
    };

    constructor() {
      super();
      children.push(this);
      queueMicrotask(() => this.emit('spawn'));
    }

    close() {
      if (this.exitCode !== null) return;
      this.exitCode = 0;
      this.emit('close', 0);
    }

    private answer(request: Record<string, any>) {
      requests.push(request);
      const rect = { x: 0, y: 0, width: 100, height: 100 };
      const window = { id: 77, title: 'Example', process: 'Example', ...rect, state: 'foreground' };
      if (request.file) {
        process.getBuiltinModule('node:fs').writeFileSync(request.file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      const reply = {
        ok: true,
        window: request.op === 'find_ui' ? 77 : window,
        windows: [window],
        screen: rect,
        region: rect,
        image: { width: 100, height: 100 },
        captureMode: 'window',
        focused: true,
        snapshotId: 41,
        elements: [
          {
            runtimeKey: 'button',
            name: 'Example',
            role: 'Button',
            automationId: 'example',
            enabled: true,
            offscreen: false,
            bounds: { x: 10, y: 10, width: 20, height: 20 }
          }
        ],
        cursor: { x: 20, y: 20 },
        routes: (request.actions ?? []).map((action: Record<string, unknown>) =>
          action.type === 'click_ui' || action.type === 'set_value_ui' ? 'uia' : 'sendinput'
        )
      };
      queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
    }
  }

  return { requests, children, spawn: () => new Transport() };
});

vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('../src/main/env.js', () => ({
  ensureUsablePath: vi.fn(),
  normalizeEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env }),
  setEnvValue: (env: NodeJS.ProcessEnv, key: string, value: string) => { env[key] = value; }
}));
vi.mock('../src/main/exec.js', () => ({
  findWindowsPowerShell: () => 'powershell.exe',
  terminateProcessTree: async (pid: number) => { fake.children.find((child) => child.pid === pid)?.close(); }
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

describe('Desktop reply provenance across helper replacement', () => {
  let computer: typeof import('../src/main/computer/index.js');

  beforeEach(async () => {
    vi.resetModules();
    fake.children.length = 0;
    fake.requests.length = 0;
    computer = await import('../src/main/computer/index.js');
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (computer) await computer.stopComputerHelper();
  });

  const replaceHelper = async () => {
    fake.children.at(-1)!.close();
    await computer.listWindows();
  };

  it('keeps an original reply identity across asynchronous image materialization', async () => {
    const readFile = fs.readFile.bind(fs) as (...args: any[]) => Promise<any>;
    const boundary = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args: any[]) => {
      await replaceHelper();
      return readFile(...args);
    });

    const state = await computer.getWindowState({ window: 77 });
    boundary.mockRestore();

    expect(fake.children).toHaveLength(2);
    expect(state.screenshot).not.toBeNull();
    const sent = fake.requests.length;
    await expect(computer.act([{ type: 'click_ref', ref: state.elements[0]!.ref }])).rejects.toThrow(/STALE_REF/);
    await expect(
      computer.act([{ type: 'move', x: 10, y: 10 }], { frameId: state.screenshot!.frameId })
    ).rejects.toThrow(/STALE_FRAME/);
    expect(fake.requests).toHaveLength(sent);

    const fresh = await computer.getWindowState({ window: 77 });
    expect(fresh.elements[0]!.ref).not.toBe(state.elements[0]!.ref);
    await expect(computer.act([{ type: 'click_ref', ref: fresh.elements[0]!.ref }])).resolves.toBeTruthy();
  });

  it.each(['frame', 'ref'] as const)('rechecks %s provenance at dispatch after local work', async (kind) => {
    const state = await computer.getWindowState({ window: 77 });
    vi.useFakeTimers();
    const work = computer.act([
      { type: 'wait', ms: 100 },
      ...(kind === 'frame'
        ? [{ type: 'move' as const, x: 10, y: 10 }]
        : [{ type: 'click_ref' as const, ref: state.elements[0]!.ref }])
    ], { frameId: state.screenshot!.frameId });
    const rejected = expect(work).rejects.toMatchObject({
      completedCount: 1,
      failedIndex: 1,
      message: expect.stringMatching(kind === 'frame' ? /STALE_FRAME/ : /STALE_REF/)
    });
    void rejected.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    await replaceHelper();
    const sent = fake.requests.length;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(fake.requests).toHaveLength(sent);
  });
});
