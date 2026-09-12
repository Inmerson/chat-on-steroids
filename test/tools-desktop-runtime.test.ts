import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';

const desktop = vi.hoisted(() => {
  class TestComputerError extends Error {}
  return {
    ComputerError: TestComputerError,
    activeWindow: vi.fn(),
    findUi: vi.fn(),
    getWindowState: vi.fn(),
    listDesktopApps: vi.fn(),
    listWindows: vi.fn(),
    screenshot: vi.fn(),
    waitForWindow: vi.fn(),
    actAndCapture: vi.fn()
  };
});

vi.mock('../src/main/computer/index.js', () => ({
  ComputerError: desktop.ComputerError,
  DEFAULT_SCREENSHOT_WIDTH: 1280,
  MAX_SCREENSHOT_WIDTH: 2560,
  actAndCapture: desktop.actAndCapture,
  activeWindow: desktop.activeWindow,
  findUi: desktop.findUi,
  getWindowState: desktop.getWindowState,
  listDesktopApps: desktop.listDesktopApps,
  listWindows: desktop.listWindows,
  screenshot: desktop.screenshot,
  waitForWindow: desktop.waitForWindow
}));

import { registerDesktopTools } from '../src/main/mcp/tools-desktop.js';

function caps(over: Partial<Capabilities>): Capabilities {
  return {
    browse: false,
    search: false,
    read: false,
    metadata: false,
    create: false,
    edit: false,
    move: false,
    deleteFile: false,
    saveArtifact: false,
    command: false,
    screen: false,
    control: false,
    clipboardRead: false,
    clipboardWrite: false,
    ...over
  };
}

function desktopSurface(over: Partial<Capabilities> = {}) {
  const registered = new Map<string, { config: any; handler: (input: any) => Promise<any> }>();
  const liveCaps = caps({ screen: true, ...over });
  registerDesktopTools({
    ctx: { privacyScreenshots: false },
    caps: liveCaps,
    exposedCaps: liveCaps,
    sessionToolsLive: false,
    sessionToolsExposed: false,
    agentToolsLive: false,
    agentToolsExposed: false,
    findExposed: false,
    register(name: string, config: any, handler: (input: any) => Promise<any>) {
      registered.set(name, { config, handler });
    },
    guarded: async (_cap: string, _name: string, fn: () => Promise<any>) => fn(),
    featureDisabled: vi.fn(),
    registered: () => [...registered.keys()]
  } as never);
  return registered;
}

