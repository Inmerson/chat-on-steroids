/**
 * The local bridge between the Chrome extension and this app.
 *
 * A second loopback server, separate from the MCP endpoint, because the two have
 * opposite requirements: the MCP endpoint refuses any browser origin on purpose,
 * while this one exists to be called by a browser extension.
 *
 * What keeps it safe:
 *   · 127.0.0.1 only, never 0.0.0.0
 *   · the only unauthenticated routes are /hello (a fixed identifying string) and
 *     /pair, which needs a six-digit code the user reads out of the app window
 *   · every other route needs the bearer token issued at pairing, compared in
 *     constant time, and stored encrypted rather than in config.json
 *   · the Origin must be a chrome-extension:// origin, so a web page cannot drive it
 *   · bodies are capped and requests are rate limited
 *
 * It is deliberately not a general control API. It accepts observations about a
 * ChatGPT conversation and hands back activity summaries and queued commands. It
 * cannot read a file, run anything, or change a permission.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { BridgeStatus } from '../shared/types.js';
import { getSecret, setSecret } from './secrets.js';
import { logInfo, logWarn } from './logger.js';
import {
  closeConversation,
  liveConversations,
  recordChatObservations,
  type ChatObservation
} from './session/recorder.js';
import { getSession, listSessions, readEvents } from './session/store.js';
import { compactSession, compactionRunning } from './session/compact.js';
import {
  agentForConversation,
  bindConversation,
  hasPrimeAgent,
  mintPrimeHandover,
  mintWorkerJoinKey,
  onSpawnRequest,
  pendingWorkerSpawns
} from './agents.js';
import { readDurable, writeDurableSoon } from './durable.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from './version.js';

/** Fixed candidates so the extension can find the app without being told a port. */
const PORTS = [8765, 8766, 8767, 8768, 8769];
const MAX_BODY_BYTES = 512 * 1024;
const PAIRING_TTL_MS = 3 * 60 * 1000;
/** Requests allowed per rolling minute, across all routes. */
const RATE_LIMIT = 900;

/**
 * How long a claimed command stays claimed before it is offered again.
 *
 * Long enough for a tab to open, ChatGPT to finish loading and the composer to accept
 * text on a slow machine; short enough that a tab the user closed halfway does not
 * strand the command until the app restarts.
 */
const COMMAND_LEASE_MS = 90_000;
/** After this, a bootstrap is stale: opening the chat now would surprise the user. */
const COMMAND_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 4;
const MAX_COMMANDS = 20;
const COMMANDS_STATE = 'bridge-commands';

/**
 * What the extension is asked to do: open a fresh ChatGPT chat and type one message.
 *
 * Only the *spec* is kept, never the finished text. Both bootstrap kinds embed a
 * one-time credential — a worker's join key, or the prime handover key after Compact &
 * Resume — and this app does not write agent credentials to disk. The text is built at
 * hand-out time, which also means a retry mints a fresh key and invalidates the one the
 * failed attempt was given.
 */
type CommandSpec =
  | { type: 'worker'; agent: string; task: string }
  | { type: 'resume'; handoffId: string };

interface Command {
  id: string;
  spec: CommandSpec;
  createdAt: number;
  /**
   * When the extension last took this command. A lease, not a consumption: the command
   * is only retired once the extension reports the message was actually sent, so a tab
   * that dies between claiming and typing gets retried instead of disappearing.
   */
  claimedAt: number | null;
  attempts: number;
  lastError: string | null;
  /** The credential minted for the current attempt. Memory only, never persisted. */
  key: string | null;
}

/** The wire form the extension receives. */
export interface BridgeCommand {
  id: string;
  kind: 'open-chat';
  /** Text to type into the fresh conversation. Short by design. */
  text: string;
  /** Agent this tab will be, when the command comes from multi-agent mode. */
  agent: string | null;
  /** Milliseconds before an unacknowledged command is offered to someone else. */
  leaseMs: number;
  attempt: number;
}

