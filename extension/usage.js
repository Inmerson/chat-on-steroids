/**
 * Passive, bounded exact request-origin observation in ChatGPT's MAIN world.
 *
 * This helper never reads request headers, cookies, credentials, request bodies, prompt text,
 * or tool arguments. It observes only the exact conversation/request identifiers ChatGPT puts
 * in complete live SSE events, then projects that bounded pair to the isolated recorder.
 */
(() => {
  'use strict';
  if (window.__cosUsageObserver) return;
  window.__cosUsageObserver = true;

  const post = window.postMessage.bind(window);
  const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REQUEST = /^wfr_[a-zA-Z0-9_-]{1,96}$/;
  const CONVERSATION_FIELD = /(?:^|[,{\s])\"conversation_id\"\s*:\s*\"([0-9a-f-]{36})\"/gi;

  async function inspectRequestOrigins(response, observedAt) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;

    const copy = response.clone();
    const reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 90_000);
    const decoder = new TextDecoder();
    const emitted = new Set();
    let bytes = 0;
    let buffer = '';

    const scan = (frame) => {
      if (!frame || frame.length > 512 * 1024) return;
      const conversations = new Set();
      CONVERSATION_FIELD.lastIndex = 0;
      for (let match; (match = CONVERSATION_FIELD.exec(frame));) {
        if (CONVERSATION.test(match[1])) conversations.add(match[1]);
      }
      // One complete event must carry both sides of the join. A contradictory event abstains.
      if (conversations.size !== 1) return;
      const conversationId = conversations.values().next().value;

      let event;
      try {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (event?.conversation_id !== conversationId) return;

      // Request identity is admitted only from server metadata, never arbitrary nested text.
      const requestIds = new Set([event.metadata?.request_id, event.message?.metadata?.request_id]
        .filter((id) => typeof id === 'string' && REQUEST.test(id)));
      const fresh = [...requestIds].filter((id) => !emitted.has(id)).slice(0, 16 - emitted.size);
      if (fresh.length === 0) return;
      for (const id of fresh) emitted.add(id);
      post({ type: 'cos-request-origin', conversationId, requestIds: fresh, observedAt }, location.origin);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          scan(buffer.slice(0, split));
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > 512 * 1024) return;
      }
      buffer += decoder.decode();
      scan(buffer);
    } catch {
      // Missing response evidence simply leaves the existing Fiber path in charge.
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
  }

  let observedFetch = null;
  const inspectedResponses = new WeakSet();
  const installFetchObserver = () => {
    if (window.fetch === observedFetch || typeof window.fetch !== 'function') return;
    // Capture the current downstream wrapper per installation. A page wrapper may delegate to
    // our previous observer, so a shared mutable pointer would recurse after reattachment.
    const downstreamFetch = window.fetch;
    observedFetch = function (...args) {
      const observedAt = Date.now();
      const result = downstreamFetch.apply(this, args);
      void result.then((response) => {
        if (inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        let method = 'GET';
        try {
          const explicit = args[1] && typeof args[1].method === 'string' ? args[1].method : null;
          const inherited = args[0] && typeof args[0] === 'object' && typeof args[0].method === 'string'
            ? args[0].method
            : null;
          method = String(explicit || inherited || 'GET').toUpperCase();
        } catch {
          return;
        }
        if (method === 'POST') void inspectRequestOrigins(response, observedAt).catch(() => {});
      }).catch(() => {});
      return result;
    };
    window.fetch = observedFetch;
  };

  installFetchObserver();
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installFetchObserver, { once: true });
  }
})();
