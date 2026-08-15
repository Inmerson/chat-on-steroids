/**
 * The entire renderer-facing API.
 *
 * Each function maps to exactly one named IPC channel. No channel name is ever taken
 * from the caller, so the renderer cannot reach a handler that is not listed here, and
 * ipcRenderer itself is never exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, Capabilities, Config, Diagnosis, LogEntry } from '../shared/types.js';
import type {
  CompactionState,
  Handoff,
  OpenRouterModel,
  SessionEvent,
  SessionSummary,
  SwarmState,
  TokenPressure
} from '../shared/session.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;

export interface SettingsPatch {
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: Config['tunnel'];
  ui: Config['ui'];
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
}

export interface SessionList {
  sessions: SessionSummary[];
  activeId: string | null;
  pressure: Array<TokenPressure & { id: string }>;
}

export interface SessionDetail {
  summary: SessionSummary | null;
  events: SessionEvent[];
  total: number;
}

export interface ModelPage {
  total: number;
  offset: number;
  models: OpenRouterModel[];
}

const api = {
  getState: () => call<AppState>('state:get'),
  saveSettings: (patch: SettingsPatch) => call<AppState>('settings:save', patch),
  addRoot: () => call<AppState>('roots:add'),
  removeRoot: (name: string) => call<AppState>('roots:remove', { name }),
  renameRoot: (name: string, newName: string) => call<AppState>('roots:rename', { name, newName }),
  setApiKey: (value: string) => call<AppState>('secret:set', { value }),
  pickBinary: () => call<AppState>('binary:pick'),
  connect: () => call<AppState>('connection:connect'),
  disconnect: () => call<AppState>('connection:disconnect'),
  runDiagnostics: () => call<Diagnosis>('diagnostics:run'),
  getLog: () => call<LogEntry[]>('log:get'),
  getLogText: () => call<string>('log:text'),
  getLogJson: () => call<string>('log:json'),
  writeClipboard: (text: string) => call<boolean>('clipboard:write', { text }),
  openLink: (url: string) => call<boolean>('link:open', { url }),

  // Sessions, compaction and the browser bridge. Everything here is read-only or a
  // named action; there is still no channel that takes a path or a command.
  listSessions: () => call<SessionList>('sessions:list'),
  getSession: (id: string, options?: { from?: number; limit?: number }) =>
    call<SessionDetail>('sessions:events', { id, ...options }),
  deleteSession: (id: string) => call<boolean>('sessions:delete', { id }),
  getHandoff: (id: string, handoffId?: string) => call<Handoff | null>('handoff:get', { id, handoffId }),

  getCompaction: () => call<CompactionState>('compaction:state'),
  compact: (id: string, resume: boolean) => call<Handoff>('compaction:start', { id, resume }),
  cancelCompaction: () => call<boolean>('compaction:cancel'),
  clearCompaction: () => call<CompactionState>('compaction:clear'),

  setOpenRouterKey: (value: string) => call<AppState>('openrouter:key', { value }),
  listModels: (options?: { refresh?: boolean; offset?: number; limit?: number; query?: string }) =>
    call<ModelPage>('openrouter:models', options ?? {}),

  pairExtension: () => call<AppState>('bridge:pair'),
  cancelPairing: () => call<AppState>('bridge:cancelPairing'),
  unpairExtension: () => call<AppState>('bridge:unpair'),
  // The renderer can ask where the extension is and ask for it to be opened, but the
  // path it gets back is only ever displayed: the open happens in the main process
  // against a folder the renderer never chose.
  extensionPath: () => call<string | null>('bridge:extensionPath'),
  openExtensionFolder: () => call<string>('bridge:openExtensionFolder'),

  getSwarm: () => call<SwarmState>('swarm:get'),
  resetSwarm: () => call<SwarmState>('swarm:reset'),

  onStateChanged: (listener: (state: AppState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: AppState): void => listener(state);
    ipcRenderer.on('state:changed', wrapped);
    return () => ipcRenderer.removeListener('state:changed', wrapped);
  },
  onLogEntry: (listener: (entry: LogEntry) => void): (() => void) => {
    const wrapped = (_event: unknown, entry: LogEntry): void => listener(entry);
    ipcRenderer.on('log:entry', wrapped);
    return () => ipcRenderer.removeListener('log:entry', wrapped);
  },
  onSessionChanged: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('session:changed', wrapped);
    return () => ipcRenderer.removeListener('session:changed', wrapped);
  },
  onCompactionChanged: (listener: (state: CompactionState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: CompactionState): void => listener(state);
    ipcRenderer.on('compaction:changed', wrapped);
    return () => ipcRenderer.removeListener('compaction:changed', wrapped);
  },
  onSwarmChanged: (listener: (state: SwarmState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: SwarmState): void => listener(state);
    ipcRenderer.on('swarm:changed', wrapped);
    return () => ipcRenderer.removeListener('swarm:changed', wrapped);
  }
};

export type AppApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
