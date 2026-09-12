import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../extension/usage.js', import.meta.url), 'utf8');

function harness() {
  const posts: Array<Record<string, unknown>> = [];
  let response: unknown;
  const listeners = new Map<string, Array<{ handler: (event: unknown) => void; once: boolean }>>();
  const document = { readyState: 'loading' };
  const window = {
    fetch: (..._args: unknown[]) => Promise.resolve(response),
    postMessage: (data: unknown) => posts.push(JSON.parse(JSON.stringify(data))),
    addEventListener: (type: string, handler: (event: unknown) => void, options?: { once?: boolean }) => {
      const rows = listeners.get(type) ?? [];
      rows.push({ handler, once: options?.once === true });
      listeners.set(type, rows);
    }
  };
  const dispatch = (type: string, event: unknown) => {
    const rows = listeners.get(type) ?? [];
    listeners.set(type, rows.filter((row) => !row.once));
    for (const row of rows) row.handler(event);
  };

  runInNewContext(script, {
    window,
    document,
    location: { origin: 'https://chatgpt.com' },
    URL,
    Date,
    TextDecoder,
    setTimeout,
    clearTimeout
  });

  async function feedSse(
    chunks: string[],
    init: Record<string, unknown> = { method: 'POST' },
    url = 'https://chatgpt.com/backend-api/conversation'
  ) {
    let done: () => void = () => {};
    const inspected = new Promise<void>((resolve) => { done = resolve; });
    let at = 0;
    response = {
      url,
      ok: true,
      headers: { get: () => 'text/event-stream; charset=utf-8' },
      clone: () => ({ body: { getReader: () => ({
        read: async () => at < chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks[at++]!) }
          : { done: true },
        cancel: async () => { done(); }
      }) } })
    };
    const returned = await window.fetch('/backend-api/conversation', init);
    expect(returned).toBe(response);
    if (
      String(init.method || 'GET').toUpperCase() === 'POST' &&
      new URL(url).origin === 'https://chatgpt.com' &&
      /^\/backend-api\/(?:f\/)?conversation$/.test(new URL(url).pathname)
    ) {
      await inspected;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    posts,
    feedSse,
    replaceFetch: (wrapExisting = false) => {
      const previous = window.fetch;
      const replacement = (...args: unknown[]) => wrapExisting ? previous(...args) : Promise.resolve(response);
      window.fetch = replacement;
      return replacement;
    },
    ready: () => {
      document.readyState = 'interactive';
      dispatch('DOMContentLoaded', {});
    },
    currentFetch: () => window.fetch
  };
}

describe('MAIN-world exact request-origin observation', () => {
  it('publishes an exact conversation/request pair from a chunked live response without prompt bytes', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_`,
      'id":"wfr_early_exact"},"content":{"parts":["private prompt and tool args"]}}}\n\n',
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_early_exact"}}}\n\n`,
      `data: {"conversation_id":"${conversationId}","message":{"metadata":{"request_id":"wfr_second"}}}\n\n`
    ]);

    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_early_exact'], observedAt: expect.any(Number) },
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_second'], observedAt: expect.any(Number) }
    ]);
    expect(JSON.stringify(h.posts)).not.toContain('private prompt');
    expect(JSON.stringify(h.posts)).not.toContain('tool args');
  });

  it('reattaches after the page replaces fetch at DOM ready', async () => {
    const h = harness();
    const replacement = h.replaceFetch();
    expect(h.currentFetch()).toBe(replacement);
    h.ready();
    expect(h.currentFetch()).not.toBe(replacement);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_after_runtime_wrap"}}\n\n`]);
    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_after_runtime_wrap'], observedAt: expect.any(Number) }
    ]);
  });

  it('preserves a page wrapper that delegates to the earlier observer without duplicate inspection', async () => {
    const h = harness();
    h.replaceFetch(true);
    h.ready();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([`data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_nested_wrapper"}}\n\n`]);
    expect(h.posts).toEqual([
      { type: 'cos-request-origin', conversationId, requestIds: ['wfr_nested_wrapper'], observedAt: expect.any(Number) }
    ]);
  });

  it('supports f/conversation and bounds request ids to sixteen per stream', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse(
      Array.from({ length: 20 }, (_, i) =>
        'data: ' + JSON.stringify({ conversation_id: conversationId, message: { metadata: { request_id: `wfr_limit_${i}` } } }) + '\r\n\r\n'
      ),
      { method: 'POST' },
      'https://chatgpt.com/backend-api/f/conversation'
    );
    expect(h.posts).toHaveLength(16);
  });

  it('does not turn quoted text, tool arguments or cross-event identifiers into ownership', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    for (const event of [
      { conversation_id: conversationId, tool_arguments: { request_id: 'wfr_argument' } },
      { conversation_id: conversationId, message: { content: { parts: ['{"request_id":"wfr_quoted"}'] } } },
      { conversation_id: conversationId },
      { metadata: { request_id: 'wfr_separate_event' } }
    ]) {
      await h.feedSse(['data: ' + JSON.stringify(event) + '\n\n']);
    }
    await h.feedSse(
      ['data: ' + JSON.stringify({ conversation_id: conversationId, metadata: { request_id: 'wfr_foreign' } }) + '\n\n'],
      { method: 'POST' },
      'https://example.com/backend-api/conversation'
    );
    expect(h.posts).toEqual([]);
  });

  it('ignores non-POST, malformed and contradictory stream identity', async () => {
    const h = harness();
    const a = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const b = '11111111-2222-4333-8444-555555555555';
    await h.feedSse([`data: {"conversation_id":"${a}","metadata":{"request_id":"wfr_get"}}\n\n`], { method: 'GET' });
    await h.feedSse([`data: {"conversation_id":"${a}","metadata":{"request_id":"not-a-workflow"}}\n\n`]);
    await h.feedSse([`data: {"conversation_id":"${a}","nested":{"conversation_id":"${b}"},"metadata":{"request_id":"wfr_conflict"}}\n\n`]);
    expect(h.posts).toEqual([]);
  });

  it('rejects an oversized incomplete event and an oversized total stream', async () => {
    const h = harness();
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await h.feedSse([`data: ${'x'.repeat(513 * 1024)}`]);
    await h.feedSse([
      'x'.repeat(4 * 1024 * 1024),
      `data: {"conversation_id":"${conversationId}","metadata":{"request_id":"wfr_too_late"}}\n\n`
    ]);
    expect(h.posts).toEqual([]);
  });
});
