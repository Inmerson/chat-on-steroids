/**
 * The local MCP endpoint.
 *
 * Bound to 127.0.0.1 on an ephemeral port, never 0.0.0.0, so nothing on the LAN can
 * reach it. Four independent checks run before any MCP handling:
 *   1. the request path must carry the per-session secret token
 *   2. the Host header must be loopback (DNS rebinding protection)
 *   3. a present Origin header must be loopback (a browser cannot drive this endpoint)
 *   4. the body must be within a sane size
 *
 * The MCP handler is built per request from live config, so toggling a permission in
 * the UI takes effect on the very next call without restarting anything.
 *
 * Two things here exist purely because of what talks to this server. tunnel-client
 * runs OAuth discovery (RFC 9728) against it on every start and decodes whatever
 * comes back as JSON without looking at the status code, so this server answers the
 * protected-resource metadata request properly and never emits a non-JSON body.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { getConfig } from '../config.js';
import { logError, logInfo, logWarn } from '../logger.js';
import { buildServer, resetToolClock, type ToolContext } from './tools.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface McpEndpoint {
  port: number;
  /** Full loopback URL including the secret path segment. */
  url: string;
  stop: () => Promise<void>;
}

/** RFC 9728 §3.1: the metadata for a resource at /x lives at /.well-known/…/x. */
const PRM_PREFIX = '/.well-known/oauth-protected-resource';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Everything that is not the MCP endpoint answers with JSON.
 *
 * The reason is not tidiness. tunnel-client's OAuth discovery decodes the body of
 * these probes as JSON whatever the status code is, so a plain-text "Not found"
 * surfaced as `invalid character 'N' looking for beginning of value` and left the
 * client's OAuth state permanently in a failed state.
 */
