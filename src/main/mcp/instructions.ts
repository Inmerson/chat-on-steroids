/**
 * Server instructions shown to the model once, alongside the tool list.
 *
 * Kept short on purpose: this text is prepended to context on every conversation that
 * uses the connector, and the tool descriptions already carry the per-tool detail.
 * It states what exists and how to be efficient — it is not where security is enforced.
 */

import { getConfig } from '../config.js';
import type { ToolContext } from './tools.js';

export function serverInstructions(ctx: ToolContext): string {
  const config = getConfig();
  const sessionTools = ctx.sessionTools ?? config.sessions.record;
  const agentTools = ctx.agentTools ?? config.multiAgent.enabled;
  const roots =
    ctx.roots.length === 0
      ? 'None yet — the user must approve a folder in the ChatGPT Local Files app.'
      : ctx.roots.map((r) => `/${r.name}`).join('  ');

  const mode = ctx.readOnly
    ? 'Read only. No tool here can modify anything.'
    : 'Read/write for the tools that are listed. Anything not listed is switched off.';

  const lines = [
    'Local Windows coding and computer-use bridge for folders the user approved over MCP.',
    '',
    `Roots: ${roots}`,
    `Mode: ${mode}`,
    '',
    'Paths are always virtual, like /project/src/main.ts. Real Windows paths are never accepted.',
    'Search before reading in bulk, and read large files with startLine/endLine rather than whole.',
    'Output is capped; when a result says it was truncated, narrow the request instead of retrying it.',
    'Use edit_files for coherent cross-file changes. Reuse process cursors so status returns only new logs.',
    'Prefer the narrow file/process/computer tools over PowerShell or shell workarounds whenever they fit the task.',
    '',
    // This connector often runs long local tasks where silence looks like a stalled MCP.
    // Keep progress unusually visible, but do it in compact phase-level updates rather than
    // narrating every cheap read/click and wasting the context the connector is meant to save.
    'Keep the user visibly informed more than usual while you work. Before a meaningful tool run,',
    'say in one short line what you are doing. On longer work, send another short progress update',
    'after a few meaningful calls or when the phase changes; do not stay silent until the end.',
    'Report useful findings, changes, failures and plan changes immediately, and name paths modified.',
    'Batch routine reads/searches/actions instead of narrating every trivial call.'
  ];

  if (sessionTools) {
    lines.push(
      '',
      // A resumed chat has no memory of the run it is continuing, so say plainly that
      // the brief exists and where the detail behind it lives.
      'If the user opens this chat to continue earlier work, call resume_session first: it returns a',
      'handoff brief written from the recorded session, in parts. Read every part before acting, then',
      'continue that work instead of restarting it. session_history returns the underlying recorded',
      'events of a session when the brief is not specific enough; ask it for a narrow slice, not everything.'
    );
  }

  if (agentTools) {
    lines.push(
      '',
      'Multi-agent mode is on. As the prime agent you may create_agents with one task each, then keep',
      'working; their messages are appended to your tool results as they arrive. As a worker, call',
      'join_agent to get your task, send_agent_message to report to the prime agent, and finish_agent',
      'when done. Workers talk only to the prime agent, never to each other.'
    );
  }

  if (ctx.caps.screen || ctx.caps.control) {
    lines.push(
      '',
      'You can also see and drive this Windows desktop. Take a screenshot before the first pointing',
      'action or whenever the screen may have changed unexpectedly. Batch coherent actions in one',
      'computer call and prefer captureAfter instead of a separate follow-up screenshot. Coordinates',
      'are pixels in the latest screenshot. Act only on what the user asked for and leave the rest alone.'
    );
  }

  return lines.join('\n');
}
