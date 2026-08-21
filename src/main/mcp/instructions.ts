/**
 * Server instructions shown to the model once, alongside the tool list.
 *
 * Kept short on purpose: this text is prepended to context on every conversation that uses
 * the connector, and the tool descriptions already carry the per-tool detail. It states
 * what exists and how to be efficient — it is not where security is enforced.
 *
 * Written per surface. Two connectors mean two of these, and each says only what its own
 * tools can do: telling the Core conversation about `computer` would be describing a tool
 * that server does not have, which is exactly the confusion the split exists to end.
 */

import { getConfig } from '../config.js';
import type { ToolContext } from './kernel.js';
import { surfaceDefinition, type SurfaceId } from './surfaces.js';

export function serverInstructions(ctx: ToolContext, surface: SurfaceId = 'core'): string {
  return surface === 'desktop' ? desktopInstructions(ctx) : coreInstructions(ctx);
}

function coreInstructions(ctx: ToolContext): string {
  const config = getConfig();
  const sessionTools = ctx.sessionTools ?? config.sessions.record;
  const agentTools = ctx.agentTools ?? config.multiAgent.enabled;
  const roots =
    ctx.roots.length === 0
      ? 'None yet — the user must approve a folder in the ChatGPT Local Files app.'
      : ctx.roots.map((r) => `/${r.name}`).join('  ');

  const mode = ctx.readOnly
    ? 'Read only. Nothing here can modify anything.'
    : 'Read/write for the tools that are listed. Anything not listed is switched off.';

  const lines = [
    'Local Windows coding bridge: read and change files in folders the user approved, and run commands on their PC.',
    '',
    `Roots: ${roots}`,
    `Mode: ${mode}`,
    '',
    // Roots used to be a tool of their own. They are one line of context, they change only
    // when the user changes them, and a tool call to learn them was a round trip every
    // conversation paid before it could do anything.
    'Paths are virtual, like /project/src/main.ts. Native Windows paths inside an approved folder are also accepted and normalized to the equivalent virtual path.',
    // Taught once here rather than in every tool description: it is one rule that holds
    // across read, find, exec_command and apply_patch alike, and repeating it per tool would
    // cost more context than the shorthand saves.
    'Once you use a full path, this chat remembers that project, and later paths may be relative to it: /project/src/main.ts, then src/other.ts. Use a full path again to move to another project. If a relative path is refused, this chat has no folder yet — use a full one.',
    'read takes several paths at once, lists a folder, expands globs and returns images — use one call, not five. Line ranges are the exception: start_line/end_line require exactly one path.',
    'Never send read’s line-number prefixes to apply_patch; they are display metadata, not file content.',
    'apply_patch is the only way to change files: it adds, updates, moves and deletes, and it is atomic across files.',
    'exec_command runs git, npm, builds, tests and anything else; a long-running one gives you a session_id to continue with write_stdin.',
    // The one exception to the virtual-path rule above, and the model has to be told: cmd
    // is a program, not a path, so it reaches the shell exactly as written.
    'exec_command’s workdir is virtual, but its cmd is not translated — set workdir and write paths inside the command relative to it.',
    'Output is capped. When a result says it was truncated, narrow the request instead of repeating it.'
  ];

  if (ctx.caps.screen || ctx.caps.control || ctx.caps.clipboardRead || ctx.caps.clipboardWrite) {
    lines.push(
      '',
      // Named rather than hinted at: the model can see this connector but not the other, and
      // "I cannot do that" is the wrong answer when the user only has to connect it.
      `Seeing and controlling the Windows desktop lives in a separate connector, "${surfaceDefinition('desktop').connectorName}".`,
      'If a task needs screenshots, windows, mouse/keyboard control or the clipboard and that connector is not available here, say so and ask the user to connect it.'
    );
  }

  lines.push(
    '',
    // This connector often runs long local tasks where silence looks like a stalled MCP.
    // Keep progress unusually visible, but do it in compact phase-level updates rather than
    // narrating every cheap read and wasting the context the connector is meant to save.
    'Keep the user visibly informed more than usual while you work. Before a meaningful tool run,',
    'say in one short line what you are doing. On longer work, send another short progress update',
    'after a few meaningful calls or when the phase changes; do not stay silent until the end.',
    'Report findings, changes, failures and plan changes immediately, and name the paths you modified.',
    'Batch routine reads and searches instead of narrating every trivial call.'
  );

  if (sessionTools) {
    lines.push(
      '',
      // A chat continuing compacted work is *opened* with the brief already in it, so there
      // is nothing to fetch and nothing to call first. What it may not know is that the
      // detail behind the brief is still on disk and can be asked for.
      'This app records the session locally. If a brief you were given is not specific enough — an exact error,',
      'the arguments of a call somebody made earlier, a path — call session action=history for a narrow slice of',
      'the recording rather than guessing or asking the user to repeat themselves.'
    );
  }

  if (agentTools) {
    lines.push(
      '',
      'Multi-agent mode is on. As the prime agent you may use agents action=spawn with one task each, then keep',
      'working; their messages are appended to your tool results as they arrive. Each worker sees its assigned',
      'task rather than this prime conversation, so delegation is part of the job: describe the assignment from',
      'the ground up with the project/location, objective, relevant subsystem/files and known facts, constraints,',
      'what may be changed, validation to run, and the expected handoff. Do not prefix tasks with boilerplate like',
      '“you have zero prior context”; make the actual task self-contained instead. Use agents action=message to',
      'steer an active worker. A finished worker is finished: give remaining work to a new one. Workers are already',
      'bound to their slot when opened; action=join is recovery-only for a lost binding. As a worker, message the',
      'prime with findings/decisions/blockers, keep working while replies are pending, and call action=finish only',
      'when done. Workers talk only to the prime agent, never to each other.'
    );
  }

  return lines.join('\n');
}

function desktopInstructions(ctx: ToolContext): string {
  const lines = [
    'Local Windows desktop control: look at this PC’s screen and windows, and drive its mouse and keyboard.',
    '',
    'observe first, then computer. A bare observe() returns the foreground window, a screenshot and its',
    'controls with refs; refs beat pixel coordinates because they resolve the real control again when acted on.',
    'observe never needs a window to be in front and never fails for lack of focus. Only computer does, and',
    'only for its focus action — so when something steals focus, look first and act on what you see.',
    'Coordinates are pixels of a screenshot frame. Send frameId with them so a click cannot land on a screen',
    'that has since changed. Batch the actions that belong together and use captureAfter to verify the result.',
    // Said here as well as in the schema: the clipboard is reached through computer rather
    // than through a tool of its own, and a model looking for a "clipboard" tool finds none.
    'The clipboard lives in computer too — read_clipboard and write_clipboard run in sequence with',
    'the other actions, so copying text in and pasting it with keypress ctrl+v is one call.',
    'Act only on what the user asked for and leave the rest of their desktop alone.'
  ];

  if (ctx.privacyScreenshots) {
    lines.push(
      '',
      'Privacy screenshots are on: captures default to the active window rather than the whole screen.'
    );
  }

  lines.push(
    '',
    `Files, patches and commands live in a separate connector, "${surfaceDefinition('core').connectorName}".`,
    'This one cannot read or change files. If a task needs that and it is not available here, say so.'
  );

  return lines.join('\n');
}
