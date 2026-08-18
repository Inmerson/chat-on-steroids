/**
 * The Desktop connector: seeing and driving Windows itself.
 *
 * Two tools, and they are deliberately not on Core. Desktop control is gated on permissions
 * most users leave off, its schemas are the largest this app publishes, and the majority of
 * coding sessions never touch the desktop — so folding it into Core would put its weight
 * into every no-query discovery of the coding surface for a capability nobody asked for.
 * Separate connector, separate discovery boundary (`docs/tool-surface.md` §6.4).
 *
 * The split between the two is looking versus touching, and it is load-bearing rather than
 * cosmetic: `observe` never requires the foreground and can never fail for lack of it, while
 * `computer` is the only tool allowed to demand focus. That asymmetry is what makes the
 * recovery path work — when something else steals focus, you can still look, see what took
 * it, and act on that.
 */

import { z } from 'zod';
import {
  ComputerError,
  DEFAULT_SCREENSHOT_WIDTH,
  MAX_SCREENSHOT_WIDTH,
  actAndCapture,
  activeWindow,
  findUi,
  getWindowState,
  listWindows,
  screenshot,
  waitForWindow,
  type Action
} from '../computer/index.js';
import { logInfo } from '../logger.js';
import { noteCount, noteDetail } from './call-context.js';
import {
  cropArg,
  fail,
  guard,
  imageCoordinateArg,
  mouseButtonArg,
  ok,
  pointArg,
  windowIdArg,
  type SurfaceRegistrar,
  type ToolContent
} from './kernel.js';

