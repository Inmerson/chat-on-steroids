/**
 * A self-test that answers "where exactly is this broken", one hop at a time.
 *
 * The chain from ChatGPT to a file on this PC has four links, and a failure in any of
 * them looks identical from the outside — ChatGPT just says it cannot use the
 * connector. So each link is checked separately, in order, and reported as its own
 * line: the local MCP server, the tunnel process, the tunnel's route to OpenAI, and
 * whether ChatGPT has ever actually arrived here.
 *
 * Everything is loopback-only. Nothing is sent to OpenAI, and the results contain no
 * secrets: the session token in the local URL is never included.
 */

import { getStatus, isServerRunning, tunnelHealthBase } from './connection.js';

import { effectiveCapabilities, getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { lastRequestAt, selfTestHeaders } from './mcp/server.js';
import { lastToolCallAt } from './mcp/tools.js';
import { ago, POLL_FRESH_MS, readClientStatus, readPollHealth } from './tunnel/health.js';

import type { Check, Diagnosis } from '../shared/types.js';

async function fetchJson(
  url: string,
  body: unknown,
  timeoutMs = 5000
): Promise<{ status: number; json: unknown; text: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP servers may answer either way; accept both.
        accept: 'application/json, text/event-stream',
        // Identifies these as our own probes, so they are not counted as ChatGPT
        // having reached this app. Otherwise running the self-test would make the
        // one check that proves the connector works pass because of the self-test.
        ...selfTestHeaders()
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, json: parseRpc(text), text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts a plain JSON body or an SSE stream carrying one JSON-RPC message. */
export function parseRpc(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const PROTOCOL_VERSION = '2025-06-18';

/** Runs an initialize + tools/list against our own loopback endpoint. */
async function checkLocalServer(url: string): Promise<Check> {
  const init = await fetchJson(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'self-test', version: '1' }
    }
  });
  if (init === null) {
    return { name: 'Local server', ok: false, detail: 'No answer on the loopback address.' };
  }
  const initObj = init.json as { error?: { message?: string } } | null;
  if (init.status >= 400 || initObj?.error) {
    return {
      name: 'Local server',
      ok: false,
      detail: `initialize failed: HTTP ${init.status} ${initObj?.error?.message ?? init.text.slice(0, 120)}`
    };
  }

  const list = await fetchJson(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listObj = list?.json as
    | { result?: { tools?: Array<{ name?: string }> }; error?: { message?: string } }
    | null;
  const tools = listObj?.result?.tools;
  if (!Array.isArray(tools)) {
    return {
      name: 'Local server',
      ok: false,
      detail: `tools/list failed: ${listObj?.error?.message ?? `HTTP ${list?.status ?? 0}`}`
    };
  }
  const names = tools.map((t) => t.name).filter(Boolean);
  return {
    name: 'Local server',
    ok: true,
    detail: `Answers on loopback and offers ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
  };
}

async function probeText(url: string): Promise<{ status: number; body: string } | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    const res = await fetch(url, { signal: abort.signal });
    return { status: res.status, body: (await res.text()).trim().slice(0, 200) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tells apart "everything works" from the one failure that mimics it.
 *
 * When Developer mode is off in ChatGPT — and a ChatGPT update has been seen to switch
 * it off on its own — the connector still handshakes: this app is asked to initialize
 * and to list its tools, so every other check here goes green, while the model itself
 * is refused with FORBIDDEN and never calls a single tool. Requests arriving with no
 * tool call ever following is that exact fingerprint.
 *
 * It is not proof, because it also describes a connector nobody has used yet, so this
 * never reports a hard failure. It names the suspicion, which is the part that costs
 * an hour to work out from scratch.
 */
function developerMode(seen: number | null, called: number | null): Check {
  if (called !== null) {
    return {
      name: 'ChatGPT allowed to use the tools',
      ok: true,
      detail: `Yes — ChatGPT last ran a tool ${ago(called)}, so Developer mode is on and the whole chain works.`
    };
  }
  if (seen === null) {
    return {
      name: 'ChatGPT allowed to use the tools',
      ok: null,
      detail: 'Unknown — ChatGPT has not reached this app at all yet, so there is nothing to judge.'
    };
  }
  return {
    name: 'ChatGPT allowed to use the tools',
    ok: null,
    detail:
      'Cannot tell — ChatGPT connected and read the tool list, but has never run a tool. ' +
      'That is normal if you have not asked it to do anything yet. If you have asked and it ' +
      'answered “does not support developer MCPs”, the cause is on ChatGPT’s side: turn ' +
      'Developer mode back on in ChatGPT → Settings → Apps & Connectors → Advanced. It can ' +
      'switch itself off after a ChatGPT update.'
  };
}

export async function runDiagnostics(): Promise<Diagnosis> {
  const checks: Check[] = [];
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  const status = getStatus();

  // 1. Is there anything to serve at all?
  const enabled = Object.entries(caps)
    .filter(([, on]) => on)
    .map(([name]) => name);
  checks.push({
    name: 'Permissions',
    ok: enabled.length > 0 && (config.roots.length > 0 || caps.screen || caps.control),
    detail:
      enabled.length === 0
        ? 'Nothing is switched on, so the connector would expose no tools.'
        : `${config.roots.length} folder${config.roots.length === 1 ? '' : 's'} shared; on: ${enabled.join(', ')}${config.readOnly ? ' (read-only)' : ''}`
  });

  // 2. Our own server, end to end, over the same URL the tunnel uses.
  if (!isServerRunning() || !status.localUrl) {
    checks.push({
      name: 'Local server',
      ok: false,
      detail: 'Not running. Press Connect first.'
    });
  } else {
    checks.push(await checkLocalServer(status.localUrl));
  }

  // 3. The tunnel process itself.
  const base = tunnelHealthBase();
  if (config.tunnel.kind !== 'openai') {
    checks.push({
      name: 'Tunnel',
      ok: null,
      detail: `Using the ${config.tunnel.kind} path, which has no local health endpoint.`
    });
  } else if (!base) {
    checks.push({
      name: 'Tunnel',
      ok: false,
      detail: 'The tunnel program is not running or has not reported a health address yet.'
    });
  } else {
    const ready = await probeText(`${base}/readyz`);
    checks.push({
      name: 'Tunnel',
      ok: ready?.status === 200,
      detail:
        ready === null
          ? 'The tunnel program is not answering on its local health address.'
          : ready.status === 200
            ? 'Running and ready.'
            : `Not ready: HTTP ${ready.status} ${ready.body}`
    });

    // 4. The link the outage actually breaks: client → OpenAI.
    const health = await readPollHealth(base);
    const fresh = health?.lastSuccessMs !== null && health?.lastSuccessMs !== undefined
      ? Date.now() - health.lastSuccessMs <= POLL_FRESH_MS
      : false;
    checks.push({
      name: 'Route to OpenAI',
      ok: health === null ? null : fresh,
      detail:
        health === null
          ? 'The tunnel did not report its metrics.'
          : `${fresh ? 'Verified' : 'Not verified'} — last completed handshake ${ago(health.lastSuccessMs)}; ${health.errors ?? 0} poll error${health.errors === 1 ? '' : 's'} since start.`
    });

    // 5. What the tunnel thinks of us, and its last control-plane error.
    const client = await readClientStatus(base);
    if (client) {
      checks.push({
        name: 'Tunnel → this app',
        ok: client.probe === null ? null : client.probe === 'ok',
        detail:
          client.probe === null
            ? 'The tunnel did not report a probe result for the main channel.'
            : `Probe of the local MCP server: ${client.probe}.`
      });
      if (client.metadataError) {
        checks.push({
          name: 'Last tunnel error',
          ok: false,
          detail: client.metadataError.slice(0, 300)
        });
      }
    }
  }

  // 6. The only end-to-end proof there is.
  const seen = lastRequestAt();
  checks.push({
    name: 'ChatGPT reaching this PC',
    ok: seen === null ? null : true,
    detail:
      seen === null
        ? 'No request has arrived since the server started. If ChatGPT reports an error, it never got as far as this app — that failure is on ChatGPT’s side, not here.'
        : `Last request from ChatGPT ${ago(seen)}.`
  });

  // 7. The failure that looks exactly like success: ChatGPT connects, this app
  //    answers, and the model is still not allowed to call anything.
  checks.push(developerMode(seen, lastToolCallAt()));

  const broken = checks.filter((c) => c.ok === false);
  const summary =
    broken.length === 0
      ? 'Every check passed.'
      : `${broken.length} problem${broken.length === 1 ? '' : 's'}: ${broken.map((c) => c.name).join(', ')}.`;

  logInfo(`self-test: ${summary}`);
  for (const check of checks) {
    const line = `self-test ${check.name}: ${check.detail}`;
    if (check.ok === false) logWarn(line);
    else logInfo(line);
  }

  return { checks, summary };
}