describe('Desktop observe runtime contract', () => {
  it('rejects explicit window ids where the documented mode cannot use them', () => {
    const observe = desktopSurface().get('observe')!;
    expect(observe.config.inputSchema.safeParse({ what: 'active', window: 123 }).success).toBe(false);
    expect(observe.config.inputSchema.safeParse({ wait_for: 'installer', window: 123 }).success).toBe(false);
  });

  it('does not disguise a helper failure as an empty foreground', async () => {
    desktop.getWindowState.mockRejectedValueOnce(new desktop.ComputerError('HELPER_ERROR: helper exploded'));
    const observe = desktopSurface().get('observe')!;

    await expect(observe.handler({})).rejects.toThrow(/HELPER_ERROR: helper exploded/);
    expect(desktop.screenshot).not.toHaveBeenCalled();
  });

  it('still falls back to the monitor for the actual no-foreground state', async () => {
    desktop.getWindowState.mockRejectedValueOnce(
      new desktop.ComputerError('WINDOW_NOT_FOUND: no matching visible window is available')
    );
    desktop.screenshot.mockResolvedValueOnce({
      data: 'png',
      frameId: 7,
      width: 320,
      height: 200,
      region: { x: 0, y: 0, width: 320, height: 200 },
      scale: 1,
      focused: null
    });
    const observe = desktopSurface().get('observe')!;

    const result = await observe.handler({});
    expect(result.content[0].text).toContain('No foreground window');
    expect(result.content[0].text).toContain('frameId 7');
  });

  it('supports what=apps and match filtering', async () => {
    desktop.listDesktopApps.mockResolvedValueOnce({
      apps: [
        { id: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', displayName: 'Terminal', isRunning: true, windows: [{ id: 10 }] },
        { id: 'Microsoft.Paint_8wekyb3d8bbwe!App', displayName: 'Paint', isRunning: false }
      ],
      truncated: false
    });
    const observe = desktopSurface().get('observe')!;
    const result = await observe.handler({ what: 'apps', match: 'term' });
    expect(result.content[0].text).toContain('Installed applications:');
    expect(result.content[0].text).toContain('Terminal');
    expect(result.content[0].text).toContain('[running]');
    expect(desktop.listDesktopApps).toHaveBeenCalledWith({ match: 'term', limit: 60 });
  });

  it('renders accessibility actions, focused element, and document text', async () => {
    desktop.getWindowState.mockResolvedValueOnce({
      window: { id: 1, process: 'app.exe', state: 'normal', title: 'App', x: 0, y: 0, width: 800, height: 600 },
      snapshotId: 42,
      screenshot: { frameId: 10, width: 800, height: 600, data: 'data', captureMode: 'window' },
      elements: [
        {
          ref: 'g1_s42_e1',
          role: 'button',
          name: 'Submit',
          automationId: 'btn1',
          enabled: true,
          offscreen: false,
          actions: ['invoke'],
          focused: true,
          selected: false
        }
      ],
      accessibility: {
        focusedElement: 'g1_s42_e1',
        documentText: 'Document sample text',
        selectedText: 'sample'
      }
    });
    const observe = desktopSurface().get('observe')!;
    const result = await observe.handler({});
    const text = result.content[0].text;
    expect(text).toContain('actions=invoke');
    expect(text).toContain('focused');
    expect(text).toContain('focused_element: g1_s42_e1');
    expect(text).toContain('document_text: "Document sample text"');
    expect(text).toContain('selected_text: "sample"');
  });
});

describe('Desktop computer new actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const nativeResult = () => ({
    completedCount: 1,
    routes: ['uia'],
    cursor: null,
    clipboard: [],
    verification: null,
    screenshot: null
  });

  it('refuses paste without clipboardWrite permission', async () => {
    const computer = desktopSurface({ control: true, clipboardWrite: false }).get('computer')!;
    const result = await computer.handler({ actions: [{ type: 'paste', text: 'hello' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TOOL_DISABLED: paste needs the Replace clipboard text permission.');
    expect(desktop.actAndCapture).not.toHaveBeenCalled();
  });

  it('dispatches paste with clipboardWrite and passes targetWindow', async () => {
    desktop.actAndCapture.mockResolvedValueOnce(nativeResult());
    const computer = desktopSurface({ control: true, clipboardWrite: true }).get('computer')!;
    const result = await computer.handler({ window: 42, actions: [{ type: 'paste', text: 'hello' }] });
    expect(result.isError ?? false).toBe(false);
    expect(desktop.actAndCapture).toHaveBeenCalledWith(
      [{ type: 'paste', text: 'hello' }],
      expect.objectContaining({ window: 42 })
    );
  });

  it('supports launch_app, ui_action, click count, drag duration_ms, and scroll_unit', async () => {
    desktop.actAndCapture.mockResolvedValueOnce({
      completedCount: 5,
      routes: ['shell', 'uia', 'sendinput', 'sendinput', 'sendinput'],
      cursor: null,
      clipboard: [],
      verification: null,
      screenshot: null
    });
    const computer = desktopSurface({ control: true }).get('computer')!;
    const result = await computer.handler({
      frameId: 1,
      actions: [
        { type: 'launch_app', app: 'notepad.exe' },
        { type: 'ui_action', ref: 'g1_s1_e1', action: 'invoke' },
        { type: 'click', x: 10, y: 10, count: 2 },
        { type: 'drag', path: [{ x: 10, y: 10 }, { x: 20, y: 20 }], duration_ms: 150 },
        { type: 'scroll', x: 10, y: 10, scroll_y: -120, scroll_unit: 'wheel' }
      ]
    });
    expect(result.isError ?? false).toBe(false);
    expect(desktop.actAndCapture).toHaveBeenCalledWith(
      [
        { type: 'launch_app', app: 'notepad.exe' },
        { type: 'ui_action', ref: 'g1_s1_e1', action: 'invoke' },
        { type: 'click', x: 10, y: 10, button: undefined, count: 2 },
        { type: 'drag', path: [{ x: 10, y: 10 }, { x: 20, y: 20 }], button: undefined, duration_ms: 150 },
        { type: 'scroll', x: 10, y: 10, scroll_x: undefined, scroll_y: -120, scrollUnit: 'wheel' }
      ],
      expect.objectContaining({ frameId: 1 })
    );
  });
});


describe('Desktop browser keyboard safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const nativeResult = () => ({
    completedCount: 1,
    routes: ['native'],
    cursor: null,
    clipboard: [],
    verification: null,
    screenshot: null
  });

  it('refuses a browser tab-management chord before native dispatch', async () => {
    desktop.activeWindow.mockResolvedValueOnce({
      window: { id: 7, process: 'chrome.exe', title: 'ChatGPT', x: 0, y: 0, width: 1000, height: 700, state: 'normal' },
      screen: { width: 1920, height: 1080 }
    });
    desktop.actAndCapture.mockResolvedValueOnce(nativeResult());
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'keypress', keys: ['ctrl', 'w'] }] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('BROWSER_TAB_CHORD: ctrl+w');
    expect(desktop.actAndCapture).not.toHaveBeenCalled();
  });

  it('leaves the same keypress available to a non-browser target', async () => {
    desktop.activeWindow.mockResolvedValueOnce({
      window: { id: 9, process: 'notepad.exe', title: 'Notes', x: 0, y: 0, width: 800, height: 600, state: 'normal' },
      screen: { width: 1920, height: 1080 }
    });
    desktop.actAndCapture.mockResolvedValueOnce(nativeResult());
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'keypress', keys: ['ctrl', 'w'] }] });

    expect(result.isError ?? false).toBe(false);
    expect(result.content[0].text).toContain('Done 1/1');
    expect(desktop.actAndCapture).toHaveBeenCalledTimes(1);
  });
});
