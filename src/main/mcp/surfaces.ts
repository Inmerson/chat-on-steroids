/**
 * The model-facing surfaces this app publishes, and what each one is for.
 *
 * ChatGPT connects to one MCP server per connector, and the *whole* of that server's
 * tool list is one discovery unit: `api_tool.list_resources(paths=["Name"])` with no
 * query returns every schema the server advertises. A query narrows it, but nothing
 * guarantees the harness will ask a narrow one, so the honest planning number for a
 * surface is its complete tools/list — not the subset a lucky query would return.
 *
 * That is the entire reason this file exists. Splitting into separate servers is the
 * only mechanism that actually bounds the worst case, because a separate server is a
 * separate discovery boundary that no query can cross.
 *
 * It is deliberately not a splitting free-for-all. Every extra surface is another
 * connector the user has to create, name, describe and keep connected, and on the
 * OpenAI tunnel it is another tunnel id as well (see `docs/tool-surface.md` §6.4).
 * A surface has to earn that. The test applied here is: a distinct capability boundary
 * the user already thinks in, plus enough schema weight that folding it into Core
 * would meaningfully raise Core's no-query cost.
 *
 * Two surfaces pass that test today.
 */

import type { Capabilities } from '../../shared/types.js';

export const SURFACE_IDS = ['core', 'desktop'] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

/**
 * Brand shown to the user and pasted into ChatGPT.
 *
 * One constant because it appears in the MCP server name, the suggested connector
 * name and the setup cards, and those three drifting apart is how a user ends up with
 * a connector whose name does not match the thing the instructions told them to type.
 */
export const CONNECTOR_BRAND = 'Steromi (Chat On Steroids)';

export interface SurfaceDefinition {
  id: SurfaceId;
  /** MCP server name. Stable; ChatGPT keys its cached metadata off it. */
  serverName: string;
  /**
   * Exactly what the user should type as the connector name in ChatGPT.
   *
   * Offered as copyable text rather than described, because the name is also the
   * retrieval handle: `paths=["…"]` is matched against it, and a user who invents
   * "my pc" gets a surface the model cannot address by name.
   */
  connectorName: string;
  /**
   * Exactly what the user should paste as the connector description.
   *
   * This is the single most load-bearing string in the whole design. Before any
   * discovery has happened the model holds the server name and this sentence and
   * nothing else, and it decides from them alone whether to pull this surface's
   * schemas at all. So it is written as vocabulary, not as prose: the words a person
   * would actually use for the work live in here, because a query that misses is
   * indistinguishable to the model from a capability that does not exist.
   */
  description: string;
  /** Short line for the setup card, in the app's own voice. */
  cardSummary: string;
  /**
   * Whether the app is usable without it. Core is required; Desktop is opt-in and
   * most sessions never want it.
   */
  required: boolean;
  /**
   * Every tool this surface can ever advertise, in listing order.
   *
   * The authority for tests, for the setup UI's "what you get" list, and for the
   * cross-surface leakage assertions. A tool that appears here and nowhere else is a
   * bug in one direction; a tool registered on a server that does not name it here is
   * a bug in the other.
   */
  tools: readonly string[];
}

/**
 * Core — the coding loop.
 *
 * `session` and `agents` live here rather than on surfaces of their own, and that is a
 * decision with a concrete reason rather than a tidiness preference:
 *
 *  - `session` is how a chat reaches the recording of its own work — the exact error, the
 *    arguments of a call made an hour ago, the detail a compacted brief had to leave out.
 *    That is part of the coding loop rather than an extra, and a chat that had to ask the
 *    user to connect something before it could look up what it already did would be worse
 *    than one that simply guessed.
 *  - `agents` is one flat tool and is registered only while multi-agent mode is on.
 *    Fresh installs enable it; an existing config that keeps it off still pays nothing for
 *    it here. A dedicated connector for one conditional schema is pure setup overhead with
 *    no discovery benefit.
 *
 * Core declares 8 possible tool names below, but at most 7 schemas are live at once. `find`
 * and the exec pair are mutually exclusive — `find` exists only when command execution is
 * off — so no runtime tools/list reaches all 8 declarations.
 */
