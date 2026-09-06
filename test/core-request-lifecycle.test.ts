import { describe, expect, it, vi } from 'vitest';
import {
  createRequestLifecycle,
  logRequestPhase,
  setConnectionGenerationProvider,
  setRequestLifecycleSink
} from '../src/main/core/request-lifecycle.js';

describe('Core request lifecycle', () => {
  it('preserves ChatGPT request identity and captures the active connection generation', () => {
    setConnectionGenerationProvider(() => 27);
    const lifecycle = createRequestLifecycle('wfr_abc123');
    expect(lifecycle).toMatchObject({ requestId: 'wfr_abc123', connectionGeneration: 27 });
  });

  it('creates an internal unique request id when the relay supplied none', () => {
    setConnectionGenerationProvider(() => 4);
    const first = createRequestLifecycle(null);
    const second = createRequestLifecycle(null);
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('logs lifecycle phases without tool arguments or payloads', () => {
    const sink = vi.fn();
    setRequestLifecycleSink(sink);
    const lifecycle = { requestId: 'req-1', connectionGeneration: 9, receivedAt: 100 };

    logRequestPhase(lifecycle, 'receivedByCore', { tool: 'read', surface: 'core' });
    logRequestPhase(lifecycle, 'forwardedToLocalMcp', { tool: 'read' });
    logRequestPhase(lifecycle, 'localMcpCompleted', { tool: 'read', outcome: 'ok' });
    logRequestPhase(lifecycle, 'responseSent', { statusCode: 200 });

    expect(sink).toHaveBeenCalledTimes(4);
    const records = sink.mock.calls.map(([record]) => record as Record<string, unknown>);
    expect(records.map((record) => record.phase)).toEqual([
      'receivedByCore',
      'forwardedToLocalMcp',
      'localMcpCompleted',
      'responseSent'
    ]);
    expect(records.every((record) => record.connectionGeneration === 9 && record.requestId === 'req-1')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('arguments');
    expect(JSON.stringify(records)).not.toContain('payload');
  });
});
