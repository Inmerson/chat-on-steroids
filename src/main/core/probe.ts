const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface LocalMcpProbeResult {
  healthy: boolean;
  toolCount: number | null;
  latencyMs: number;
  detail: string;
}

export interface LocalMcpProbeOptions {
  fetchImpl?: typeof fetch;
  selfTestHeaders?: Record<string, string>;
  timeoutMs?: number;
  now?: () => number;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { message?: string };
}

function parseRpc(text: string): JsonRpcEnvelope | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcEnvelope;
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      return JSON.parse(line.slice(5).trim()) as JsonRpcEnvelope;
    } catch {
      // A Streamable HTTP SSE response may carry several event lines. Keep looking for JSON.
    }
  }
  return null;
}

async function rpcCall(
  url: string,
  id: number,
  method: string,
  params: unknown,
  options: Required<Pick<LocalMcpProbeOptions, 'fetchImpl' | 'timeoutMs'>> & Pick<LocalMcpProbeOptions, 'selfTestHeaders'>
): Promise<{ status: number; envelope: JsonRpcEnvelope | null; text: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs);
  timer.unref?.();
  try {
    const response = await options.fetchImpl(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(options.selfTestHeaders ?? {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    const text = await response.text();
    return { status: response.status, envelope: parseRpc(text), text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Proves the local execution data plane, not merely that a socket or tunnel is alive.
 *
 * The probe performs a real MCP initialize followed by tools/list through the same loopback
 * endpoint used by the remote tunnel. Callers should pass `selfTestHeaders()` so this internal
 * watchdog is not mistaken for ChatGPT activity by the request clocks.
 */
export async function probeLocalMcp(url: string, options: LocalMcpProbeOptions = {}): Promise<LocalMcpProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const latency = (): number => Math.max(0, now() - startedAt);

  const init = await rpcCall(
    url,
    1,
    'initialize',
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'core-health-probe', version: '1' }
    },
    { fetchImpl, timeoutMs, selfTestHeaders: options.selfTestHeaders }
  );
  if (init === null) {
    return { healthy: false, toolCount: null, latencyMs: latency(), detail: 'No answer from local MCP initialize.' };
  }
  if (init.status >= 400 || init.envelope?.error || init.envelope?.result === undefined) {
    return {
      healthy: false,
      toolCount: null,
      latencyMs: latency(),
      detail: `initialize failed: HTTP ${init.status} ${init.envelope?.error?.message ?? init.text.slice(0, 120)}`
    };
  }

  const list = await rpcCall(url, 2, 'tools/list', {}, { fetchImpl, timeoutMs, selfTestHeaders: options.selfTestHeaders });
  if (list === null) {
    return { healthy: false, toolCount: null, latencyMs: latency(), detail: 'No answer from local MCP tools/list.' };
  }
  const result = list.envelope?.result as { tools?: unknown } | undefined;
  if (list.status >= 400 || list.envelope?.error || !Array.isArray(result?.tools)) {
    return {
      healthy: false,
      toolCount: null,
      latencyMs: latency(),
      detail: `tools/list failed: HTTP ${list.status} ${list.envelope?.error?.message ?? list.text.slice(0, 120)}`
    };
  }

  return {
    healthy: true,
    toolCount: result.tools.length,
    latencyMs: latency(),
    detail: `tools/list succeeded with ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}.`
  };
}
