/** Types shared between the main process and the renderer. No runtime logic here. */

/**
 * One capability per user-facing checkbox. Tools are only registered on the MCP
 * server when their capability is enabled, so a disabled capability is invisible
 * to the model rather than merely refused.
 */
export const CAPABILITIES = [
  'browse',
  'search',
  'read',
  'metadata',
  'create',
  'edit',
  'move',
  'deleteFile',
  'deleteFolder',
  'powershell',
  'command',
  'screen',
  'control',
  'clipboardRead',
  'clipboardWrite'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Capabilities that change something outside this app — files on disk, code that
 * runs, or the desktop itself. Blocked outright by read-only mode.
 *
 * `screen` is not here: looking at the screen changes nothing. `control` is, because
 * driving the mouse and keyboard can do anything the user can.
 */
export const WRITE_CAPABILITIES: readonly Capability[] = [
  'create',
  'edit',
  'move',
  'deleteFile',
  'deleteFolder',
  'powershell',
  'command',
  'control',
  'clipboardWrite'
];

export type Capabilities = Record<Capability, boolean>;

export interface Root {
  /** Virtual name exposed to the model, e.g. "project" for /project. */
  name: string;
  /** Absolute Windows path. Never sent to the model. */
  path: string;
}

export type TunnelKind = 'openai' | 'cloudflared' | 'manual';

export interface TunnelSettings {
  kind: TunnelKind;
  /** OpenAI tunnel id, format tunnel_<32 hex>. Not a secret. */
  tunnelId: string;
  /** Optional explicit path to tunnel-client.exe / cloudflared.exe. */
  binaryPath: string;
}

export interface UiPrefs {
  minimizeToTray: boolean;
  autoConnect: boolean;
  /** Default screenshots to the active window instead of the whole primary monitor. */
  privacyScreenshots: boolean;
  /** Explicit choice, never inherited from Windows: the window looks how you left it. */
  theme: 'light' | 'dark';
}

/**
 * Session recording. Off by default, because unlike the diagnostics log this one
 * writes what happened to disk and keeps it.
 *
 * The same switch starts the local bridge the Chrome extension talks to: recording
 * without the extension only sees our own tool calls, and the extension has nothing
 * to report to if nothing is recording.
 */
export interface SessionSettings {
  record: boolean;
  /** Days of history kept. 0 keeps everything. */
  retainDays: number;
  /** Estimated tokens at which the app starts suggesting a compaction. */
  advisoryTokens: number;
  /** Estimated tokens at which that suggestion becomes urgent. */
  limitTokens: number;
}

export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CompactionSettings {
  /** OpenRouter model id. Empty means "resolve the default at first use". */
  model: string;
  reasoning: ReasoningLevel;
  /** Show the model's reasoning stream separately while it works. */
  showReasoning: boolean;
}

/**
 * Experimental multi-agent mode. Disabled by default and deliberately hard to turn on
 * by accident: several ChatGPT tabs driving the same filesystem is a real risk.
 */
export interface MultiAgentSettings {
  enabled: boolean;
  /** Upper bound on workers the prime agent may create. */
  maxWorkers: number;
}

export interface Config {
  roots: Root[];
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: TunnelSettings;
  ui: UiPrefs;
  sessions: SessionSettings;
  compaction: CompactionSettings;
  multiAgent: MultiAgentSettings;
}

export type ConnectionState =
  | 'disconnected'
  | 'starting-server'
  | 'connecting-tunnel'
  | 'connected'
  /** Server and tunnel are up, but this PC currently cannot reach OpenAI. */
  | 'offline'
  | 'auth-failed'
  | 'tunnel-unavailable';

/**
 * What the tunnel program reports about itself, refreshed on the same 15s tick that
 * decides connected-vs-offline. Every field is null when it could not be read, so the
 * UI can say "unknown" instead of inventing a number.
 */
export interface TunnelHealth {
  /** Failed control-plane polls since the tunnel started. */
  pollErrors: number | null;
  uptimeSeconds: number | null;
  /** Where and how it reaches OpenAI, e.g. "api.openai.com · direct". */
  route: string | null;
  /** Whether the tunnel can reach our own local server: "ok" or a failure word. */
  probe: string | null;
  clientVersion: string | null;
}

export interface ConnectionStatus {
  state: ConnectionState;
  /** Short human-readable explanation, safe to display. Never contains secrets. */
  detail: string;
  /** Public URL to paste into ChatGPT, for the cloudflared/manual paths only. */
  publicUrl: string | null;
  /** Loopback URL of the local MCP endpoint, shown for the manual path. */
  localUrl: string | null;
  /**
   * Epoch ms of the last round trip to OpenAI the tunnel actually completed, or null
   * when nothing has been proven yet. This is what separates "we think we are
   * connected" from "we know we were connected N seconds ago".
   */
  handshakeAt: number | null;
  /** Epoch ms of the last request ChatGPT sent to this app, end-to-end proof. */
  lastRequestAt: number | null;
  /**
   * Epoch ms of the last tool ChatGPT actually ran. Requests arriving with no tool
   * call ever following is the signature of Developer mode being off in ChatGPT.
   */
  lastToolCallAt: number | null;
  /** The tunnel's own view of itself, or null when no tunnel is running. */
  health: TunnelHealth | null;
}

/** One link in the chain from ChatGPT to this PC, as reported by the self-test. */
export interface Check {
  name: string;
  /** true = working, false = broken, null = cannot tell / not applicable. */
  ok: boolean | null;
  detail: string;
}

export interface Diagnosis {
  checks: Check[];
  /** One-line verdict for the top of the UI. */
  summary: string;
}

export interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Agent that caused this line, in multi-agent mode only. Absent otherwise. */
  agent?: string;
}

