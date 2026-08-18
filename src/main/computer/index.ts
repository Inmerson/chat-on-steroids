/**
 * Computer use: seeing the screen and driving the mouse and keyboard.
 *
 * This is deliberately the smallest surface that still lets a model actually operate
 * the machine. The action vocabulary mirrors OpenAI's computer-use tool — click,
 * double_click, scroll, type, keypress, drag, move, wait, screenshot — so a model
 * that already knows how to drive a computer does not have to learn a private
 * dialect, plus the two things Windows needs and a browser viewport does not:
 * listing windows and bringing one to the front.
 *
 * Coordinates are always in *screenshot pixels*. The helper runs without per-monitor
 * DPI awareness, so capture and input share one coordinate space and agree with each
 * other; the scale between that space and the returned image is applied here, and
 * every screenshot states the size it was returned at.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureUsablePath, normalizeEnvironment, setEnvValue } from '../env.js';
import { findWindowsPowerShell } from '../exec.js';
import { logWarn } from '../logger.js';
import { HELPER_SCRIPT } from './helper.js';

/** Width the screenshot is scaled down to, matching computer-use convention. */
export const DEFAULT_SCREENSHOT_WIDTH = 1280;
export const MAX_SCREENSHOT_WIDTH = 2560;
const HELPER_TIMEOUT_MS = 30_000;

export class ComputerError extends Error {}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  title: string;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: 'foreground' | 'minimized' | 'open';
}

export interface UiElementInfo {
  /** Opaque state-scoped reference accepted by click_ref/set_value. */
  ref: string;
  name: string;
  role: string;
  automationId: string;
  enabled: boolean;
  offscreen: boolean;
  bounds: Rect;
  /** Present when the element is fully inside the most recent screenshot frame. */
  imageBounds: Rect | null;
  imageCenter: { x: number; y: number } | null;
}

export interface Screenshot {
  /** Base64 PNG. */
  data: string;
  /** Stable id for the coordinate frame used by later pointing actions. */
  frameId: number;
  /** Size of the returned image, which is what coordinates refer to. */
  width: number;
  height: number;
  /** The screen region it shows, in the helper's coordinate space. */
  region: Rect;
  scale: number;
  /**
   * For a window capture: whether that window was actually in front when the pixels were
   * taken. Null for whole-screen captures, where the question does not arise.
   *
   * A window capture asks Windows to activate the window first, because unoccluded pixels
   * are better — but it does not *require* it. Looking at a window is not an action on it,
   * and refusing to photograph a window because something else holds focus made the one
   * recovery path (focus it) unreachable. False here means the image may show whatever is
   * covering the window, and the caller is expected to say so.
   */
  focused: boolean | null;
}

export type Action =
  | { type: 'click_ref'; ref: string }
  | { type: 'set_value'; ref: string; text: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: string }
  | { type: 'double_click'; x: number; y: number; button?: string }
  | { type: 'scroll'; x: number; y: number; scroll_x?: number; scroll_y?: number }
  | { type: 'drag'; path: Array<{ x: number; y: number }>; button?: string }
  | { type: 'type'; text: string }
  | { type: 'keypress'; keys: string[] }
  | { type: 'focus'; window: number }
  | { type: 'wait'; ms?: number }
  // The clipboard is part of driving a desktop — it is how text gets into an app that has
  // no accessible text field. These two are done in Electron rather than by the helper, but
  // they run inside the same lock and in the caller's order, so "put this on the clipboard,
  // then press ctrl+v" is one uninterrupted sequence.
  | { type: 'read_clipboard' }
  | { type: 'write_clipboard'; text: string };

/**
 * One long-lived PowerShell helper process.
 *
 * Add-Type compiles the Win32 C# bridge and used to run on every screenshot/click,
 * which made each desktop MCP call pay a fresh PowerShell startup + C# compilation.
 * The helper now stays alive and speaks newline-delimited JSON over stdin/stdout. Only
 * the fixed bootstrap is executable PowerShell; model-supplied request data is JSON.
 */