let server: http.Server | null = null;
let port: number | null = null;
let lastSeenAt: number | null = null;
let pairing: { code: string; expiresAt: number } | null = null;
let commands: Command[] = [];
let requestWindow = { start: Date.now(), count: 0 };
const listeners = new Set<() => void>();
let extensionVersion: string | null = null;
let versionWarned = false;

export function onBridgeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

export async function bridgeStatus(): Promise<BridgeStatus> {
  return {
    running: server !== null,
    port,
    paired: (await getSecret('bridgeToken')) !== null,
    lastSeenAt,
    pairingCode: pairing && pairing.expiresAt > Date.now() ? pairing.code : null,
    pairingExpiresAt: pairing && pairing.expiresAt > Date.now() ? pairing.expiresAt : null
  };
}

/**
 * Shows a pairing code for three minutes.
 *
 * The code is the whole authorisation story: the user must be looking at the app to
 * read it, which is what stops any other local program from silently pairing itself.
 */
export function startPairing(): { code: string; expiresAt: number } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  pairing = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
  logInfo('bridge: pairing code shown');
  changed();
  return pairing;
}

export function cancelPairing(): void {
  pairing = null;
  changed();
}

export async function unpair(): Promise<void> {
  await setSecret('bridgeToken', '');
  pairing = null;
  logInfo('bridge: browser extension unpaired');
  changed();
}

// ------------------------------------------------------------------ helpers

