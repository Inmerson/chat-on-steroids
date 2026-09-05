/**
 * Process-aware connection facade.
 *
 * The Core Host owns the real MCP endpoint/tunnel implementation in connection-local.ts.
 * Ordinary Electron UI mode is only a client of that host, so closing/restarting the UI cannot
 * tear down ChatGPT's execution plane. Keeping this module's public API stable lets tray, IPC and
 * renderer code migrate without each becoming a second source of process-lifecycle policy.
 */

import type { ConnectionStatus } from '../shared/types.js';
import type { CoreHealthStatus } from '../shared/core-protocol.js';
import * as local from './connection-local.js';
import { uiConnectionFacade } from './core/ui-connection.js';

const UI_CLIENT_MODE = process.env.COS_CORE_UI_CLIENT === '1';

function ui() {
  return uiConnectionFacade();
}

export function getStatus(): ConnectionStatus {
  return UI_CLIENT_MODE ? ui().getStatus() : local.getStatus();
}

export function onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
  return UI_CLIENT_MODE ? ui().onStatusChange(listener) : local.onStatusChange(listener);
}

export function getCoreHealth(): CoreHealthStatus | null {
  return UI_CLIENT_MODE ? ui().getCoreHealth() : null;
}

export function onCoreHealthChange(listener: (health: CoreHealthStatus | null) => void): () => void {
  return UI_CLIENT_MODE ? ui().onCoreHealthChange(listener) : () => undefined;
}

export function connect(): Promise<void> {
  return UI_CLIENT_MODE ? ui().connect() : local.connect();
}

export function disconnect(): Promise<void> {
  return UI_CLIENT_MODE ? ui().disconnect() : local.disconnect();
}

export function applySettings(): Promise<void> {
  return UI_CLIENT_MODE ? ui().applySettings() : local.applySettings();
}

/**
 * Final UI shutdown stops only the UI's local IPC polling. Core Host shutdown remains an explicit
 * Core/system/update operation and is never implied by Cmd+Q, renderer restart or main restart.
 */
export function shutdownConnection(): Promise<void> {
  return UI_CLIENT_MODE ? ui().shutdownConnection() : local.shutdownConnection();
}

export function tunnelHealthBase(): string | null {
  return UI_CLIENT_MODE ? ui().tunnelHealthBase() : local.tunnelHealthBase();
}

export function isServerRunning(): boolean {
  return UI_CLIENT_MODE ? ui().isServerRunning() : local.isServerRunning();
}