function jsonError(res: http.ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * RFC 9728 protected resource metadata.
 *
 * This server is not protected by OAuth — the unguessable path token is what
 * authorises a caller — so the document names the resource and lists no
 * authorization server. That is the truthful "no OAuth here" answer, and it is what
 * stops a client from either failing discovery or trying to start an OAuth flow.
 *
 * It is served only at the token-qualified URL. Anyone who can form that URL already
 * knows the token, so the `resource` field gives nothing away; serving it at the bare
 * /.well-known root would hand the token to any local process that asked.
 */
function protectedResourceMetadata(resource: string): string {
  return JSON.stringify({
    resource,
    resource_name: 'ChatGPT Local Files',
    authorization_servers: [],
    scopes_supported: []
  });
}

/**
 * When ChatGPT last actually reached this app, epoch ms.
 *
 * This is the only end-to-end proof that exists: the tunnel can be up and OpenAI
 * reachable while ChatGPT still refuses to call the connector, and only a request
 * landing here distinguishes those two.
 */
let requestSeenAt: number | null = null;

export function lastRequestAt(): number | null {
  return requestSeenAt;
}

/**
 * Lets the self-test call this server without being mistaken for ChatGPT.
 *
 * The self-test drives the loopback endpoint over real HTTP, so without this it would
 * set the clock above and turn the one honest end-to-end signal into a green light
 * this app switched on itself. The value is random per session and never leaves the
 * process, so nothing outside can claim to be the self-test.
 */
const SELF_TEST_HEADER = 'x-local-self-test';
const TUNNEL_PROBE_HEADER = 'x-local-tunnel-probe';
let selfTestToken = randomBytes(16).toString('hex');
let tunnelProbeToken = randomBytes(16).toString('hex');

export function selfTestHeaders(): Record<string, string> {
  return { [SELF_TEST_HEADER]: selfTestToken };
}

/** Header injected only into tunnel-client's own discovery/startup probes. */
export function tunnelProbeHeaders(): Record<string, string> {
  return { [TUNNEL_PROBE_HEADER]: tunnelProbeToken };
}

/**
 * Starts the local MCP server.
 *
 * `getContext` is called on every request so that roots and capabilities are read
 * fresh; nothing about the permission state is captured at startup.
 */
export async function startMcpServer(getContext: () => ToolContext): Promise<McpEndpoint> {
  // A per-session token in the path is what authorises callers. It is regenerated on
  // every app start, so a URL that leaks stops working when the app restarts.
  requestSeenAt = null;
  resetToolClock();
  selfTestToken = randomBytes(16).toString('hex');
  tunnelProbeToken = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('base64url');
  const basePath = `/mcp/${token}`;
  const prmPath = `${PRM_PREFIX}${basePath}`;

  // ChatGPT can keep a cached tools/list snapshot for the lifetime of a connector
  // session. If a permission is disabled after that snapshot was loaded, removing the
  // tool immediately makes the old snapshot call an unknown tool and some clients
  // surface that as a transport-level UNKNOWN/TaskGroup failure. Keep the exposed
  // surface monotonic for this local endpoint instead: newly enabled tools appear,
  // previously exposed tools remain registered, and their handlers return the clear
  // TOOL_DISABLED result while the live capability is off. A fresh app/server start
  // resets the surface to the permissions that are enabled at that point.
  let exposedCaps: ToolContext['caps'] | null = null;
  // The same rule applies to the two whole features — session recording and
  // multi-agent mode. They were derived live, so switching either off mid-conversation
  // deleted resume_session/session_history or the six agent tools from under a cached
  // snapshot and reproduced exactly the failure the monotonic design exists to avoid.
  let exposedSessionTools = false;
  let exposedAgentTools = false;
  const stableContext = (): ToolContext => {
    const live = getContext();
    if (exposedCaps === null) {
      exposedCaps = { ...live.caps };
    } else {
      for (const key of Object.keys(live.caps) as Array<keyof ToolContext['caps']>) {
        if (live.caps[key]) exposedCaps[key] = true;
      }
    }
    const config = getConfig();
    const sessionTools = live.sessionTools ?? config.sessions.record;
    const agentTools = live.agentTools ?? config.multiAgent.enabled;
    exposedSessionTools = exposedSessionTools || sessionTools;
    exposedAgentTools = exposedAgentTools || agentTools;
    return {
      ...live,
      sessionTools,
      agentTools,
      exposedCaps: { ...exposedCaps },
      exposedSessionTools,
      exposedAgentTools
    };
  };

  const handler = createMcpHandler(() => buildServer(stableContext()));
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => logError(`MCP handler error: ${error.message}`)
  });
  const checkHost = localhostHostValidation();
  const checkOrigin = localhostOriginValidation();

  let listeningUrl = '';

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0] ?? '';
    const selfTest = req.headers[SELF_TEST_HEADER] === selfTestToken;
    const tunnelProbe = req.headers[TUNNEL_PROBE_HEADER] === tunnelProbeToken;

    // Logged for every request, so the Activity tab shows what actually arrived and
    // what it was answered with. The path is reduced to a shape — it carries the
    // session token — and nothing from the body is logged.
    const startedAt = Date.now();
    res.on('finish', () => {
      const shape = safeEqual(pathOnly, basePath)
        ? 'mcp'
        : safeEqual(pathOnly, prmPath)
          ? 'oauth-metadata'
          : pathOnly.slice(0, 40);
      const method = req.method ?? '?';
      const who = selfTest ? ' (self-test)' : tunnelProbe ? ' (tunnel probe)' : '';
      const line = `${method} ${shape} → ${res.statusCode} in ${Date.now() - startedAt}ms${who}`;
      // Streamable HTTP makes the server-opened SSE stream and session deletion
      // optional, and 405 is the prescribed answer for a server that offers
      // neither. ChatGPT probes for both on every connect, so treating those two
      // as failures would put a pair of red lines in the log on a healthy
      // connection and bury the errors that do matter.
      const optional =
        res.statusCode === 405 && shape === 'mcp' && (method === 'GET' || method === 'DELETE');
      const expectedTunnelProbe = tunnelProbe && res.statusCode === 415 && shape === 'mcp' && method === 'POST';
      if (optional) logInfo(`request ${line} (stream/session not offered — normal)`);
      else if (expectedTunnelProbe) logInfo(`request ${line} (probe compatibility check — normal)`);
      else if (res.statusCode >= 400) logWarn(`request ${line}`);
      else logInfo(`request ${line}`);
    });

    if (safeEqual(pathOnly, prmPath)) {
      if (!checkHost(req, res)) return;
      if (!checkOrigin(req, res)) return;
      const body = protectedResourceMetadata(listeningUrl);
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }

    if (!safeEqual(pathOnly, basePath)) {
      jsonError(res, 404, 'not_found');
      return;
    }
    if (!checkHost(req, res)) return;
    if (!checkOrigin(req, res)) return;

    // Count only a validated request to the actual MCP endpoint. OAuth metadata,
    // 404s, our own self-test and tunnel-client's startup initialize probe are not
    // evidence that ChatGPT itself reached the connector.
    if (!selfTest && !tunnelProbe) requestSeenAt = Date.now();

    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      jsonError(res, 413, 'payload_too_large');
      return;
    }

    void nodeHandler(req, res);
  });

  // Reject slow or oversized bodies rather than holding sockets open indefinitely.
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.maxRequestsPerSocket = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine the local server port');
  }

  server.on('error', (err) => logError(`Local server error: ${err.message}`));
  logInfo(`server started on 127.0.0.1:${address.port}`);

  // Known only once the OS has handed us a port, and needed by the metadata document
  // as the canonical resource identifier.
  listeningUrl = `http://127.0.0.1:${address.port}${basePath}`;

  return {
    port: address.port,
    url: listeningUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          logInfo('server stopped');
          resolve();
        });
      })
  };
}