function json(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store'
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'authorization, content-type';
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * Decides whether a request may be served at all, and what to echo back for CORS.
 *
 * The point of the check is to keep web pages out: a page can never suppress or forge
 * its Origin, so refusing every http(s) origin means chatgpt.com itself — and any
 * other site the user has open — cannot reach this server. `Origin: null` (a sandboxed
 * frame) is web content too, and is refused with them.
 *
 * A missing Origin is allowed, because Chrome does not always attach one to an
 * extension's own fetch once the extension holds host permission for 127.0.0.1. Those
 * requests still have to present the bearer token, which is the boundary that actually
 * carries the weight here; the Origin check is only the anti-web-page layer.
 */
function originOf(req: http.IncomingMessage): { ok: boolean; origin: string | null } {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return { ok: true, origin: null };
  if (origin.startsWith('chrome-extension://')) return { ok: true, origin };
  return { ok: false, origin: null };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Records which extension build is talking, and complains once if it is the wrong one.
 *
 * An extension a release behind fails in the least helpful way possible — it connects,
 * it pairs, and then some routes quietly do nothing. One warning naming both versions
 * turns that into something the Activity log answers directly.
 */
function noteExtensionVersion(req: http.IncomingMessage): void {
  const version = req.headers['x-extension-version'];
  const protocol = Number(req.headers['x-extension-protocol'] ?? NaN);
  if (typeof version === 'string' && version !== extensionVersion) {
    extensionVersion = version.slice(0, 32);
    logInfo(`bridge: browser extension ${extensionVersion} connected`);
  }
  if (!versionWarned && Number.isFinite(protocol) && protocol !== BRIDGE_PROTOCOL) {
    versionWarned = true;
    logWarn(
      `bridge: the browser extension speaks protocol ${protocol} but this app speaks ${BRIDGE_PROTOCOL}. ` +
        `Reload the extension from the folder shipped with app ${APP_VERSION}.`
    );
  }
}

async function authorised(req: http.IncomingMessage): Promise<boolean> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = await getSecret('bridgeToken');
  if (!token) return false;
  return safeEqual(header.slice(7), token);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      // Past the cap nothing more is kept, but the stream is still consumed and
      // discarded. Destroying the socket instead would reach the extension as
      // ECONNRESET, which it cannot tell apart from the app having crashed.
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Answers an over-sized body.
 *
 * A real status is worth more than a dropped connection here: the extension retries on
 * a network error and would post the same over-sized batch again forever, where a 413
 * tells it to split the batch. The rest of the body is drained by readBody, and the
 * request timeout bounds a client that never stops sending.
 */
function tooLarge(res: http.ServerResponse, origin: string | null): void {
  json(res, 413, { error: 'body_too_large' }, origin);
}

function rateLimited(): boolean {
  const now = Date.now();
  if (now - requestWindow.start > 60_000) requestWindow = { start: now, count: 0 };
  requestWindow.count += 1;
  return requestWindow.count > RATE_LIMIT;
}

// ---------------------------------------------------------------- validation

const OBSERVATION_KINDS = new Set([
  'user_message',
  'assistant_message',
  'progress',
  'turn_start',
  'turn_end',
  'chat_error'
]);
const OUTCOMES = new Set(['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown']);
const MAX_OBSERVATIONS = 200;

/**
 * Turns whatever the extension posted into observations we are willing to store.
 *
 * The extension reads an undocumented page that can change under it, so nothing from
 * it is trusted structurally: unknown kinds are dropped, text is capped, and a
 * timestamp from the future or the distant past is replaced with now.
 */
function parseObservations(input: unknown): ChatObservation[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const out: ChatObservation[] = [];
  for (const raw of input.slice(0, MAX_OBSERVATIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const kind = typeof item['kind'] === 'string' ? item['kind'] : '';
    if (!OBSERVATION_KINDS.has(kind)) continue;
    const time = typeof item['time'] === 'number' && Number.isFinite(item['time']) ? item['time'] : now;
    const observation: ChatObservation = {
      kind: kind as ChatObservation['kind'],
      time: time > now + 60_000 || time < now - 7 * 24 * 3600_000 ? now : time
    };
    if (typeof item['text'] === 'string') observation.text = item['text'].slice(0, 64_000);
    if (typeof item['messageId'] === 'string') observation.messageId = item['messageId'].slice(0, 100);
    if (typeof item['turnId'] === 'string') observation.turnId = item['turnId'].slice(0, 100);
    if (item['final'] === true) observation.final = true;
    if (typeof item['outcome'] === 'string' && OUTCOMES.has(item['outcome'])) {
      observation.outcome = item['outcome'] as ChatObservation['outcome'];
    }
    if (typeof item['detail'] === 'string') observation.detail = item['detail'].slice(0, 500);
    out.push(observation);
  }
  return out;
}

function conversationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // ChatGPT conversation ids are uuid-shaped; anything else is not one.
  return /^[0-9a-f-]{8,64}$/i.test(value) ? value : null;
}

// -------------------------------------------------------------------- routes

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { ok: originAllowed, origin } = originOf(req);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    // A preflight always carries an Origin, so a missing one here is not our extension.
    if (!origin) return json(res, 403, { error: 'forbidden_origin' }, null);
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      // Chrome asks for this before letting an extension reach a loopback address.
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600'
    });
    res.end();
    return;
  }

  if (rateLimited()) return json(res, 429, { error: 'rate_limited' }, origin);
  if (!originAllowed) return json(res, 403, { error: 'forbidden_origin' }, null);

  noteExtensionVersion(req);

  // Identification only. Deliberately says nothing about roots, permissions or state.
  if (route === '/hello') {
    return json(
      res,
      200,
      {
        app: 'chatgpt-local-files',
        version: APP_VERSION,
        bridge: BRIDGE_PROTOCOL,
        paired: (await getSecret('bridgeToken')) !== null
      },
      origin
    );
  }

  if (route === '/pair' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const code = (body as Record<string, unknown>)?.['code'];
    if (!pairing || pairing.expiresAt < Date.now()) {
      return json(res, 403, { error: 'no_pairing', message: 'Open ChatGPT Local Files and press Pair extension.' }, origin);
    }
    if (typeof code !== 'string' || !safeEqual(code, pairing.code)) {
      // One wrong guess burns the code. Six digits are only safe if there is no
      // opportunity to try all of them.
      pairing = null;
      changed();
      return json(res, 403, { error: 'bad_code' }, origin);
    }
    const token = randomBytes(32).toString('base64url');
    await setSecret('bridgeToken', token);
    pairing = null;
    lastSeenAt = Date.now();
    logInfo('bridge: browser extension paired');
    changed();
    return json(res, 200, { token }, origin);
  }

  if (!(await authorised(req))) return json(res, 401, { error: 'unauthorised' }, origin);
  lastSeenAt = Date.now();

  if (route === '/status') {
    const live = liveConversations();
    return json(res, 200, { ok: true, conversations: live, commands: commands.length }, origin);
  }

  if (route === '/events' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    if (typeof body['agent'] === 'string' && /^[a-z0-9-]{1,40}$/i.test(body['agent'])) {
      bindConversation(body['agent'], id);
    }
    const observations = parseObservations(body['events']);
    const agent = agentForConversation(id);
    const result = await recordChatObservations(id, observations, agent);
    return json(res, 200, { sessionId: result.sessionId, stored: result.stored }, origin);
  }

  if (route === '/closed' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (id) await closeConversation(id);
    return json(res, 200, { ok: true }, origin);
  }

  // The activity feed the extension uses to relabel ChatGPT's tool blocks. It only
  // ever returns summaries of calls this app made — never file contents.
  if (route === '/activity') {
    const id = conversationId(url.searchParams.get('conversationId'));
    const since = Number(url.searchParams.get('since') ?? 0);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    const live = liveConversations().find((entry) => entry.conversationId === id);
    if (!live) return json(res, 200, { sessionId: null, entries: [] }, origin);
    const summary = await getSession(live.sessionId);
    const events = await readEvents(live.sessionId, {
      kinds: ['tool_call'],
      from: Number.isFinite(since) ? Math.max(0, since) : 0
    });
    const entries = events.flatMap((event) =>
      event.kind === 'tool_call'
        ? [
            {
              seq: event.seq,
              time: event.time,
              tool: event.call.tool,
              callId: event.call.callId,
              // The extension matches its DOM blocks against this, and refuses to
              // relabel anything when it is missing.
              turnId: event.turnId ?? null,
              attribution: event.call.attribution,
              outcome: event.call.outcome,
              durationMs: event.call.durationMs,
              summary: event.call.summary,
              changes: event.call.changes ?? [],
              args: event.call.args.text,
              argsTruncated: event.call.args.truncated,
              result: event.call.result.text.slice(0, 4000),
              agent: event.agent ?? null
            }
          ]
        : []
    );
    return json(
      res,
      200,
      { sessionId: live.sessionId, generating: live.generating, tokens: summary?.estimatedTokens ?? 0, entries },
      origin
    );
  }

  if (route === '/compact' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    if (compactionRunning()) return json(res, 409, { error: 'compaction_running' }, origin);
    const live = liveConversations().find((entry) => entry.conversationId === id);
    const known = live ? null : (await listSessions()).find((entry) => entry.conversationId === id);
    const sessionId = live?.sessionId ?? known?.id ?? null;
    if (!sessionId) {
      return json(
        res,
        409,
        { error: 'session_not_recorded', message: 'This chat has no recorded local session to compact.' },
        origin
      );
    }
    const resume = body['resume'] !== false;
    // Return immediately: a real compaction can stream for minutes, while the bridge's
    // HTTP request timeout is intentionally short. The app publishes progress through
    // its normal compaction state and queues the fresh chat only after a complete
    // handoff has been saved.
    void compactSession({
      sessionId,
      reason: resume ? 'browser compact and resume' : 'browser compaction',
      resume
    })
      .then((handoff) => {
        if (resume) queueResume(handoff.id);
        logInfo(`bridge: browser compaction finished for ${sessionId}`);
      })
      .catch((err: Error) => logWarn(`bridge: browser compaction failed — ${err.message}`));
    logInfo(`bridge: browser requested ${resume ? 'compact and resume' : 'compaction'} for ${sessionId}`);
    return json(res, 202, { started: true, sessionId, resume }, origin);
  }

  if (route === '/commands') {
    return json(res, 200, { commands: takeCommands() }, origin);
  }

  if (route === '/commands/ack' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = typeof body['id'] === 'string' ? body['id'] : '';
    // A protocol-1 extension sends no status and only ever acknowledges a success, so
    // a missing status still means "sent".
    const raw = typeof body['status'] === 'string' ? body['status'] : 'sent';
    const status: AckStatus = raw === 'failed' || raw === 'working' ? raw : 'sent';
    const error = typeof body['error'] === 'string' ? body['error'].slice(0, 200) : null;
    // Binding first: a tab that reported its conversation but timed out before sending
    // should still have its agent filed correctly.
    const conversation = conversationId(body['conversationId']);
    const agent = typeof body['agent'] === 'string' ? body['agent'] : null;
    if (conversation && agent && /^[a-z0-9-]{1,40}$/i.test(agent)) bindConversation(agent, conversation);
    ackCommand(id, status, error);
    return json(res, 200, { ok: true }, origin);
  }

  return json(res, 404, { error: 'not_found' }, origin);
}

