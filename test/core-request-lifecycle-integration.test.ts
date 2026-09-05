import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import {
  setConnectionGenerationProvider,
  setRequestLifecycleSink,
  type RequestLifecycleRecord
} from '../src/main/core/request-lifecycle.js';

let endpoint: McpEndpoint | null = null;

afterEach(async () => {
  if (endpoint) await endpoint.stop();
  endpoint = null;
});

function post(urlText: string, body: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(urlText);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end(body);
  });
}

describe('real MCP request lifecycle observability', () => {
  it('records the normalized request id and connection generation across the HTTP-to-MCP boundary', async () => {
    const records: RequestLifecycleRecord[] = [];
    setConnectionGenerationProvider(() => 37);
    setRequestLifecycleSink((record) => records.push(record));
    const ctx: ToolContext = {
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true,
      sessionTools: false,
      agentTools: false
    };
    endpoint = await startMcpServer(() => ctx);

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const status = await post(endpoint.urls.core, body, {
      'x-request-id': 'wfr_lifecycle_123/relay-hop'
    });

    expect(status).toBe(200);
    expect(records.map((record) => record.phase)).toEqual([
      'receivedByCore',
      'forwardedToLocalMcp',
      'localMcpCompleted',
      'responseSent'
    ]);
    expect(records.every((record) => record.requestId === 'wfr_lifecycle_123')).toBe(true);
    expect(records.every((record) => record.connectionGeneration === 37)).toBe(true);
    expect(records.every((record) => record.surface === 'core')).toBe(true);
  });
});
