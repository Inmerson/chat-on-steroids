/**
 * The entire renderer-facing API.
 *
 * Each function maps to exactly one named IPC channel. No channel name is ever taken
 * from the caller, so the renderer cannot reach a handler that is not listed here, and
 * ipcRenderer itself is never exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, Capabilities, Config, Diagnosis, LogEntry } from '../shared/types.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;

export interface SettingsPatch {
  capabilities: Capabilities;
  readOnly: boolean;
  tunnel: Config['tunnel'];
  ui: Config['ui'];
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
  openLink: (url: string) => call<boolean>('link:open', { url }),

  onStateChanged: (listener: (state: AppState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: AppState): void => listener(state);
    ipcRenderer.on('state:changed', wrapped);
    return () => ipcRenderer.removeListener('state:changed', wrapped);
  },
  onLogEntry: (listener: (entry: LogEntry) => void): (() => void) => {
    const wrapped = (_event: unknown, entry: LogEntry): void => listener(entry);
    ipcRenderer.on('log:entry', wrapped);
    return () => ipcRenderer.removeListener('log:entry', wrapped);
  }
};

export type AppApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
