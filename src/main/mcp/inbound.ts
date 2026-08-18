import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The id ChatGPT puts on the HTTP request that carries a tool call.
 *
 * Measured live: the connector request arrives with `x-request-id: wfr_<id>/<suffix>`, and
 * the same `wfr_<id>` is what the page's own message model holds as `metadata.request_id`
 * on the request behind the call. That makes it a deterministic join between a call and the
 * conversation that issued it — no window, no ordering, and no coin toss when two workers
 * call the same tool at the same moment.
 *
 * It has to be carried out of band because the MCP server's own call context does not
 * expose the request headers: live, `mcpCtx.http.headers` is null while the header is
 * plainly there on the socket. So the surface's request handler runs inside this store and
 * the tool dispatch reads it back.
 */
const store = new AsyncLocalStorage<string | null>();

/** Runs `body` with the request id of the HTTP request currently being served. */
export function withInboundRequestId<T>(requestId: string | null, body: () => T): T {
  return store.run(requestId, body);
}

/** The request id of the HTTP request this call is being served on, if it had one. */
export function inboundRequestId(): string | null {
  return store.getStore() ?? null;
}

/**
 * The join key inside a raw header value.
 *
 * Only the part before the `/` matches the page: the suffix is per-hop and differs between
 * the header and the message model.
 */
export function requestIdFromHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const id = raw.split('/')[0]!.trim();
  return id.length > 0 && id.length <= 100 && /^[a-z0-9_-]+$/i.test(id) ? id : null;
}
