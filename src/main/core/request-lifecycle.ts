import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logInfo } from '../logger.js';

export type RequestLifecyclePhase =
  | 'receivedByCore'
  | 'forwardedToLocalMcp'
  | 'localMcpCompleted'
  | 'responseSent';

export interface RequestLifecycle {
  requestId: string;
  connectionGeneration: number;
  receivedAt: number;
}

export interface RequestLifecycleFields {
  tool?: string;
  surface?: string;
  outcome?: 'ok' | 'rejected' | 'error';
  statusCode?: number;
}

export interface RequestLifecycleRecord extends RequestLifecycleFields {
  timestamp: string;
  component: 'core';
  event: 'tool-request-lifecycle';
  phase: RequestLifecyclePhase;
  requestId: string;
  connectionGeneration: number;
  corePid: number;
}

const store = new AsyncLocalStorage<RequestLifecycle>();
let generationProvider: () => number = () => 0;
let sink: (record: RequestLifecycleRecord) => void = (record) => {
  logInfo(`[core-request] ${JSON.stringify(record)}`);
};

export function setConnectionGenerationProvider(provider: () => number): void {
  generationProvider = provider;
}

/** Test seam; production leaves the structured app-log sink installed. */
export function setRequestLifecycleSink(next: (record: RequestLifecycleRecord) => void): void {
  sink = next;
}

export function createRequestLifecycle(externalRequestId: string | null, now = Date.now()): RequestLifecycle {
  return {
    requestId: externalRequestId ?? randomUUID(),
    connectionGeneration: generationProvider(),
    receivedAt: now
  };
}

export function withRequestLifecycle<T>(lifecycle: RequestLifecycle, body: () => T): T {
  return store.run(lifecycle, body);
}

export function currentRequestLifecycle(): RequestLifecycle | null {
  return store.getStore() ?? null;
}

/**
 * Emits only explicitly whitelisted metadata. There is intentionally no free-form object or
 * arguments field, so paths, command strings, file contents and tool payloads cannot accidentally
 * enter the connection diagnostic log through this API.
 */
export function logRequestPhase(
  lifecycle: RequestLifecycle,
  phase: RequestLifecyclePhase,
  fields: RequestLifecycleFields = {}
): void {
  sink({
    timestamp: new Date().toISOString(),
    component: 'core',
    event: 'tool-request-lifecycle',
    phase,
    requestId: lifecycle.requestId,
    connectionGeneration: lifecycle.connectionGeneration,
    corePid: process.pid,
    ...fields
  });
}
