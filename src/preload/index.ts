/**
 * The entire renderer-facing API.
 *
 * Each function maps to exactly one named IPC channel. No channel name is ever taken
 * from the caller, so the renderer cannot reach a handler that is not listed here, and
 * ipcRenderer itself is never exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, Capabilities, Config, Diagnosis, LogEntry } from '../shared/types.js';
import type { CoreHealthStatus } from '../shared/core-protocol.js';
import type { ControlCenterStatus } from '../shared/control-center.js';
import type {
  Handoff,
  SessionEvent,
  SessionSummary,
  ClearAgentResult,
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
  goal: Config['goal'];
}

export interface GoalModelPage {
  models: Array<{ id: string; name: string; created: number; contextLength: number }>;
  total: number;
}

export interface SessionList {
  sessions: SessionSummary[];
  activeId: string | null;
  pressure: Array<TokenPressure & { id: string }>;
  total: number;
  nextCursor: SessionListCursor | null;
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionDetail {
  summary: SessionSummary | null;
  events: SessionEvent[];
  total: number;
  nextFrom: number;
}

const api = {
  getState: () => call<AppState>('state:get'),
  getCoreHealth: () => call<CoreHealthStatus | null>('core:health'),
  saveSettings: (patch: SettingsPatch, base: SettingsPatch) => call<AppState>('settings:save', { patch, base }),
  addRoot: () => call<AppState>('roots:add'),
  removeRoot: (name: string) => call<AppState>('roots:remove', { name }),
  renameRoot: (name: string, newName: string) => call<AppState>('roots:rename', { name, newName }),
  toggleAllComputer: () => call<AppState>('roots:allComputer:toggle'),
  setApiKey: (value: string) => call<AppState>('secret:set', { value }),
  setGoalKey: (value: string) => call<AppState>('secret:set', { value, key: 'openRouterApiKey' }),
  listGoalModels: (offset: number) => call<GoalModelPage>('goal:models', { offset }),
  pickBinary: () => call<AppState>('binary:pick'),
  connect: () => call<AppState>('connection:connect'),
  disconnect: () => call<AppState>('connection:disconnect'),
  runDiagnostics: () => call<Diagnosis>('diagnostics:run'),
  getLog: () => call<LogEntry[]>('log:get'),
  getLogText: () => call<string>('log:text'),
  getLogJson: () => call<string>('log:json'),
  writeClipboard: (text: string) => call<boolean>('clipboard:write', { text }),
  openLink: (url: string) => call<boolean>('link:open', { url }),
  installUpdate: () => call<boolean>('update:install'),

  listSessions: (options?: { cursor?: SessionListCursor; limit?: number }) =>
    call<SessionList>('sessions:list', options ?? {}),
  getSession: (id: string, options?: { from?: number; limit?: number }) =>
    call<SessionDetail>('sessions:events', { id, ...options }),
  deleteSession: (id: string) => call<boolean>('sessions:delete', { id }),
  getHandoff: (id: string, handoffId?: string) => call<Handoff | null>('handoff:get', { id, handoffId }),

  unpairExtension: () => call<AppState>('bridge:unpair'),
  downloadExtension: () => call<boolean>('bridge:downloadExtension'),
  extensionPath: () => call<string | null>('bridge:extensionPath'),
  openExtensionFolder: () => call<string>('bridge:openExtensionFolder'),

  getControlCenter: () => call<ControlCenterStatus>('control-center:get'),

  getSwarm: () => call<SwarmState>('swarm:get'),
  resetSwarm: () => call<SwarmState>('swarm:reset'),
  clearAgent: (id: string) => call<ClearAgentResult>('swarm:clearAgent', id),

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
  onSwarmChanged: (listener: (state: SwarmState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: SwarmState): void => listener(state);
    ipcRenderer.on('swarm:changed', wrapped);
    return () => ipcRenderer.removeListener('swarm:changed', wrapped);
  }
};

export type AppApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