interface PendingHelperRequest {
  resolve: (value: Record<string, any>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface HelperRuntime {
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrTail: string;
  pending: PendingHelperRequest | null;
}

let helperRuntime: HelperRuntime | null = null;
let helperStarting: Promise<HelperRuntime> | null = null;
let helperQueue: Promise<void> = Promise.resolve();
let helperGeneration = 0;
let findUiWarmGeneration = -1;

function readableHelperFailure(stderr: string): string {
  const clean = stderr
    .replace(/^#< CLIXML[\s\S]*/m, '')
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return clean?.slice(0, 300) ?? 'the helper process exited unexpectedly';
}

async function startHelper(): Promise<HelperRuntime> {
  if (helperRuntime) return helperRuntime;
  if (helperStarting) return helperStarting;

  helperStarting = new Promise<HelperRuntime>((resolve, reject) => {
    const bootstrap = Buffer.from('Invoke-Expression $env:CLF_HELPER', 'utf16le').toString('base64');
    // `powershell.exe` is found through the environment handed to the child, so that
    // environment has to be sound before the spawn rather than after it: a bare
    // `{ ...process.env }` is what turned a missing System32 entry into an unexplained
    // `spawn powershell.exe ENOENT` with no helper and no diagnosis.
    const env = normalizeEnvironment(process.env);
    setEnvValue(env, 'CLF_HELPER', HELPER_SCRIPT);
    ensureUsablePath(env);
    // By absolute path, so starting the helper does not depend on the very thing it is
    // often asked to diagnose. The repaired environment above is the second line of
    // defence, not the first.
    const host = findWindowsPowerShell() ?? 'powershell.exe';
    const child = spawn(host, ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', bootstrap], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv
    });
    const runtime: HelperRuntime = {
      child,
      stdoutBuffer: '',
      stderrTail: '',
      pending: null
    };
    let started = false;

    child.stdout.on('data', (chunk: Buffer) => {
      runtime.stdoutBuffer += chunk.toString('utf8');
      for (;;) {
        const newline = runtime.stdoutBuffer.indexOf('\n');
        if (newline === -1) break;
        const line = runtime.stdoutBuffer.slice(0, newline).trim();
        runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        const pending = runtime.pending;
        if (!pending) {
          logWarn(`desktop helper sent unsolicited output: ${line.slice(0, 200)}`);
          continue;
        }
        let reply: Record<string, any>;
        try {
          reply = JSON.parse(line) as Record<string, any>;
        } catch {
          clearTimeout(pending.timer);
          runtime.pending = null;
          pending.reject(new ComputerError('The desktop helper returned malformed JSON.'));
          continue;
        }
        clearTimeout(pending.timer);
        runtime.pending = null;
        if (reply['ok'] === false) {
          const code = String(reply['error_code'] ?? 'HELPER_ERROR');
          const message = String(reply['message'] ?? 'Desktop helper failed');
          pending.reject(new ComputerError(`${code}: ${message}`));
        } else {
          pending.resolve(reply);
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      runtime.stderrTail = `${runtime.stderrTail}${chunk.toString('utf8')}`.slice(-8000);
    });
    child.once('spawn', () => {
      started = true;
      helperRuntime = runtime;
      helperGeneration += 1;
      resolve(runtime);
    });
    child.once('error', (error) => {
      if (helperRuntime === runtime) helperRuntime = null;
      if (!started) reject(new ComputerError(`Could not start PowerShell: ${error.message}`));
      const pending = runtime.pending;
      if (pending) {
        clearTimeout(pending.timer);
        runtime.pending = null;
        pending.reject(new ComputerError(`Desktop helper process error: ${error.message}`));
      }
    });
    child.once('close', () => {
      if (helperRuntime === runtime) helperRuntime = null;
      const pending = runtime.pending;
      if (pending) {
        clearTimeout(pending.timer);
        runtime.pending = null;
        pending.reject(new ComputerError(`Desktop helper failed: ${readableHelperFailure(runtime.stderrTail)}`));
      }
    });
  }).finally(() => {
    helperStarting = null;
  });

  return helperStarting;
}

async function sendHelperRequest(request: Record<string, unknown>): Promise<Record<string, any>> {
  const runtime = await startHelper();
  if (runtime.pending) throw new ComputerError('Desktop helper received overlapping requests.');

  return new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (runtime.pending) runtime.pending = null;
      if (helperRuntime === runtime) helperRuntime = null;
      runtime.child.kill();
      reject(new ComputerError('The desktop helper did not answer in time.'));
    }, HELPER_TIMEOUT_MS);
    runtime.pending = { resolve, reject, timer };
    runtime.child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
      if (!error) return;
      clearTimeout(timer);
      runtime.pending = null;
      if (helperRuntime === runtime) helperRuntime = null;
      reject(new ComputerError(`Could not send a desktop helper request: ${error.message}`));
    });
  });
}