const computerActionArg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click_ref'), ref: z.string().min(1).max(64) }).describe('Click a control by ref from observe.'),
  z
    .object({ type: z.literal('set_value'), ref: z.string().min(1).max(64), text: z.string().max(20_000) })
    .describe('Set a text control’s value directly by ref.'),
  z
    .object({ type: z.literal('click'), x: imageCoordinateArg, y: imageCoordinateArg, button: mouseButtonArg.optional() })
    .describe('Click at image coordinates.'),
  z
    .object({
      type: z.literal('double_click'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      button: mouseButtonArg.optional()
    })
    .describe('Double-click at image coordinates.'),
  z.object({ type: z.literal('move'), x: imageCoordinateArg, y: imageCoordinateArg }).describe('Move the pointer.'),
  z
    .object({ type: z.literal('drag'), path: z.array(pointArg).min(2).max(64), button: mouseButtonArg.optional() })
    .describe('Press, follow the path, release.'),
  z
    .object({
      type: z.literal('scroll'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      scroll_x: z.number().int().min(-10_000).max(10_000).optional(),
      scroll_y: z.number().int().min(-10_000).max(10_000).optional()
    })
    .describe('Scroll at a point.'),
  z.object({ type: z.literal('type'), text: z.string().max(4000) }).describe('Type text into whatever has focus.'),
  z
    .object({ type: z.literal('keypress'), keys: z.array(z.string().max(20)).min(1).max(6) })
    .describe('Press keys together, e.g. ["ctrl","s"].'),
  z.object({ type: z.literal('focus'), window: windowIdArg }).describe('Bring a window to the front.'),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000).optional() }).describe('Pause.'),
  z.object({ type: z.literal('read_clipboard') }).describe('Return the clipboard text.'),
  z
    .object({ type: z.literal('write_clipboard'), text: z.string().max(100_000) })
    .describe('Replace the clipboard text; pair with keypress ctrl+v to paste.')
]);

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;

  // ---------------------------------------------------------------- observe

  if (exposedCaps.screen) {
    reg.register(
      'observe',
      {
        title: 'Look at the desktop',
        description:
          'Look at Windows without touching it. Call it with no arguments first: that returns the foreground window, a screenshot of it and its UI Automation elements with refs. ' +
          'what=windows lists every visible window (filter with match); what=window inspects one window id; what=ui returns just the controls. ' +
          'wait_for waits until a window whose title matches appears, then reports it. ' +
          'Refs from here are what computer’s click_ref and set_value take, and they beat pixel coordinates because they resolve the real control again at action time. ' +
          'Coordinates in a screenshot are image pixels of that frame — pass the frame number back to computer with them. ' +
          'This never requires a window to be in front and never fails because something else has focus; if a window could not be brought forward, the reply says the picture may be covered.',
        inputSchema: z.object({
          what: z
            .enum(['active', 'windows', 'window', 'ui'])
            .optional()
            .describe('Default active: the foreground window, its screenshot and its controls.'),
          window: windowIdArg.optional().describe('Window id for what=window or what=ui.'),
          match: z.string().max(300).optional().describe('Filter: title/process for windows, control name/role for ui.'),
          wait_for: z.string().min(1).max(300).optional().describe('Wait until a window with this title substring exists.'),
          timeout_ms: z.number().int().min(0).max(60_000).optional().describe('With wait_for. Default 10000.'),
          screenshot: z.boolean().optional().describe('Include a picture. Default true for active and window.'),
          max_width: z
            .number()
            .int()
            .min(320)
            .max(MAX_SCREENSHOT_WIDTH)
            .optional()
            .describe(`Screenshot width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
          max_elements: z.number().int().min(1).max(100).optional().describe('Maximum controls returned. Default 60.')
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async (input) =>
        reg.guarded('screen', 'observe', async () => {
          // wait_for happens first and then answers the ordinary question about whatever it
          // found, so "wait for the installer, then look at it" is one call rather than a
          // wait followed by a second call that races the window closing again.
          let target = input.window;
          let waited: string | null = null;
          if (input.wait_for) {
            const found = await waitForWindow({
              title: input.wait_for,
              foreground: false,
              timeoutMs: input.timeout_ms
            });
            target = found.id;
            waited = `Found "${found.title}" (${found.process}) as window ${found.id}.`;
          }

          const what = input.wait_for ? (input.what ?? 'window') : (input.what ?? 'active');

          if (what === 'windows') {
            const { windows, screen } = await listWindows();
            const needle = input.match?.toLowerCase() ?? null;
            const shown = needle
              ? windows.filter(
                  (w) => w.title.toLowerCase().includes(needle) || w.process.toLowerCase().includes(needle)
                )
              : windows;
            noteCount(shown.length);
            logInfo(`tool observe windows (${shown.length}/${windows.length})`);
            if (shown.length === 0) return ok(prefix(waited, 'No visible windows match.'));
            const lines = shown.map(
              (w) => `${w.id}  ${w.process}  ${w.x},${w.y}  ${w.width}x${w.height}  ${w.state}  ${w.title}`
            );
            return ok(
              prefix(
                waited,
                `Desktop ${screen.width}x${screen.height}\nid  program  position  size  state  title\n${lines.join('\n')}`
              )
            );
          }

          if (what === 'ui' && input.match) {
            const result = await findUi({ window: target, query: input.match, maxResults: input.max_elements });
            noteCount(result.elements.length);
            if (result.elements.length === 0) {
              return ok(prefix(waited, `No controls in window ${result.window} match "${input.match}".`));
            }
            const lines = result.elements.map((element, index) => {
              const desktop = `${element.bounds.x},${element.bounds.y} ${element.bounds.width}x${element.bounds.height}`;
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const id = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              return `${index + 1}. ${element.ref} ${element.role} ${JSON.stringify(element.name)}${id} desktop=${desktop}${image}${flags}`;
            });
            return ok(prefix(waited, `window: ${result.window}\n${lines.join('\n')}`));
          }

          // A bare "what is on screen right now" with no window at all: cheapest possible
          // answer, and the only one that still works when there is no foreground window.
          if (what === 'active' && target === undefined && input.screenshot === false) {
            const { window, screen } = await activeWindow();
            if (!window) return ok(prefix(waited, `Desktop ${screen.width}x${screen.height}\nNo foreground window.`));
            return ok(prefix(waited, describeWindow(window)));
          }

          const wantsShot = what === 'ui' ? false : input.screenshot !== false;
          let state: Awaited<ReturnType<typeof getWindowState>>;
          try {
            state = await getWindowState({
              window: target,
              maxWidth: input.max_width,
              maxElements: input.max_elements,
              includeScreenshot: wantsShot,
              includeUi: true
            });
          } catch (err) {
            // "There is no foreground window" is a real state of a Windows desktop — a
            // locked screen, a shell restart, everything minimised — and it is not a reason
            // to refuse to look. Fall back to the monitor, which is the honest answer.
            if (target !== undefined || !(err instanceof ComputerError)) throw err;
            const shot = await screenshot({ maxWidth: input.max_width });
            return {
              content: [
                {
                  type: 'text',
                  text: prefix(
                    waited,
                    `No foreground window, so this is the whole primary monitor.\nframe: ${shot.frameId}  ${shot.width}x${shot.height} — pass frameId ${shot.frameId} with any coordinates you read off it`
                  )
                } as ToolContent,
                { type: 'image', data: shot.data, mimeType: 'image/png' } as ToolContent
              ]
            };
          }
          noteCount(state.elements.length);
          logInfo(`tool observe ${what} window=${state.window.id} (${state.elements.length} controls)`);

          const lines = [
            `window: ${state.window.id}  ${state.window.process}  ${state.window.state}  ${state.window.title}`,
            `bounds: ${state.window.x},${state.window.y} ${state.window.width}x${state.window.height}`
          ];
          if (state.screenshot) {
            lines.push(
              `frame: ${state.screenshot.frameId}  ${state.screenshot.width}x${state.screenshot.height} — pass frameId ${state.screenshot.frameId} with any coordinates you read off it`
            );
            if (state.screenshot.focused === false) {
              // Said out loud rather than failed. The picture is still the best available
              // answer, and the model needs to know it may be looking at whatever is on top.
              lines.push(
                'note: this window did not come to the front, so the picture may show something covering it. computer action=focus can bring it forward before you act.'
              );
            }
          }
          if (state.elements.length > 0) {
            lines.push('controls:');
            for (const element of state.elements) {
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const automation = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              lines.push(`${element.ref}  ${element.role} ${JSON.stringify(element.name)}${automation}${image}${flags}`);
            }
          } else {
            lines.push('controls: none exposed by Windows UI Automation');
          }

          const text = prefix(waited, lines.join('\n'));
          if (!state.screenshot) return ok(text);
          return {
            content: [
              { type: 'text', text } as ToolContent,
              { type: 'image', data: state.screenshot.data, mimeType: 'image/png' } as ToolContent
            ]
          };
        })
    );
  }

  // --------------------------------------------------------------- computer

  // Clipboard access lives here too, so a user who granted only the clipboard still gets
  // it. The individual actions are checked against their own permission when they run.
  if (exposedCaps.control || exposedCaps.clipboardRead || exposedCaps.clipboardWrite) {
    reg.register(
      'computer',
      {
        title: 'Control mouse and keyboard',
        description:
          'Do things on the desktop, in order, in one call. Prefer click_ref and set_value with refs from observe; they resolve the real control again at action time, so they survive a window moving. ' +
          'Coordinates are pixels of a screenshot from observe — send frameId with them and the call is refused if the screen has been re-captured since. ' +
          'Batch the steps that belong together and set captureAfter to see the result. ' +
          'read_clipboard and write_clipboard also run here, in sequence with everything else, so text can be put on the clipboard and pasted in the same call.',
        inputSchema: z.object({
          actions: z.array(computerActionArg).min(1).max(20),
          frameId: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Frame the coordinates came from. Strongly recommended: STALE_FRAME if the screen changed since.'),
          captureAfter: z.boolean().optional().describe('Return a fresh screenshot after the actions. Default false.'),
          captureWindow: windowIdArg.optional().describe('With captureAfter: capture this window instead of the monitor.'),
          captureFull: z.boolean().optional().describe('With captureAfter: all monitors. Default false.'),
          captureMaxWidth: z
            .number()
            .int()
            .min(320)
            .max(MAX_SCREENSHOT_WIDTH)
            .optional()
            .describe(`With captureAfter: width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
          captureCrop: cropArg.optional().describe('With captureAfter: crop in the frame that was current before the actions.')
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ actions, frameId, captureAfter, captureWindow, captureFull, captureMaxWidth, captureCrop }) =>
        guard('computer', async () => {
          // Not reg.guarded: this tool covers two permissions. Pointer and keyboard steps
          // need "control", the clipboard steps need their own, and one blanket refusal
          // would hide which of them the user actually has to switch on.
          if (!caps.control && actions.some((a) => !a.type.endsWith('_clipboard'))) {
            return fail(
              'TOOL_DISABLED: mouse and keyboard control is disabled by the current ChatGPT Local Files permissions. ' +
                'Ask the user to enable "Control mouse and keyboard" in the app, then retry.'
            );
          }
          const parsed: Action[] = [];
          for (const a of actions) {
            switch (a.type) {
              case 'click_ref':
                parsed.push({ type: 'click_ref', ref: a.ref });
                break;
              case 'set_value':
                parsed.push({ type: 'set_value', ref: a.ref, text: a.text });
                break;
              case 'click':
              case 'double_click':
                parsed.push({ type: a.type, x: a.x, y: a.y, button: a.button });
                break;
              case 'move':
                parsed.push({ type: 'move', x: a.x, y: a.y });
                break;
              case 'scroll':
                parsed.push({ type: 'scroll', x: a.x, y: a.y, scroll_x: a.scroll_x, scroll_y: a.scroll_y });
                break;
              case 'drag':
                parsed.push({ type: 'drag', path: a.path, button: a.button });
                break;
              case 'type':
                parsed.push({ type: 'type', text: a.text });
                break;
              case 'keypress':
                parsed.push({ type: 'keypress', keys: a.keys });
                break;
              case 'focus':
                parsed.push({ type: 'focus', window: a.window });
                break;
              case 'wait':
                parsed.push({ type: 'wait', ms: a.ms });
                break;
              case 'read_clipboard':
                // Gated here rather than by leaving the variant out of the schema: the
                // schema is cached by ChatGPT, and a tool that quietly changes shape when
                // a checkbox moves is worse than one that says plainly it is switched off.
                if (!caps.clipboardRead) {
                  return fail('TOOL_DISABLED: read_clipboard needs the Read the clipboard permission.');
                }
                parsed.push({ type: 'read_clipboard' });
                break;
              case 'write_clipboard':
                if (!caps.clipboardWrite) {
                  return fail('TOOL_DISABLED: write_clipboard needs the Replace clipboard text permission.');
                }
                parsed.push({ type: 'write_clipboard', text: a.text });
                break;
            }
          }
          logInfo(`tool computer ${parsed.map((a) => a.type).join(', ')}`);
          noteDetail(parsed.map((a) => a.type).join(', '));
          if (captureAfter === true && !caps.screen) {
            return fail('TOOL_DISABLED: captureAfter needs the See the screen permission.');
          }
          // One lock, one operation: the picture that verifies these actions must be taken
          // before anyone else can touch the desktop.
          const result = await actAndCapture(parsed, {
            frameId,
            capture:
              captureAfter === true
                ? {
                    window: captureWindow,
                    full: captureFull,
                    maxWidth: captureMaxWidth,
                    crop: captureCrop,
                    preferActiveWindow: ctx.privacyScreenshots
                  }
                : undefined
          });
          const cursor = result.cursor;
          const pointer = cursor.image
            ? `Pointer image: ${cursor.image.x},${cursor.image.y} (frame ${cursor.frameId}, ${cursor.imageSize?.width}x${cursor.imageSize?.height}); desktop: ${cursor.screen.x},${cursor.screen.y}.`
            : `Pointer desktop: ${cursor.screen.x},${cursor.screen.y}. No screenshot frame is active.`;
          // Clipboard reads are the one action that returns something, so they are quoted
          // back in order rather than folded into the "Done:" line.
          const clipboard = result.clipboard
            .map((text, index) =>
              `Clipboard read ${index + 1}: ${text === '' ? '(empty)' : JSON.stringify(text)}`
            )
            .join('\n');
          const done = `Done: ${parsed.map((a) => a.type).join(', ')}. ${pointer}${clipboard ? `\n${clipboard}` : ''}`;
          const shot = result.screenshot;
          if (shot) {
            return {
              content: [
                {
                  type: 'text',
                  text: `${done}\nCaptured frame ${shot.frameId}, ${shot.width}x${shot.height}. Use this frame for the next coordinates.`
                } as ToolContent,
                { type: 'image', data: shot.data, mimeType: 'image/png' } as ToolContent
              ]
            };
          }
          return ok(done);
        })
    );
  }
}

function prefix(note: string | null, body: string): string {
  return note ? `${note}\n\n${body}` : body;
}

function describeWindow(window: {
  id: number;
  process: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: string;
}): string {
  return (
    `window: ${window.id}\nprocess: ${window.process}\ntitle: ${window.title}\n` +
    `bounds: ${window.x},${window.y} ${window.width}x${window.height}\nstate: ${window.state}`
  );
}
