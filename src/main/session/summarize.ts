/**
 * One tool call → one line a human can read.
 *
 * This is what replaces ChatGPT's wall of identical "Called tool" rows. It is a pure
 * function of the arguments we sent and the evidence the handler recorded, so it is
 * fully testable and never depends on scraping our own output back out of a page.
 *
 * Each tool gets the shape that suits it rather than one forced template: an edit
 * shows line counts, a search shows its query and hit count, a command shows how it
 * exited. When there is nothing worth saying, the tool name is still better than
 * "Called tool".
 */

import type { ActivitySummary, FileChange, ToolOutcome } from '../../shared/session.js';
import { formatDelta } from '../diffstat.js';
import type { CallEvidence } from '../mcp/call-context.js';

/** Drops the virtual root segment, which is the same on every line and adds nothing. */
export function shortPath(virtualPath: string): string {
  const parts = String(virtualPath ?? '').split('/').filter(Boolean);
  if (parts.length <= 1) return `/${parts.join('/')}`;
  return parts.slice(1).join('/');
}

function baseName(virtualPath: string): string {
  const parts = String(virtualPath ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? virtualPath;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Combined "+18 −4" across every file the call touched. */
function totalDelta(changes: readonly FileChange[]): string | null {
  if (changes.length === 0) return null;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const text = formatDelta({ added, removed });
  if (!text) return null;
  return changes.some((change) => change.approximate) ? `~${text}` : text;
}

function fileTitle(verb: string, changes: readonly FileChange[], fallback: string | null): string {
  if (changes.length === 1) return `${verb} ${shortPath(changes[0]!.path)}`;
  if (changes.length > 1) return `${verb} ${plural(changes.length, 'file')}`;
  return fallback ? `${verb} ${shortPath(fallback)}` : verb;
}

export interface SummaryInput {
  tool: string;
  args: unknown;
  evidence: CallEvidence;
  outcome: ToolOutcome;
  durationMs: number;
  /** First line of the result, used only where nothing better exists. */
  resultHead?: string;
}

/**
 * Builds the compact entry.
 *
 * A failed or refused call keeps the same subject but says so, because "Edited x.ts"
 * next to a red mark is far more useful when reading back a session than a generic
 * "tool error".
 */
export function summarizeToolCall(input: SummaryInput): ActivitySummary {
  const args = record(input.args);
  const evidence = input.evidence;
  const changes = evidence.changes;
  const summary = build(input.tool, args, evidence, changes, input);

  if (input.outcome === 'ok') return summary;
  const failed: ActivitySummary = {
    ...summary,
    tone: input.outcome === 'error' ? 'bad' : 'warn'
  };
  const head = (input.resultHead ?? '').trim();
  if (input.outcome === 'rejected') {
    failed.metric = 'refused';
  } else if (!failed.metric || !failed.metric.startsWith('✕')) {
    failed.metric = '✕ failed';
  }
  if (head && !failed.detail) failed.detail = head.slice(0, 120);
  return failed;
}

function build(
  tool: string,
  args: Record<string, unknown>,
  evidence: CallEvidence,
  changes: readonly FileChange[],
  input: SummaryInput
): ActivitySummary {
  const delta = totalDelta(changes);
  const path = str(args['path']);

  switch (tool) {
    // ------------------------------------------------------------- files
    case 'edit_file':
    case 'edit_files': {
      const fallback = path ?? (arr(args['files'])[0] ? str(record(arr(args['files'])[0])['path']) : null);
      return {
        kind: 'edit',
        tone: 'good',
        title: fileTitle('Edited', changes, fallback),
        ...(delta ? { metric: delta } : {})
      };
    }
    case 'write_file':
      return {
        kind: 'edit',
        tone: 'good',
        title: fileTitle('Rewrote', changes, path),
        ...(delta ? { metric: delta } : {})
      };
    case 'append_file':
      return {
        kind: 'edit',
        tone: 'good',
        title: fileTitle('Appended to', changes, path),
        ...(delta ? { metric: delta } : {})
      };
    case 'create_file':
      return {
        kind: 'create',
        tone: 'good',
        title: fileTitle('Created', changes, path),
        ...(delta ? { metric: delta } : {})
      };
    case 'create_directory':
      return { kind: 'create', tone: 'good', title: `Created folder ${shortPath(path ?? '')}` };
    case 'write_binary_file':
      return {
        kind: 'create',
        tone: 'good',
        title: `Wrote ${shortPath(path ?? '')}`,
        ...(evidence.detail ? { metric: evidence.detail } : {})
      };
    case 'move_path': {
      const from = str(args['from']);
      const to = str(args['to']);
      return {
        kind: 'move',
        tone: 'good',
        title: from && to ? `Moved ${baseName(from)} → ${shortPath(to)}` : 'Moved a file'
      };
    }
    case 'delete_file':
      return {
        kind: 'delete',
        tone: 'warn',
        title: `Deleted ${shortPath(path ?? '')}`,
        ...(delta ? { metric: delta } : {})
      };
    case 'delete_directory':
      return { kind: 'delete', tone: 'warn', title: `Deleted folder ${shortPath(path ?? '')}` };

    // ------------------------------------------------------------- reads
    case 'read_file': {
      const start = num(args['startLine']);
      const end = num(args['endLine']);
      const range = evidence.detail ?? (start && end ? `lines ${start}–${end}` : start ? `from line ${start}` : null);
      return {
        kind: 'read',
        tone: 'neutral',
        title: `Read ${shortPath(path ?? '')}`,
        ...(range ? { detail: range } : {})
      };
    }
    case 'read_files': {
      const files = arr(args['files']);
      const first = str(record(files[0])['path']);
      return {
        kind: 'read',
        tone: 'neutral',
        title: files.length === 1 && first ? `Read ${shortPath(first)}` : `Read ${plural(files.length, 'file')}`
      };
    }
    case 'view_image':
      return { kind: 'read', tone: 'neutral', title: `Viewed image ${baseName(path ?? '')}` };
    case 'file_info': {
      const paths = arr(args['paths']);
      const target = path ?? str(paths[0]);
      return {
        kind: 'read',
        tone: 'neutral',
        title:
          paths.length > 1
            ? `Inspected ${plural(paths.length, 'path')}`
            : `Inspected ${shortPath(target ?? '')}`
      };
    }
    case 'list_directory':
      return {
        kind: 'browse',
        tone: 'neutral',
        title: `Listed ${shortPath(path ?? '')}`,
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'entry', 'entries') } : {})
      };
    case 'search_files': {
      const query = str(args['query']) ?? '';
      const mode = str(args['mode']) ?? 'name';
      return {
        kind: 'search',
        tone: 'neutral',
        title: `Searched ${JSON.stringify(query.slice(0, 60))}`,
        detail:
          evidence.count !== null
            ? `${plural(evidence.count, 'match', 'matches')}${mode === 'content' ? ' in file contents' : ''}`
            : mode === 'content'
              ? 'in file contents'
              : 'by name'
      };
    }
    case 'list_roots':
      return { kind: 'browse', tone: 'neutral', title: 'Listed approved folders' };

    // ---------------------------------------------------------- commands
    case 'inspect_repo': {
      const action = str(args['action']) ?? 'status';
      const count = num(args['count']);
      const titles: Record<string, string> = {
        status: 'Checked Git status',
        head: 'Inspected repository HEAD',
        diff: args['staged'] === true ? 'Read staged Git diff' : 'Read Git diff',
        show: `Inspected Git ${str(args['ref']) ?? 'HEAD'}`,
        log: `Read Git log${count ? ` · ${count} commits` : ''}`
      };
      return { kind: 'read', tone: 'neutral', title: titles[action] ?? `Inspected Git ${action}` };
    }
    case 'run_command':
    case 'run_powershell': {
      const command =
        tool === 'run_powershell'
          ? 'PowerShell script'
          : [str(args['command']) ?? 'command', ...arr(args['args']).map((a) => String(a))].join(' ').slice(0, 70);
      const failed = evidence.timedOut || (evidence.exitCode !== null && evidence.exitCode !== 0);
      const took = evidence.durationMs ?? input.durationMs;
      return {
        kind: 'run',
        tone: failed ? 'bad' : 'good',
        title: failed ? `Command failed  ${command}` : `Ran ${command}`,
        metric: evidence.timedOut
          ? '✕ timed out'
          : failed
            ? `✕ exit ${evidence.exitCode}`
            : `✓ ${formatDuration(took)}`
      };
    }
    case 'launch_app':
      return { kind: 'run', tone: 'neutral', title: `Launched ${str(args['command']) ?? 'a program'}` };
    case 'process_status':
      return {
        kind: 'process',
        tone: 'neutral',
        title: str(args['id']) ? `Checked process ${str(args['id'])}` : 'Listed processes'
      };
    case 'process': {
      const action = str(args['action']) ?? 'status';
      const id = str(args['id']);
      const command = str(args['command']);
      const titles: Record<string, string> = {
        start: `Started process ${command ?? ''}`.trim(),
        status: id ? `Checked process ${id}` : 'Listed processes',
        write: `Wrote to process ${id ?? ''}`.trim(),
        stop: `Stopped process ${id ?? ''}`.trim()
      };
      return { kind: 'process', tone: 'neutral', title: titles[action] ?? `Process ${action}` };
    }
    case 'open_url': {
      const url = str(args['url']);
      let shown = url ?? '';
      try {
        if (url) shown = new URL(url).host;
      } catch {
        // Keep the raw string; the tool itself rejects anything that is not a URL.
      }
      return { kind: 'run', tone: 'neutral', title: `Opened ${shown}` };
    }

    // ------------------------------------------------------------ screen
    case 'screenshot':
      return {
        kind: 'screen',
        tone: 'neutral',
        title: 'Screenshot taken',
        ...(evidence.detail ? { detail: evidence.detail } : {})
      };
    case 'list_windows':
      return {
        kind: 'screen',
        tone: 'neutral',
        title: 'Listed open windows',
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'window') } : {})
      };
    case 'get_active_window':
      return { kind: 'screen', tone: 'neutral', title: 'Checked the active window' };
    case 'find_ui':
      return {
        kind: 'screen',
        tone: 'neutral',
        title: `Looked for ${JSON.stringify((str(args['query']) ?? str(args['role']) ?? '').slice(0, 40))}`,
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'match', 'matches') } : {})
      };
    case 'wait_for_window':
      return {
        kind: 'screen',
        tone: 'neutral',
        title: `Waited for ${str(args['title']) ?? str(args['process']) ?? 'a window'}`
      };
    case 'computer': {
      const actions = arr(args['actions']).map((a) => str(record(a)['type']) ?? '?');
      const kinds = [...new Set(actions)];
      const label: Record<string, string> = {
        click: 'Clicked',
        double_click: 'Double-clicked',
        move: 'Moved the pointer',
        drag: 'Dragged',
        scroll: 'Scrolled',
        type: 'Typed',
        keypress: 'Pressed keys',
        focus: 'Focused a window',
        wait: 'Waited'
      };
      const title =
        kinds.length === 1
          ? (label[kinds[0]!] ?? 'Acted on the desktop')
          : `${label[kinds[0]!] ?? 'Acted'} and ${kinds.length - 1} more`;
      return {
        kind: 'input',
        tone: 'neutral',
        title,
        ...(actions.length > 1 ? { detail: plural(actions.length, 'action') } : {})
      };
    }

    // --------------------------------------------------------- clipboard
    case 'read_clipboard':
      return { kind: 'clipboard', tone: 'neutral', title: 'Read the clipboard' };
    case 'write_clipboard':
      return { kind: 'clipboard', tone: 'neutral', title: 'Replaced the clipboard text' };

    // ----------------------------------------------------------- session
    case 'resume_session':
      return { kind: 'session', tone: 'good', title: 'Loaded the previous session brief' };
    case 'session_history': {
      const query = str(args['query']);
      const callId = str(args['callId']);
      const title = callId
        ? 'Opened one recorded tool call'
        : query
          ? `Searched session history ${JSON.stringify(query.slice(0, 40))}`
          : 'Read the session timeline';
      return {
        kind: 'session',
        tone: 'neutral',
        title,
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'entry', 'entries') } : {})
      };
    }

    // ------------------------------------------------------------ agents
    case 'create_agents':
      return {
        kind: 'agent',
        tone: 'good',
        title: `Created ${plural(arr(args['workers']).length, 'worker agent')}`
      };
    case 'join_agent':
      return { kind: 'agent', tone: 'good', title: 'Joined the agent swarm' };
    case 'send_agent_message':
      return { kind: 'agent', tone: 'neutral', title: `Messaged ${str(args['to']) ?? 'the prime agent'}` };
    case 'agent_inbox':
      return {
        kind: 'agent',
        tone: 'neutral',
        title: 'Checked the agent inbox',
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'message') } : {})
      };
    case 'agent_status':
      return { kind: 'agent', tone: 'neutral', title: 'Checked agent status' };
    case 'finish_agent':
      return { kind: 'agent', tone: 'good', title: 'Reported the finished task' };

    default:
      return { kind: 'other', tone: 'neutral', title: `Ran ${tool}` };
  }
}