function runHelper(request: Record<string, unknown>): Promise<Record<string, any>> {
  const result = helperQueue.then(() => sendHelperRequest(request));
  helperQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * The region and scale of the most recent screenshot.
 *
 * Actions arrive in the coordinates of the picture the model was looking at, so the
 * conversion back to screen coordinates needs to remember what that picture showed.
 */
interface Frame {
  id: number;
  region: Rect;
  scale: number;
  width: number;
  height: number;
}

let nextFrameId = 1;
let lastFrame: Frame | null = null;
let nextUiStateId = 1;

/**
 * Serialises whole multi-step acquisitions, not just single helper requests.
 *
 * `lastFrame` is one global coordinate system shared by every chat and every agent in
 * this app. get_window_state captures a screenshot and then maps UI element bounds into
 * it; without this lock another caller's capture can land between those two awaits and
 * the reply would pair one screenshot with centres computed against a different one.
 */
let exclusiveQueue: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = exclusiveQueue.then(task, task);
  exclusiveQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
const uiRefs = new Map<string, { window: number; runtimeKey: string; generation: number }>();

/**
 * Refs carry the helper generation that minted them. A UI Automation runtime id only
 * means anything to the helper process that issued it, so once the helper restarts every
 * outstanding ref is meaningless — and acting on one would click whatever now happens to
 * hold that id. Stamping the generation makes that detectable instead of silent.
 */
function rememberUiRef(window: number, runtimeKey: string, index: number, stateId: number): string {
  const generation = helperGeneration;
  const ref = `g${generation}_e${stateId}_${index + 1}`;
  uiRefs.set(ref, { window, runtimeKey, generation });
  while (uiRefs.size > 1000) {
    const oldest = uiRefs.keys().next().value as string | undefined;
    if (!oldest) break;
    uiRefs.delete(oldest);
  }
  return ref;
}

function uiTarget(ref: string): { window: number; runtimeKey: string } {
  const target = uiRefs.get(ref);
  if (!target) {
    throw new ComputerError(
      `UNKNOWN_UI_REF: ${ref}. Call get_window_state or find_ui again and use a ref from that reply.`
    );
  }
  if (target.generation !== helperGeneration) {
    throw new ComputerError(
      `STALE_REF: ${ref} was issued before the desktop helper restarted, so it no longer identifies anything. Call get_window_state again and use a ref from that reply.`
    );
  }
  return target;
}

export async function listWindows(): Promise<{ windows: WindowInfo[]; screen: Rect }> {
  const reply = await runHelper({ op: 'windows' });
  return { windows: (reply['windows'] as WindowInfo[]) ?? [], screen: reply['screen'] as Rect };
}

export async function focusWindow(id: number): Promise<boolean> {
  const reply = await runHelper({ op: 'focus', id });
  return reply['focused'] === true;
}

export async function activeWindow(): Promise<{ window: WindowInfo | null; screen: Rect }> {
  const reply = await runHelper({ op: 'active' });
  const value = reply['window'];
  const window = value && typeof value === 'object' ? (value as WindowInfo) : null;
  return { window, screen: reply['screen'] as Rect };
}

export async function findUi(opts: {
  window?: number;
  query?: string;
  role?: string;
  maxResults?: number;
}): Promise<{ window: number; elements: UiElementInfo[] }> {
  return exclusive(() => findUiLocked(opts, lastFrame));
}

/**
 * Maps elements into `frame` rather than into whatever `lastFrame` happens to be by the
 * time the helper answers. The caller states which picture the coordinates belong to.
 */
async function findUiLocked(
  opts: {
    window?: number;
    query?: string;
    role?: string;
    maxResults?: number;
  },
  frame: Frame | null
): Promise<{ window: number; elements: UiElementInfo[] }> {
  const request = {
    op: 'find_ui',
    ...(opts.window === undefined ? {} : { id: opts.window }),
    query: opts.query ?? '',
    role: opts.role ?? '',
    maxResults: Math.min(100, Math.max(1, Math.floor(opts.maxResults ?? 30)))
  };
  let reply = await runHelper(request);
  const generation = helperGeneration;
  let raw = Array.isArray(reply['elements']) ? (reply['elements'] as Array<Record<string, any>>) : [];
  // UI Automation can return an empty tree on the very first query immediately after
  // the helper starts. Retry that one cold miss internally instead of making the model
  // spend another MCP round trip. Legitimate later empty queries stay fast.
  if (raw.length === 0 && findUiWarmGeneration !== generation) {
    findUiWarmGeneration = generation;
    await new Promise((resolve) => setTimeout(resolve, 150));
    reply = await runHelper(request);
    raw = Array.isArray(reply['elements']) ? (reply['elements'] as Array<Record<string, any>>) : [];
  } else {
    findUiWarmGeneration = generation;
  }
  const stateId = nextUiStateId++;
  const windowId = Number(reply['window']);
  const elements = raw.map((item, index): UiElementInfo => {
    const bounds = item['bounds'] as Rect;
    let imageBounds: Rect | null = null;
    let imageCenter: { x: number; y: number } | null = null;
    if (
      frame &&
      bounds.x >= frame.region.x &&
      bounds.y >= frame.region.y &&
      bounds.x + bounds.width <= frame.region.x + frame.region.width &&
      bounds.y + bounds.height <= frame.region.y + frame.region.height
    ) {
      imageBounds = {
        x: Math.round((bounds.x - frame.region.x) * frame.scale),
        y: Math.round((bounds.y - frame.region.y) * frame.scale),
        width: Math.round(bounds.width * frame.scale),
        height: Math.round(bounds.height * frame.scale)
      };
      imageCenter = {
        x: Math.round(imageBounds.x + imageBounds.width / 2),
        y: Math.round(imageBounds.y + imageBounds.height / 2)
      };
    }
    const runtimeKey = String(item['runtimeKey'] ?? '');
    return {
      ref: runtimeKey
        ? rememberUiRef(windowId, runtimeKey, index, stateId)
        : `unavailable-${stateId}-${index + 1}`,
      name: String(item['name'] ?? ''),
      role: String(item['role'] ?? ''),
      automationId: String(item['automationId'] ?? ''),
      enabled: item['enabled'] === true,
      offscreen: item['offscreen'] === true,
      bounds,
      imageBounds,
      imageCenter
    };
  });
  return { window: windowId, elements };
}

export async function getWindowState(opts: {
  window?: number;
  maxWidth?: number;
  maxElements?: number;
  includeScreenshot?: boolean;
  includeUi?: boolean;
}): Promise<{ window: WindowInfo; screenshot: Screenshot | null; elements: UiElementInfo[] }> {
  // The whole acquisition is one critical section. Its screenshot and its element
  // geometry have to describe the same moment, and no other caller may retarget the
  // shared frame in between.
  return exclusive(async () => {
    let window: WindowInfo | null = null;
    if (opts.window === undefined) {
      window = (await activeWindow()).window;
    } else {
      window = (await listWindows()).windows.find((item) => item.id === opts.window) ?? null;
    }
    if (!window) throw new ComputerError('WINDOW_NOT_FOUND: no matching visible window is available');

    const includeScreenshot = opts.includeScreenshot !== false;
    const includeUi = opts.includeUi !== false;
    const shot = includeScreenshot
      ? await screenshotLocked({ window: window.id, maxWidth: opts.maxWidth })
      : null;
    // Map against the frame this call just took, never against the global.
    const frame: Frame | null = shot
      ? { id: shot.frameId, region: shot.region, scale: shot.scale, width: shot.width, height: shot.height }
      : null;
    const found = includeUi
      ? await findUiLocked({ window: window.id, maxResults: opts.maxElements ?? 60 }, frame)
      : { window: window.id, elements: [] as UiElementInfo[] };
    const elements = includeScreenshot
      ? found.elements
      : found.elements.map((element) => ({ ...element, imageBounds: null, imageCenter: null }));
    return { window, screenshot: shot, elements };
  });
}

export async function waitForWindow(opts: {
  title?: string;
  process?: string;
  foreground?: boolean;
  timeoutMs?: number;
}): Promise<WindowInfo> {
  const title = opts.title?.trim().toLowerCase();
  const processName = opts.process?.trim().toLowerCase();
  if (!title && !processName) throw new ComputerError('wait_for_window needs title or process');
  const timeoutMs = Math.min(60_000, Math.max(0, Math.floor(opts.timeoutMs ?? 10_000)));
  const deadline = Date.now() + timeoutMs;
  const matches = (window: WindowInfo): boolean =>
    (!title || window.title.toLowerCase().includes(title)) &&
    (!processName || window.process.toLowerCase().includes(processName));

  for (;;) {
    if (opts.foreground === true) {
      const { window } = await activeWindow();
      if (window && matches(window)) return window;
    } else {
      const { windows } = await listWindows();
      const found = windows.find(matches);
      if (found) return found;
    }
    if (Date.now() >= deadline) {
      throw new ComputerError(
        `WAIT_TIMEOUT: no matching ${opts.foreground === true ? 'foreground ' : ''}window appeared within ${timeoutMs} ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Captures the primary monitor, every monitor, or one window.
 *
 * The helper does the downscaling while the bitmap is still in its hands, because a
 * 4K screenshot is slow to encode, slow to base64 and harder for a model to point at
 * accurately than a 1280-wide one. Nothing downstream ever wants the full-size image,
 * so it is never produced.
 */
export async function screenshot(opts: {
  window?: number;
  full?: boolean;
  maxWidth?: number;
  /** Crop in pixels of the most recent returned screenshot. */
  crop?: Rect;
}): Promise<Screenshot> {
  return exclusive(() => screenshotLocked(opts));
}

/**
 * @param cropFrame Frame a crop is expressed in. Callers that ran something between the
 * frame the model saw and this capture pass it explicitly; everyone else means the
 * current one.
 */
async function screenshotLocked(
  opts: {
    window?: number;
    full?: boolean;
    maxWidth?: number;
    crop?: Rect;
  },
  cropFrame?: Frame | null
): Promise<Screenshot> {
  if (opts.crop && (opts.window !== undefined || opts.full === true)) {
    throw new ComputerError('crop cannot be combined with window or full capture');
  }

  let cropRegion: Rect | undefined;
  if (opts.crop) {
    const frame = cropFrame === undefined ? lastFrame : cropFrame;
    if (!frame) throw new ComputerError('Take a screenshot first — crop coordinates refer to the most recent frame.');
    const crop = {
      x: Math.floor(opts.crop.x),
      y: Math.floor(opts.crop.y),
      width: Math.floor(opts.crop.width),
      height: Math.floor(opts.crop.height)
    };
    if (crop.width <= 0 || crop.height <= 0) throw new ComputerError('crop width and height must be positive');
    if (
      crop.x < 0 ||
      crop.y < 0 ||
      crop.x + crop.width > frame.width ||
      crop.y + crop.height > frame.height
    ) {
      throw new ComputerError(
        `crop must fit inside frame ${frame.id} (${frame.width}x${frame.height})`
      );
    }
    const left = Math.round(frame.region.x + crop.x / frame.scale);
    const top = Math.round(frame.region.y + crop.y / frame.scale);
    const right = Math.round(frame.region.x + (crop.x + crop.width) / frame.scale);
    const bottom = Math.round(frame.region.y + (crop.y + crop.height) / frame.scale);
    cropRegion = {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    };
  }

  // By default a crop preserves roughly the pixel density the model selected from
  // the previous frame instead of expanding a small crop back to 1280px wide.
  const requestedWidth =
    opts.maxWidth ?? (opts.crop ? Math.max(1, Math.floor(opts.crop.width)) : DEFAULT_SCREENSHOT_WIDTH);
  const limit = Math.min(
    MAX_SCREENSHOT_WIDTH,
    opts.crop && opts.maxWidth === undefined
      ? Math.max(1, requestedWidth)
      : Math.max(320, Math.floor(requestedWidth))
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-shot-'));
  const file = path.join(dir, 'screen.png');
  try {
    const reply = await runHelper({
      op: 'capture',
      file,
      maxWidth: limit,
      ...(cropRegion === undefined ? {} : { region: cropRegion }),
      ...(opts.window === undefined ? {} : { id: opts.window }),
      ...(opts.full === true ? { full: true } : {})
    });
    const region = reply['region'] as Rect;
    const size = reply['image'] as { width: number; height: number };

    const png = await fs.readFile(file).catch(() => {
      throw new ComputerError('The screen capture produced no image.');
    });
    if (png.length === 0) throw new ComputerError('The screen capture came back empty.');

    const scale = size.width / region.width;
    const frameId = nextFrameId++;
    lastFrame = { id: frameId, region, scale, width: size.width, height: size.height };
    return {
      data: png.toString('base64'),
      frameId,
      width: size.width,
      height: size.height,
      region,
      scale,
      focused: opts.window === undefined ? null : reply['focused'] === true
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Performs a batch of actions.
 *
 * Image coordinates are converted to screen coordinates against the region the last
 * screenshot showed, so the model can point at what it saw without knowing anything
 * about monitor layout or scaling.
 */
export interface PointerResult {
  screen: { x: number; y: number };
  image: { x: number; y: number } | null;
  frameId: number | null;
  imageSize: { width: number; height: number } | null;
}

export async function act(
  actions: Action[],
  opts: { frameId?: number } = {}
): Promise<{ cursor: PointerResult; clipboard: string[] }> {
  return exclusive(() => actLocked(actions, opts));
}

/**
 * Acts and then verifies, as one indivisible operation.
 *
 * Doing this as act() followed by screenshot() takes the lock twice, and another chat or
 * agent can focus a window, click, or capture in the gap — so the "after" picture could
 * show someone else's result. That would defeat the only reason to ask for a capture in
 * the same call. The crop is resolved against the frame that was current before the
 * actions ran, which is the one whose coordinates the caller was looking at.
 */
export async function actAndCapture(
  actions: Action[],
  opts: {
    frameId?: number;
    capture?: {
      window?: number;
      full?: boolean;
      maxWidth?: number;
      crop?: Rect;
      /** Privacy mode: capture whatever window is in front once the actions have run. */
      preferActiveWindow?: boolean;
    };
  } = {}
): Promise<{ cursor: PointerResult; screenshot: Screenshot | null; clipboard: string[] }> {
  return exclusive(async () => {
    const before = lastFrame;
    const result = await actLocked(actions, opts);
    if (!opts.capture) return { cursor: result.cursor, screenshot: null, clipboard: result.clipboard };

    const { preferActiveWindow, ...capture } = opts.capture;
    // Resolved here rather than by the caller: the actions may have changed which window
    // is in front, and resolving it outside the lock would reopen the gap this closes.
    if (preferActiveWindow && capture.window === undefined && capture.full !== true && capture.crop === undefined) {
      capture.window = (await activeWindow()).window?.id;
    }
    return {
      cursor: result.cursor,
      screenshot: await screenshotLocked(capture, before),
      clipboard: result.clipboard
    };
  });
}

async function actLocked(
  actions: Action[],
  opts: { frameId?: number }
): Promise<{ cursor: PointerResult; clipboard: string[] }> {
  const pointing = new Set(['move', 'click', 'double_click', 'scroll', 'drag']);
  const needsFrame = actions.some((a) => pointing.has(a.type));
  if (needsFrame && !lastFrame) {
    throw new ComputerError('Take a screenshot first — pointing needs a picture to point at.');
  }
  // The frame is global to this app, so another chat or agent can replace it between the
  // screenshot a caller saw and the click it sends. Without the id there is no way to
  // tell that apart from a click on the picture the caller actually looked at.
  if (needsFrame && opts.frameId !== undefined && opts.frameId !== lastFrame?.id) {
    throw new ComputerError(
      `STALE_FRAME: these coordinates are for frame ${opts.frameId}, but the current screen frame is ${lastFrame?.id ?? 'none'}. Take a screenshot or call get_window_state again and point at the new frame.`
    );
  }
  const frame =
    lastFrame ?? { id: 0, region: { x: 0, y: 0, width: 1, height: 1 }, scale: 1, width: 1, height: 1 };
  const toScreenX = (x: number): number => Math.round(frame.region.x + x / frame.scale);
  const toScreenY = (y: number): number => Math.round(frame.region.y + y / frame.scale);

  const mapOne = (action: Action): Record<string, unknown> => {
    switch (action.type) {
      case 'click_ref': {
        const target = uiTarget(action.ref);
        return { type: 'click_ui', window: target.window, runtimeKey: target.runtimeKey };
      }
      case 'set_value': {
        const target = uiTarget(action.ref);
        return { type: 'set_value_ui', window: target.window, runtimeKey: target.runtimeKey, value: action.text };
      }
      case 'move':
      case 'click':
      case 'double_click':
        return {
          type: action.type,
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          button: 'button' in action ? (action.button ?? 'left') : 'left'
        };
      case 'scroll':
        return {
          type: 'scroll',
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          scroll_x: action.scroll_x ?? 0,
          scroll_y: action.scroll_y ?? 0
        };
      case 'drag':
        return {
          type: 'drag',
          xs: action.path.map((p) => toScreenX(p.x)),
          ys: action.path.map((p) => toScreenY(p.y)),
          button: action.button ?? 'left'
        };
      case 'type':
        return { type: 'type', text: action.text };
      case 'keypress':
        return { type: 'keypress', keys: action.keys };
      case 'focus':
        return { type: 'focus', window: action.window };
      case 'wait':
        return { type: 'wait', ms: Math.min(10_000, Math.max(0, action.ms ?? 2000)) };
      default:
        throw new ComputerError(`Unsupported action`);
    }
  };

  // Clipboard steps are not desktop input, so the helper never sees them: the pending
  // batch is flushed at each one instead. That keeps every step in the order it was
  // asked for — put text on the clipboard, then press ctrl+v — without giving up the
  // lock in between, which a second call from the tool layer would have done.
  const clipboard: string[] = [];
  let batch: ReturnType<typeof mapOne>[] = [];
  let reply: Record<string, any> = {};
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    reply = await runHelper({ op: 'act', actions: batch });
    batch = [];
  };
  for (const action of actions) {
    if (action.type === 'read_clipboard') {
      await flush();
      clipboard.push((await electronClipboard()).readText());
      continue;
    }
    if (action.type === 'write_clipboard') {
      await flush();
      (await electronClipboard()).writeText(action.text);
      continue;
    }
    batch.push(mapOne(action));
  }
  // Always ends with the helper, even when the last step was a clipboard one: the cursor
  // position in the reply is what the caller is told about where things now stand.
  batch.push({ type: 'wait', ms: 0 });
  await flush();

  const raw = reply['cursor'] as { x?: unknown; y?: unknown } | undefined;
  const sx = Number(raw?.x);
  const sy = Number(raw?.y);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
    throw new ComputerError('The desktop helper returned an invalid pointer position.');
  }
  const current = lastFrame;
  const image = current
    ? {
        x: Math.round((sx - current.region.x) * current.scale),
        y: Math.round((sy - current.region.y) * current.scale)
      }
    : null;
  return {
    cursor: {
      screen: { x: sx, y: sy },
      image,
      frameId: current?.id ?? null,
      imageSize: current ? { width: current.width, height: current.height } : null
    },
    clipboard
  };
}

/**
 * Electron's clipboard, loaded only if a clipboard action is actually used.
 *
 * Imported lazily rather than at the top of the file because everything else here runs
 * happily outside Electron — the desktop tests drive the helper directly — and a static
 * import would make that impossible for the sake of two actions.
 */
async function electronClipboard(): Promise<{ readText: () => string; writeText: (text: string) => void }> {
  try {
    const { clipboard } = await import('electron');
    if (!clipboard) throw new Error('no clipboard');
    return clipboard;
  } catch {
    throw new ComputerError('The clipboard is only available while the app is running.');
  }
}

/** Confirms the helper can run at all, so the UI can say so before ChatGPT tries. */
export async function checkAvailable(): Promise<string | null> {
  try {
    await listWindows();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`computer use unavailable: ${message}`);
    return message;
  }
}