/** What the renderer needs to know about the extension bridge, without any secrets. */
export interface BridgeStatus {
  running: boolean;
  port: number | null;
  /** True once a browser extension has paired with this app. */
  paired: boolean;
  /** Epoch ms of the last message from the extension, or null. */
  lastSeenAt: number | null;
  /** Pairing code while one is being shown, else null. Short-lived and single-use. */
  pairingCode: string | null;
  pairingExpiresAt: number | null;
}

export interface AppState {
  config: Config;
  status: ConnectionStatus;
  /** True when an OpenAI control-plane API key is stored. The key itself never leaves the main process. */
  hasApiKey: boolean;
  /** True when an OpenRouter key is stored, for compaction. Also never leaves main. */
  hasOpenRouterKey: boolean;
  /** Resolved path of the tunnel binary we would run, or null if we cannot find one. */
  resolvedBinary: string | null;
  /** Version of the tunnel-client copy shipped inside the app, for diagnostics. */
  bundledTunnelVersion: string | null;
  bridge: BridgeStatus;
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  browse: true,
  search: true,
  read: true,
  metadata: true,
  create: false,
  edit: false,
  move: false,
  deleteFile: false,
  deleteFolder: false,
  powershell: false,
  command: false,
  screen: false,
  control: false,
  clipboardRead: false,
  clipboardWrite: false
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  browse: 'Browse folders',
  search: 'Search files',
  read: 'Read files',
  metadata: 'File metadata',
  create: 'Create files and folders',
  edit: 'Edit files',
  move: 'Move / rename',
  deleteFile: 'Delete files',
  deleteFolder: 'Delete folders',
  powershell: 'Run PowerShell',
  command: 'Run executable / command',
  screen: 'See the screen',
  control: 'Control mouse and keyboard',
  clipboardRead: 'Read clipboard',
  clipboardWrite: 'Write clipboard'
};

/** One line per capability, shown under its checkbox when the group is expanded. */
export const CAPABILITY_DETAILS: Record<Capability, string> = {
  browse: 'list_directory — see what is inside an approved folder, optionally recursively.',
  search: 'search_files — find files by name, or find text inside them.',
  read: 'read_file, read_files, view_image — read text in bounded ranges/batches or load a local PNG/JPEG/GIF/WebP directly into vision.',
  metadata: 'file_info — size, dates, line count, and optional SHA-256 for one path or a small batch.',
  create: 'create_file, create_directory, write_binary_file — make new text/binary files and folders.',
  edit: 'edit_file, edit_files, write_file, append_file, write_binary_file — exact edits can be applied to one file or preflighted across several files.',
  move: 'move_path — move or rename, both ends inside approved folders.',
  deleteFile: 'delete_file — permanent, with no Recycle Bin.',
  deleteFolder: 'delete_directory — permanent; an approved root itself is refused.',
  powershell:
    'run_powershell — starts in an approved folder, but the script runs as you and is NOT sandboxed to that folder.',
  command:
    'run_command, launch_app, process, open_url — run things as you; process manages long-running jobs with bounded cursor-based output, stdin and lifecycle control. Processes are NOT sandboxed to the approved folder.',
  screen:
    'screenshot, list_windows, get_active_window, find_ui, wait_for_window — see and crop the screen, inspect focus, find semantic Windows controls, and wait for UI state without blind sleeps.',
  control: 'computer — moves the pointer, clicks, types and presses keys, as you.',
  clipboardRead: 'read_clipboard — read current clipboard text. Separate because clipboard contents may be sensitive.',
  clipboardWrite: 'write_clipboard — replace clipboard text without needing focus, clicks or keystrokes.'
};