// -------------------------------------------------------------------- server

export async function startBridge(): Promise<number | null> {
  if (server) return port;
  const instance = http.createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      logWarn(`bridge request failed: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal' }, originOf(req).origin);
    });
  });
  instance.headersTimeout = 15_000;
  instance.requestTimeout = 30_000;

  for (const candidate of PORTS) {
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (): void => resolve(false);
      instance.once('error', onError);
      instance.listen(candidate, '127.0.0.1', () => {
        instance.removeListener('error', onError);
        resolve(true);
      });
    });
    if (bound) {
      server = instance;
      port = candidate;
      instance.on('error', (err) => logWarn(`bridge server error: ${err.message}`));
      // Commands from the previous run come back first, so a bootstrap that has already
      // failed three times keeps its history. Registering the spawn handler then replays
      // any worker chat the broker is still owed — a run restored from disk at startup
      // has nobody to ask until this moment — and queue() folds a replayed worker into
      // the restored command for the same worker rather than opening a second tab.
      await restoreCommands();
      onSpawnRequest((workers) => {
        for (const worker of workers) queueWorkerBootstrap(worker.id, worker.task);
      });
      logInfo(`bridge listening on 127.0.0.1:${candidate}`);
      changed();
      return candidate;
    }
  }
  logWarn(`bridge could not bind any of ports ${PORTS.join(', ')}; the browser extension will not connect`);
  return null;
}

export async function stopBridge(): Promise<void> {
  const instance = server;
  if (!instance) return;
  server = null;
  port = null;
  await new Promise<void>((resolve) => {
    instance.closeAllConnections();
    instance.close(() => resolve());
  });
  logInfo('bridge stopped');
  changed();
}

// ------------------------------------------------------------------ commands

function specKey(spec: CommandSpec): string {
  return spec.type === 'worker' ? `worker:${spec.agent}` : `resume:${spec.handoffId}`;
}

function persistCommands(): void {
  writeDurableSoon(COMMANDS_STATE, {
    version: 1,
    // Leases and minted keys are per-process: a claim held by a tab in a browser that
    // is no longer talking to this process means nothing after a restart, and the key
    // deliberately never reaches disk.
    commands: commands.map((command) => ({
      id: command.id,
      spec: command.spec,
      createdAt: command.createdAt,
      attempts: command.attempts,
      lastError: command.lastError
    }))
  });
}

function queue(spec: CommandSpec): Command {
  const key = specKey(spec);
  const existing = commands.find((command) => specKey(command.spec) === key);
  if (existing) {
    // The same bootstrap arriving twice — a restart re-requesting a worker that never
    // joined, say — is one job, not two tabs.
    existing.createdAt = Date.now();
    existing.claimedAt = null;
    changed();
    persistCommands();
    return existing;
  }
  const command: Command = {
    id: randomBytes(8).toString('hex'),
    spec,
    createdAt: Date.now(),
    claimedAt: null,
    attempts: 0,
    lastError: null,
    key: null
  };
  commands.push(command);
  if (commands.length > MAX_COMMANDS) {
    const dropped = commands.shift();
    if (dropped) logWarn(`bridge: dropped an old queued chat command (${specKey(dropped.spec)}); the queue is full`);
  }
  changed();
  persistCommands();
  return command;
}

/**
 * Queues the bootstrap for a worker chat.
 *
 * Called by the broker through onSpawnRequest. The join key is not passed in and not
 * stored: it is minted when the extension actually takes the command.
 */
export function queueWorkerBootstrap(agent: string, task: string): BridgeCommand | null {
  const command = queue({ type: 'worker', agent, task });
  return describe(command, null);
}

/** Queues the "continue this session in a fresh chat" bootstrap after a compaction. */
export function queueResume(handoffId: string): BridgeCommand | null {
  const command = queue({ type: 'resume', handoffId });
  return describe(command, null);
}

/** The text the extension types, built fresh for each attempt. */
function bootstrapText(spec: CommandSpec, key: string | null): string {
  if (spec.type === 'worker') {
    return (
      `You are worker agent "${spec.agent}" in a ChatGPT Local Files multi-agent run. ` +
      'Call the join_agent tool with no arguments — the paired extension already bound this fresh ChatGPT conversation to your worker slot. ' +
      'It returns your task and your agent key. Pass that agent key as agent_key on every later tool call so your messages reach you. ' +
      'Report progress to the prime agent with send_agent_message, and call finish_agent when you are done. ' +
      'Do not try to contact other workers; everything goes through the prime agent.'
    );
  }
  const handover = hasPrimeAgent()
    ? ' This run also has a multi-agent swarm: call join_agent with no arguments to take over as the prime agent, then pass the returned agent key as agent_key on every later call.'
    : '';
  return (
    'Continue the previous ChatGPT Local Files session. Call the resume_session tool with ' +
    `handoffId "${spec.handoffId}" to get the handoff brief, then carry on from there. ` +
    'Do not restart the work from scratch.' +
    handover
  );
}

function describe(command: Command, key: string | null): BridgeCommand {
  return {
    id: command.id,
    kind: 'open-chat',
    text: bootstrapText(command.spec, key),
    agent: command.spec.type === 'worker' ? command.spec.agent : hasPrimeAgent() ? 'prime' : null,
    leaseMs: COMMAND_LEASE_MS,
    attempt: command.attempts
  };
}

function drop(command: Command, why: string): void {
  commands = commands.filter((entry) => entry !== command);
  logWarn(`bridge: gave up on ${specKey(command.spec)} — ${why}`);
  changed();
  persistCommands();
}

/**
 * Hands out the commands the extension should act on now, and leases them.
 *
 * A command is claimed rather than consumed, because the extension has not done
 * anything yet: opening a tab can fail, the composer can refuse the text, the user can
 * close the tab. Only /commands/ack with a "sent" outcome retires one.
 */
function takeCommands(): BridgeCommand[] {
  const now = Date.now();
  const out: BridgeCommand[] = [];
  const pendingWorkers = new Set(pendingWorkerSpawns().map((worker) => worker.id));
  // Browser-bound joining deliberately carries no random credential through ChatGPT.
  // Keep only one not-yet-joined worker bootstrap in flight so join_agent can identify
  // that worker from the extension binding even while the prime keeps working in
  // parallel. Once it joins (or exhausts retries), the next worker may open.
  let workerLeaseHeld = commands.some(
    (command) =>
      command.spec.type === 'worker' &&
      pendingWorkers.has(command.spec.agent) &&
      command.claimedAt !== null &&
      now - command.claimedAt < COMMAND_LEASE_MS
  );
  for (const command of [...commands]) {
    const workerAgent = command.spec.type === 'worker' ? command.spec.agent : null;
    if (workerAgent && !pendingWorkers.has(workerAgent)) {
      // The worker joined (or the run ended) after its bootstrap was sent. Only now is
      // the command truly complete; retiring it on "message sent" stranded workers
      // when ChatGPT's harness false-positive blocked join_agent afterwards.
      commands = commands.filter((entry) => entry !== command);
      persistCommands();
      continue;
    }
    if (now - command.createdAt > COMMAND_TTL_MS) {
      drop(command, 'it has been waiting too long to still be what the user expects');
      continue;
    }
    if (command.claimedAt !== null && now - command.claimedAt < COMMAND_LEASE_MS) continue;
    if (workerAgent && workerLeaseHeld) continue;
    if (command.attempts >= MAX_ATTEMPTS) {
      drop(command, `${command.attempts} attempts failed${command.lastError ? ` (${command.lastError})` : ''}`);
      continue;
    }
    // Protocol 3 authenticates browser bootstraps by the extension-bound ChatGPT
    // conversation. Do not shuttle a random capability string through the model's tool
    // arguments: ChatGPT can block those before the MCP request reaches this server.
    command.key = null;
    command.claimedAt = now;
    command.attempts += 1;
    if (workerAgent) workerLeaseHeld = true;
    out.push(describe(command, null));
    if (out.length >= 5) break;
  }
  if (out.length > 0) {
    changed();
    persistCommands();
  }
  return out;
}

type AckStatus = 'sent' | 'failed' | 'working';

function ackCommand(id: string, status: AckStatus, error: string | null): void {
  const command = commands.find((entry) => entry.id === id);
  if (!command) return;
  if (status === 'working') {
    // The tab is open and the extension is still trying. Extend rather than expire.
    command.claimedAt = Date.now();
    return;
  }
  if (status === 'sent') {
    if (command.spec.type === 'worker') {
      // Sending the bootstrap is not success for a worker: it still has to redeem its
      // one-time join capability. Keep the command leased; if the harness blocks every
      // join attempt, a fresh tab gets another attempt after the lease instead of the
      // worker remaining invited forever.
      command.claimedAt = Date.now();
      command.key = null;
      command.lastError = null;
      logInfo(`bridge: ${specKey(command.spec)} bootstrap sent; waiting for worker to join`);
    } else {
      commands = commands.filter((entry) => entry !== command);
      logInfo(`bridge: ${specKey(command.spec)} bootstrap sent`);
    }
  } else {
    // Released immediately, so a retry does not have to wait out the lease.
    command.claimedAt = null;
    command.key = null;
    command.lastError = error;
    logWarn(
      `bridge: ${specKey(command.spec)} bootstrap failed on attempt ${command.attempts}` +
        `${error ? ` — ${error}` : ''}`
    );
    if (command.attempts >= MAX_ATTEMPTS) drop(command, `${command.attempts} attempts failed`);
  }
  changed();
  persistCommands();
}

/** What the UI shows about work waiting on the browser. */
export function pendingCommands(): Array<{ id: string; what: string; attempts: number; lastError: string | null }> {
  return commands.map((command) => ({
    id: command.id,
    what: specKey(command.spec),
    attempts: command.attempts,
    lastError: command.lastError
  }));
}

/**
 * Reloads commands left over from a previous run.
 *
 * Anything older than the TTL is discarded rather than acted on: reopening the app the
 * next morning must not spray yesterday's chats across the browser. Leases and keys do
 * not survive, so every restored command starts as unclaimed with no credential.
 */
export async function restoreCommands(): Promise<void> {
  const saved = await readDurable<{ version?: number; commands?: unknown }>(COMMANDS_STATE);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.commands)) return;
  const now = Date.now();
  let restored = 0;
  for (const raw of saved.commands as Array<Partial<Command>>) {
    const spec = raw.spec;
    if (!spec || typeof raw.id !== 'string') continue;
    if (spec.type !== 'worker' && spec.type !== 'resume') continue;
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    if (now - createdAt > COMMAND_TTL_MS) continue;
    if (commands.some((entry) => specKey(entry.spec) === specKey(spec))) continue;
    commands.push({
      id: raw.id,
      spec,
      createdAt,
      claimedAt: null,
      // Attempts carry over so a command that has already failed repeatedly does not
      // get a fresh budget on every restart.
      attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      key: null
    });
    restored += 1;
  }
  if (restored > 0) {
    logInfo(`bridge: restored ${restored} queued chat command(s) from the previous run`);
    changed();
  }
}

/** Test seam. */
export function resetBridgeForTests(): void {
  commands = [];
  pairing = null;
  lastSeenAt = null;
  extensionVersion = null;
  versionWarned = false;
  requestWindow = { start: Date.now(), count: 0 };
}

export function bridgePort(): number | null {
  return port;
}
