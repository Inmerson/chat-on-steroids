import { describe, expect, it } from 'vitest';
import { inboundRequestId, requestIdFromHeader, withInboundRequestId } from '../src/main/mcp/inbound.js';

describe('MCP inbound request id boundary', () => {
  it('normalizes the raw x-request-id to the page join key once at ingress', () => {
    expect(requestIdFromHeader('wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1')).toBe(
      'wfr_01a014bdd7cd7a15b6b533d3ce2b42f2'
    );
    expect(requestIdFromHeader('  wfr_abc_123/relay-hop')).toBe('wfr_abc_123');
    expect(requestIdFromHeader(['wfr_first/a', 'wfr_second/b'])).toBe('wfr_first');

    expect(requestIdFromHeader('/missing-base')).toBeNull();
    expect(requestIdFromHeader('wfr.bad/suffix')).toBeNull();
    expect(requestIdFromHeader('x'.repeat(101))).toBeNull();
    expect(requestIdFromHeader(undefined)).toBeNull();
  });

  it('keeps normalized ids isolated across concurrent async requests', async () => {
    const seen = await Promise.all([
      withInboundRequestId('wfr_a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return inboundRequestId();
      }),
      withInboundRequestId('wfr_b', async () => {
        await Promise.resolve();
        return inboundRequestId();
      })
    ]);

    expect(seen).toEqual(['wfr_a', 'wfr_b']);
    expect(inboundRequestId()).toBeNull();
  });
});
