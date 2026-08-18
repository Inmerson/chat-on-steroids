/** Types shared between the main process and the renderer. No runtime logic here. */

/**
 * One capability per user-facing checkbox. Tools are only registered on the MCP
 * server when their capability is enabled, so a disabled capability is invisible
 * to the model rather than merely refused.
 */
/*
 * Two permissions were removed when the tools were consolidated, because no tool could
 * honour them any more and a checkbox that grants nothing — or worse, less than its
 * label promises — is a lie about the security boundary:
 *
 * - `powershell` and `command` were one tool each. `exec_command` replaced both, and it
 *   runs PowerShell by default, so leaving the pair in place meant "Run executable" was
 *   silently also "Run PowerShell" while the PowerShell checkbox granted nothing at all.
 *   One permission for running commands is what the single tool can actually enforce.
 * - `deleteFolder` had no implementation left: `apply_patch` deletes files, and the patch
 *   format has no way to express removing a directory. Deleting a folder now needs
 *   `exec_command`, which is a permission the user grants deliberately.
 *
 * `config.ts` migrates both keys off existing configs; see the note there.
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
  /**
   * OpenAI tunnel id for the Core connector, format tunnel_<32 hex>. Not a secret.
   *
   * Named without a surface prefix because it predates the split and every existing
   * config on disk carries it; it is migrated to mean Core, which is what it always was.
   */
  tunnelId: string;
  /**
   * OpenAI tunnel id for the optional Desktop connector. Empty when the user has not set
   * one up, which is the normal case.
   *
   * A second id rather than a second channel on the first: `tunnel-client` really does
   * multiplex channels, but ChatGPT's connector UI addresses a tunnel id and normalises
   * everything to the `main` channel, so the extra channels are reachable only from Codex
   * and the API (`docs/tool-surface.md` §6.5). One id per connector is what actually works.
   */
  desktopTunnelId: string;
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
 * Session recording. On by default: unlike the diagnostics log this one writes what
 * happened to disk and keeps it, but the timeline, Compact & resume and the agent
 * features are all reads of that record, so an app with it off is an app with its
 * reason for existing switched off. It stays a switch, and an explicit `false` is
 * never overridden.
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

/**
 * Automatic Compact & Resume.
 *
 * The whole of it: whether it fires, and at what size. There is no provider to choose and
 * no model to configure, because there is one way a session is compacted — the chat writes
 * its own brief and the app moves the session to a fresh chat carrying it.
 */
export interface CompactionSettings {
  /**
   * Compact without being asked, once a conversation grows past `autoTokens`.
   *
   * On, at the ceiling. Compaction ends the chat someone is working in and opens a fresh
   * one; that is the right trade when the alternative is hitting the ceiling mid-thought.
   */
  auto: boolean;
  /** Estimated recorded tokens at which automatic compaction fires. */
  autoTokens: number;
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
  /**
   * One entry per model-facing connector, in setup order.
   *
   * This app publishes more than one MCP server — a required coding connector and an
   * optional desktop one — and the user has to create each in ChatGPT by hand. So the
   * status carries everything that setup needs as data rather than as prose the user has
   * to reconstruct: the exact name to type, the exact description to paste, the URL, and
   * whether that particular connector is currently live.
   */
  surfaces: SurfaceStatus[];
}

/** The identifiers of the connectors this app publishes. Mirrors `mcp/surfaces.ts`. */
export type SurfaceId = 'core' | 'desktop';

export interface SurfaceStatus {
  id: SurfaceId;
  /** Exactly what the user should name the connector in ChatGPT. */
  connectorName: string;
  /** Exactly what the user should paste as its description. */
  description: string;
  /** One line in the app's own voice, for the setup card. */
  cardSummary: string;
  /** False for a connector the app cannot work without. */
  optional: boolean;
  /**
   * Whether this connector can do anything under the current permissions. A Desktop
   * connector with neither screen nor control access would advertise an empty tool list,
   * which is worse for the user than not being offered at all.
   */
  available: boolean;
  /** Loopback URL of this surface's MCP endpoint, or null when the server is stopped. */
  localUrl: string | null;
  /** Public URL to paste into ChatGPT, when the transport in use produces one. */
  publicUrl: string | null;
  /** Tools this connector will advertise right now. */
  tools: string[];
  state: SurfaceConnectionState;
  /** Short human-readable explanation. Never contains secrets. */
  detail: string;
  /**
   * When ChatGPT last reached *this* connector, and last ran one of its tools.
   *
   * `state` is only ever our side of the wire — whether we published it. These two are the
   * other side: proof the user really created this connector in ChatGPT and that the model
   * is allowed to call it. With an optional second connector the difference matters, since
   * a healthy Core says nothing about whether Desktop was ever added.
   */
  lastRequestAt: number | null;
  lastToolCallAt: number | null;
}

export type SurfaceConnectionState =
  /** Not being published: unavailable, or optional and not configured. */
  | 'off'
  | 'starting'
  | 'live'
  | 'error';

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
  /** True once a browser extension has been issued this app's token. */
  paired: boolean;
  /** Epoch ms of the last message from the extension, or null. */
  lastSeenAt: number | null;
}

export interface AppState {
  config: Config;
  status: ConnectionStatus;
  /** True when an OpenAI control-plane API key is stored. The key itself never leaves the main process. */
  hasApiKey: boolean;
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
  create: 'Create files',
  edit: 'Edit files',
  move: 'Move / rename',
  deleteFile: 'Delete files',
  command: 'Run commands',
  screen: 'See the screen',
  control: 'Control mouse and keyboard',
  clipboardRead: 'Read clipboard',
  clipboardWrite: 'Write clipboard'
};

/** One line per capability, shown under its checkbox when the group is expanded. */
export const CAPABILITY_DETAILS: Record<Capability, string> = {
  browse: 'read — list what is inside an approved folder.',
  search: 'read, find — expand globs, and find files by name or text inside them.',
  read: 'read — read text in bounded ranges, several files at once, and load a local PNG/JPEG/GIF/WebP straight into vision.',
  metadata: 'read — size, dates and line count for a path, without returning its contents.',
  create: 'apply_patch — add new files, creating any parent folders they need. An empty folder on its own needs Run commands.',
  edit: 'apply_patch — exact edits, applied atomically across as many files as one change touches.',
  move: 'apply_patch — move or rename, both ends inside approved folders.',
  deleteFile: 'apply_patch — permanent, with no Recycle Bin. Deleting a whole folder needs Run commands.',
  command:
    'exec_command, write_stdin — PowerShell or cmd: run builds, tests, git and anything else as you, and keep long-running or interactive sessions going. Commands are NOT sandboxed to the approved folder.',
  screen:
    'observe — screenshots, the window list, and the buttons, fields and other controls on screen, without needing anything in front.',
  control: 'computer — moves the pointer, clicks, types, scrolls and presses keys, as you.',
  clipboardRead: 'computer — read current clipboard text. Separate because clipboard contents may be sensitive.',
  clipboardWrite: 'computer — replace clipboard text without needing focus, clicks or keystrokes.'
};
