/**
 * The model-facing surfaces this app publishes, and what each one is for.
 *
 * 1. Core: Files, patches and terminal coding loop.
 * 2. Desktop: Mouse, keyboard, screen and Windows controls.
 * 3. Steromi: The complete, all-in-one powerhouse with all 66+ tools together.
 */

import type { Capabilities } from '../../shared/types.js';

export const SURFACE_IDS = ['core', 'desktop', 'steromi'] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

export const CONNECTOR_BRAND = 'Chat On Steroids';

export interface SurfaceDefinition {
  id: SurfaceId;
  /** MCP server name. Stable; ChatGPT keys its cached metadata off it. */
  serverName: string;
  /** Exactly what the user should type as the connector name in ChatGPT. */
  connectorName: string;
  /** Exactly what the user should paste as the connector description. */
  description: string;
  /** Short line for the setup card, in the app's own voice. */
  cardSummary: string;
  /** Whether the app is usable without it. */
  required: boolean;
  /** Every tool this surface can ever advertise, in listing order. */
  tools: readonly string[];
}

const ALL_TOOLS: readonly string[] = [
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
  'browser_evaluate_js',
  'audio_speak_text',
  'audio_beep',
  'checkpoint_create',
  'checkpoint_list',
  'checkpoint_restore',
  'pdf_read_text',
  'markdown_to_html',
  'json_schema_validate',
  'clipboard_read',
  'clipboard_write',
  'system_env_get',
  'system_env_set',
  'fs_hash_file',
  'fs_zip_compress',
  'fs_zip_extract',
  'unity_read_editor_log'
];

/**
 * Core — the coding loop.
 */
const CORE: SurfaceDefinition = {
  id: 'core',
  serverName: 'chat-on-steroids-core',
  connectorName: 'Chat On Steroids Core',
  description:
    'Read and edit code and text files on this Windows PC, and run commands in a real terminal. ' +
    'Use for: opening and reading files, searching a repository, applying patches, creating, renaming and deleting files, ' +
    'running builds, tests, linters, git, npm and PowerShell, and continuing long-running or interactive terminal sessions. ' +
    'Also resumes earlier work from a saved handoff brief, and — when the user has enabled it — spawns and coordinates ' +
    'worker agents, subagents or a parallel swarm across several ChatGPT conversations.',
  cardSummary: 'Files, patches and the terminal. Required — this is the coding connector.',
  required: true,
  tools: ALL_TOOLS
};

/**
 * Desktop — seeing and driving Windows itself.
 */
const DESKTOP: SurfaceDefinition = {
  id: 'desktop',
  serverName: 'chat-on-steroids-desktop',
  connectorName: 'Chat On Steroids Desktop',
  description:
    'See and control this Windows desktop, browser, and full system applications, clipboard, workspaces, Unity and Git. ' +
    'Use for: taking a screenshot, reading what is on screen, listing and finding windows, inspecting buttons, fields and other UI controls, ' +
    'clicking, typing, pressing keys, scrolling and dragging in any Windows application, ' +
    'opening URLs in browser, live Chrome tab automation, web search, network inspection, code intelligence, launching any app, running background tasks and PowerShell/CMD commands, ' +
    'managing persistent memory, sending Windows notifications, voice audio, checkpoints, and automating tasks across Windows.',
  cardSummary:
    'Full Windows system control: browser tabs, code intelligence, apps, background tasks, memory, shell commands, screenshots and GUI automation.',
  required: false,
  tools: [
    'observe',
    'computer',
    ...ALL_TOOLS.filter((t) => !['apply_patch', 'exec_command', 'write_stdin', 'session', 'agents', 'read', 'view_image', 'find'].includes(t))
  ]
};

/**
 * Steromi — The ultimate All-in-One powerhouse connector.
 */
const STEROMI: SurfaceDefinition = {
  id: 'steromi',
  serverName: 'steromi-all-in-one',
  connectorName: 'Steromi (All-in-One)',
  description:
    'The complete, all-in-one autonomous AI powerhouse bridge for Windows. ' +
    'Combines full Windows desktop GUI control (mouse, keyboard, screenshots), code editing, LSP definitions & diagnostics, ' +
    'live Chrome tabs & semantic web automation, persistent memory, async background tasks, voice speech synthesis, ' +
    'project checkpoints & rollback, and Unity tooling in one single unified connector.',
  cardSummary: 'All-in-One Powerhouse: All 66+ tools, coding, LSP, voice, browser, and desktop control in a single connector.',
  required: false,
  tools: ['observe', 'computer', ...ALL_TOOLS]
};

export const SURFACES: Record<SurfaceId, SurfaceDefinition> = {
  core: CORE,
  desktop: DESKTOP,
  steromi: STEROMI
};

export const SURFACE_LIST: readonly SurfaceDefinition[] = [CORE, DESKTOP, STEROMI];

export function surfaceDefinition(id: SurfaceId): SurfaceDefinition {
  return SURFACES[id];
}

export function surfaceIsUseful(id: SurfaceId, caps: Capabilities): boolean {
  if (id === 'desktop') return caps.screen || caps.control || caps.clipboardRead || caps.clipboardWrite;
  return true;
}

export function usefulSurfaces(caps: Capabilities): SurfaceDefinition[] {
  return SURFACE_LIST.filter((surface) => surfaceIsUseful(surface.id, caps));
}
