import { describe, expect, it } from 'vitest';
import { eventTokens, type SessionEvent } from '../src/shared/session.js';

describe('session context budget', () => {
  it('counts the original tool wire size after the inline recorder copy spills to an asset', () => {
    const event = {
      seq: 1,
      time: Date.now(),
      source: 'app',
      kind: 'tool_call',
      call: {
        callId: 'call-1',
        tool: 'system_exec',
        attribution: 'unattributed',
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed',
        args: { text: 'short inline args', truncated: true, chars: 40_000, assetId: 'args-asset' },
        result: { text: 'short inline result', truncated: true, chars: 2_000_000, assetId: 'result-asset' },
        outcome: 'ok',
        durationMs: 1,
        summary: { kind: 'run', tone: 'neutral', title: 'Ran a command' }
      }
    } as SessionEvent;

    expect(eventTokens(event)).toBe(
      Math.ceil(40_000 / 4) + Math.ceil(2_000_000 / 4) + Math.ceil('Ran a command'.length / 4)
    );
  });
});
