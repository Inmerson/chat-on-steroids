import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
  surface?: 'core' | 'desktop';
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
const byRequest = new WeakMap<IncomingMessage, RequestLifecycle>();
const forwarded = new WeakSet<RequestLifecycle>();
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
 * Called only after server.ts has accepted the tokenized MCP route and its Host/Origin/body
 * guards. The diagnostics-channel request-start hook captures the real arrival time/generation;
 * this boundary upgrades that pending request into model-facing work without ever inspecting or
 * logging its JSON payload.
 */
export function markCurrentMcpRequestForwarded(externalRequestId: string | null): void {
  const lifecycle = currentRequestLifecycle();
  if (!lifecycle || forwarded.has(lifecycle)) return;
  if (externalRequestId) lifecycle.requestId = externalRequestId;
  forwarded.add(lifecycle);
  const fields = lifecycle.surface ? { surface: lifecycle.surface } : {};
  logRequestPhase(lifecycle, 'receivedByCore', fields);
  logRequestPhase(lifecycle, 'forwardedToLocalMcp', fields);
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

interface HttpServerLifecycleMessage {
  request: IncomingMessage;
  response: ServerResponse;
}

function surfaceFromRequest(request: IncomingMessage): 'core' | 'desktop' | null {
  const pathname = (request.url ?? '').split('?', 1)[0] ?? '';
  if (pathname.startsWith('/mcp/core/')) return 'core';
  if (pathname.startsWith('/mcp/desktop/')) return 'desktop';
  return null;
}

/**
 * Node publishes these events at the actual HTTP lifecycle boundaries. Filtering by the public
 * route *shape* (never the secret suffix) keeps unrelated bridge/update HTTP traffic out. The
 * AsyncLocalStorage context entered at request.start flows into the app's request listener and
 * therefore into withInboundRequestId(), where validation has already succeeded.
 */
channel('http.server.request.start').subscribe((message) => {
  const { request } = message as HttpServerLifecycleMessage;
  const surface = surfaceFromRequest(request);
  if (!surface) return;
  const lifecycle = createRequestLifecycle(null);
  lifecycle.surface = surface;
  byRequest.set(request, lifecycle);
  store.enterWith(lifecycle);
});

channel('http.server.response.finish').subscribe((message) => {
  const { request, response } = message as HttpServerLifecycleMessage;
  const lifecycle = byRequest.get(request);
  if (!lifecycle) return;
  byRequest.delete(request);
  if (!forwarded.has(lifecycle)) return;

  const statusCode = response.statusCode;
  const outcome: RequestLifecycleFields['outcome'] = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'rejected' : 'ok';
  const fields = {
    ...(lifecycle.surface ? { surface: lifecycle.surface } : {}),
    outcome,
    statusCode
  };
  logRequestPhase(lifecycle, 'localMcpCompleted', fields);
  logRequestPhase(lifecycle, 'responseSent', fields);
});