const CORE: SurfaceDefinition = {
  id: 'core',
  serverName: 'chat-on-steroids-core',
  connectorName: `${CONNECTOR_BRAND} Core`,
  description:
    'Read and edit code and text files on this Windows PC, and run commands in a real terminal. ' +
    'Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, ' +
    'running builds, tests, linters, git, npm and PowerShell, and continuing long-running or interactive terminal sessions. ' +
    'Also resumes earlier work from a saved handoff brief, and — when the user has enabled it — spawns and coordinates ' +
    'worker agents, subagents or a parallel swarm across several ChatGPT conversations.',
  cardSummary: 'Files, patches and the terminal. Required — this is the coding connector.',
  required: true,
  tools: [
    'read',
    'view_image',
    'find',
    'apply_patch',
    'exec_command',
    'write_stdin',
    'session',
    'agents',
    'workspace_list',
    'workspace_read',
    'workspace_write',
    'shell_exec',
    'unity_find_editor',
    'unity_open_project',
    'unity_run_tests',
    'unity_build_android',
    'unity_export_ios',
    'git_status',
    'git_commit',
    'open_url',
    'web_fetch',
    'launch_app',
    'system_exec',
    'process_list',
    'process_kill',
    'fs_system_list',
    'fs_system_read',
    'fs_system_write',
    'notify_user',
    'memory_store',
    'memory_recall',
    'memory_list',
    'memory_forget',
    'task_start_background',
    'task_status',
    'task_kill',
    'browser_search',
    'browser_tab_list',
    'browser_tab_open',
    'browser_tab_focus',
    'browser_tab_read',
    'browser_tab_click',
    'browser_tab_fill',
    'browser_tab_screenshot',
    'code_find_definition',
    'code_find_references',
    'code_outline_symbols',
    'code_get_diagnostics',
    'browser_network_inspect',
    'browser_cookies_get',
    'browser_evaluate_js'
  ]
};

/**
 * Desktop — seeing and driving Windows itself.
 *
 * This one earns its boundary twice over. It is gated on permissions the user grants
 * separately and can switch off independently; its two schemas are the largest we publish, since
 * `computer` alone carries eleven action variants; and the majority of coding sessions
 * never touch the desktop at all. Folding it into Core would put its weight into every
 * no-query discovery of the coding surface, for a capability most conversations do not
 * want.
 */
const DESKTOP: SurfaceDefinition = {
  id: 'desktop',
  serverName: 'chat-on-steroids-desktop',
  connectorName: `${CONNECTOR_BRAND} Desktop`,
  description:
    'See and control this Windows desktop, browser, and full system applications, clipboard, workspaces, Unity and Git. ' +
    'Use for: taking a screenshot, reading what is on screen, listing and finding windows, inspecting buttons, fields and other UI controls, ' +
    'clicking, typing, pressing keys, scrolling and dragging in any Windows application, ' +
    'opening URLs in browser, live Chrome tab automation, web search, network inspection, code intelligence, launching any app, running background tasks and PowerShell/CMD commands, ' +
    'managing persistent memory, sending Windows notifications, and automating tasks across Windows.',
  cardSummary:
    'Full Windows system control: browser tabs, code intelligence, apps, background tasks, memory, shell commands, screenshots and GUI automation.',
  required: false,
  tools: [
    'observe',
    'computer',
    'workspace_list',
    'workspace_read',
    'workspace_write',
    'shell_exec',
    'unity_find_editor',
    'unity_open_project',
    'unity_run_tests',
    'unity_build_android',
    'unity_export_ios',
    'git_status',
    'git_commit',
    'open_url',
    'web_fetch',
    'launch_app',
    'system_exec',
    'process_list',
    'process_kill',
    'fs_system_list',
    'fs_system_read',
    'fs_system_write',
    'notify_user',
    'memory_store',
    'memory_recall',
    'memory_list',
    'memory_forget',
    'task_start_background',
    'task_status',
    'task_kill',
    'browser_search',
    'browser_tab_list',
    'browser_tab_open',
    'browser_tab_focus',
    'browser_tab_read',
    'browser_tab_click',
    'browser_tab_fill',
    'browser_tab_screenshot',
    'code_find_definition',
    'code_find_references',
    'code_outline_symbols',
    'code_get_diagnostics',
    'browser_network_inspect',
    'browser_cookies_get',
    'browser_evaluate_js'
  ]
};

export const SURFACES: Record<SurfaceId, SurfaceDefinition> = { core: CORE, desktop: DESKTOP };

export const SURFACE_LIST: readonly SurfaceDefinition[] = [CORE, DESKTOP];

export function surfaceDefinition(id: SurfaceId): SurfaceDefinition {
  return SURFACES[id];
}

/**
 * Whether a surface has anything to offer under these capabilities.
 *
 * Desktop with neither `screen` nor `control` would advertise an empty tool list,
 * which is worse than not being offered: the user pays the whole setup cost for a
 * connector that can do nothing, and ChatGPT shows them a working connection. The
 * setup UI uses this to grey the card out and say why.
 *
 * Core is always meaningful. Even with every capability off it still carries `read`
 * and `find`, and `read` is what the app is for.
 */
export function surfaceIsUseful(id: SurfaceId, caps: Capabilities): boolean {
  // Clipboard counts: it is reached through `computer`, so granting only the clipboard
  // still gives this surface something real to advertise.
  if (id === 'desktop') return caps.screen || caps.control || caps.clipboardRead || caps.clipboardWrite;
  return true;
}

/** Surfaces worth connecting under these capabilities, in setup order. */
export function usefulSurfaces(caps: Capabilities): SurfaceDefinition[] {
  return SURFACE_LIST.filter((surface) => surfaceIsUseful(surface.id, caps));
}
