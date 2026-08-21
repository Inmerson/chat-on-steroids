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
 *     /pair, which issues the token to a caller on 127.0.0.1 — see the route for what
 *     that deliberately does and does not buy
 *   · every other route needs the bearer token issued by /pair, compared in
 *     constant time, and stored encrypted rather than in config.json
 *   · the Origin must be a chrome-extension:// origin, so a web page cannot drive it
 *   · bodies are capped and requests are rate limited
 *
 * It is deliberately not a general control API. It accepts observations about a
 * ChatGPT conversation and hands back activity summaries and queued commands. It
 * cannot read a file, run anything, or change a permission.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { BridgeStatus } from '../shared/types.js';
import type { SessionOrigin } from '../shared/session.js';
import { getConfig } from './config.js';
import { getSecret, setSecret } from './secrets.js';
import { logInfo, logWarn } from './logger.js';
import {
  closeConversation,
  liveConversations,
  noteChatOrigin,
  recordAgentMessage,
  recordChatObservations,
  restoreRecordedConversation,
  type ChatObservation,
  type PageCallEvidence
} from './session/recorder.js';
import {
  autoCompactionReady,
  claimAutoCompaction,
  findSessionByConversation,
  getSession,
  listSessions,
  readRecentEvents,
  sessionDurableModifiedAt
} from './session/store.js';
import { inFlightMcpRequests, inFlightToolCalls } from './mcp/call-context.js';
import { nativeHandoffPrompt } from './session/handoff-prompt.js';
import {
  agentForConversation,
  bindConversation,
  currentRunId,
  failAgent,
  forgetRetiredWorker,
  finishWorkerConversation,
  onSpawnRequest,
  onSwarmEnd,
  pendingWorkerSpawns,
  primeConversationGone,
  releaseQuiescentRun,
  retiredWorkerForConversation,
  swarmState,
  swarmTransferActive,
  workerConversationGone
} from './agents.js';
import {
  abortContinuation,
  armContinuation,
  attachSummary,
  claimContinuation,
  commitContinuation,
  continuationByToken,
  continuationForSession,
  openContinuation,
  resetContinuationsForTests
} from './session/continuation.js';
import { readDurable, writeDurableSoon } from './durable.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from './version.js';

/** Fixed candidates so the extension can find the app without being told a port. */
export const DEFAULT_PORTS = [8765, 8766, 8767, 8768, 8769];
/**
 * The shipped range is fixed on purpose, but the test suite runs many bridges in parallel
 * forks on a machine where an installed app already holds 8765. A test whose own bind lost
 * that race used to fall through to the real app's bridge: 401s at best, and at worst a
 * test POSTing observations into the user's actual history. `CLF_BRIDGE_PORTS=0` asks the
 * OS for a free port per bridge instead, so no run can collide with another or with the app.
 */
const PORTS = ((): number[] => {
  const raw = process.env.CLF_BRIDGE_PORTS;
  if (!raw) return DEFAULT_PORTS;
  const parsed = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 65535);
  return parsed.length > 0 ? parsed : DEFAULT_PORTS;
})();
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** User-requested orphan safety net: slow enough to require durable inactivity, not a heartbeat lease. */
export const STALE_SWARM_MS = 2 * 60_000;
const STALE_SWARM_SWEEP_MS = 30_000;
/** /events batches currently between parse and durable/session+worker lifecycle completion. */
let observationWritesInFlight = 0;
/** Requests allowed per rolling minute, across all routes. */
const RATE_LIMIT = 900;

/**
 * How long the app waits for the tab it opened to do the job, before failing it.
 *
 * A deadline, not a retry interval. One command is one delivery: the app opens the exact
 * chat, and this is how long that page has to redeem the marker, type the bootstrap and
 * report which conversation it landed in. Long enough for a tab to open, ChatGPT to finish
 * loading and the composer to accept text on a slow machine.
 *
 * What happens when it runs out is `drop()`, which is an ending rather than another go:
 * the continuation is aborted and the session stays in the chat it is already in, or the
 * worker slot is failed and the prime is told. Someone who wants to try again presses the
 * button again — one press, one chat — where a background retry loop produced tabs minutes
 * after everybody had stopped expecting them.
 */
const COMMAND_DEADLINE_MS = 90_000;
/** Past this age a bootstrap restored from a previous run is stale, not pending. */
const COMMAND_TTL_MS = 30 * 60_000;
const MAX_COMMANDS = 20;
const COMMANDS_STATE = 'bridge-commands';

/**
 * How recently a ChatGPT tab must have talked to this app to count as open.
 *
 * Every open tab polls /activity for its own conversation every few seconds, whether or
 * not anything is happening in it, so this is a direct observation rather than an
 * inference. Generous enough to survive a throttled background tab missing a couple of
 * polls.
 */
/**
 * How recently the extension must have been heard from for "which chats are open" to
 * be a question this app can answer at all.
 *
 * Distinct from the above on purpose: silence from one conversation means that chat is
 * closed only if the browser half is otherwise talking to us. Silence from the whole
 * extension means we know nothing, and the multi-agent broker treats those two cases
 * very differently before ending somebody's run.
 */
const BROWSER_PRESENT_MS = 60_000;

/**
 * The longest native compaction brief the browser bridge will carry across.
 *
 * This used to be 24k characters, which silently forced even a model instructed to write a
 * large token-budget handoff down to roughly six thousand tokens. The model-side prompt owns
 * the semantic ceiling (30k tokens); this is deliberately *not* another token approximation.
 * It is only a generous runaway-input guard, far above a normal 30k-token operational brief.
 */
const MAX_BRIEF_CHARS = 256_000;

/**
 * Cuts an over-long brief down to what will be typed, from the middle.
 *
 * Truncating the end was worse than not truncating at all: a brief is written TASK first
 * and NEXT / DO NOT last, so cutting the tail hands the fresh chat pages of history with
 * the instructions for what to do about it deleted — and nothing in the text says so. The
 * two ends are the parts that must survive, so the middle goes instead, with a marker in
 * its place. Both halves therefore end and begin at a line boundary where one is near.
 */
function boundBrief(text: string): string {
  if (text.length <= MAX_BRIEF_CHARS) return text;
  const marker = '\n\n[… the middle of this brief was longer than the app carries across and was left out …]\n\n';
  const room = MAX_BRIEF_CHARS - marker.length;
  // The tail is the actionable half, so it gets the larger share.
  const headRoom = Math.floor(room * 0.4);
  const head = text.slice(0, headRoom);
  const tail = text.slice(text.length - (room - headRoom));
  const headBreak = head.lastIndexOf('\n');
  const tailBreak = tail.indexOf('\n');
  return (
    (headBreak > headRoom - 400 ? head.slice(0, headBreak) : head) +
    marker +
    (tailBreak >= 0 && tailBreak < 400 ? tail.slice(tailBreak + 1) : tail)
  );
}

/**
 * What the extension is asked to do: open a fresh ChatGPT chat and type one message.
 *
 * Two kinds, and both open a *new* chat — there is no longer any command that types into a
 * conversation that already exists. That path existed for reviving a worker and for telling
 * a doomed worker its run was over, and both were ways of driving a chat the app does not
 * own; a run now ends by ending, and a worker that is finished stays finished.
 *
 * Only the *spec* is kept, never the finished text. A worker bootstrap embeds a one-time
 * join key that this app does not write to disk, and a resume's text belongs to the
 * continuation transaction, which hands it over once. Building the text at hand-out time is
 * what keeps both of those true.
 */
type CommandSpec =
  | { type: 'worker'; agent: string; task: string }
  /**
   * The replacement chat for a Compact & Resume.
   *
   * Carries the continuation's token rather than the brief: the transaction owns the text,
   * decides whether this command may still have it, and is the only thing that can say the
   * move happened. Keyed by session, because compacting the same chat twice is one job whose
   * brief got newer — not two fresh chats, which is what keying on the handoff produced.
   */
  | { type: 'resume'; sessionId: string; token: string };

interface Command {
  id: string;
  spec: CommandSpec;
  createdAt: number;
  /**
   * When this command was handed to a page, and so when its deadline started.
   *
   * Null means nothing is working on it. A command is not retired at the moment it is
   * handed over — the page still has to type into the chat and tell the app which chat that
   * was — so this is what `timer` counts from, and what tells a second page that one is
   * already on it.
   */
  claimedAt: number | null;
  /**
   * The one-shot that ends this command when its deadline passes. Memory only.
   *
   * One timer per command, armed when it is claimed and cleared when it is retired. There
   * is no periodic sweep behind it: nothing about a command changes on its own except
   * running out of time, so the only clock in this file is the one that says so.
   */
  timer: NodeJS.Timeout | null;
  lastError: string | null;
  /**
   * The page that redeemed this command, while its lease holds.
   *
   * One command is one chat, so it is delivered to one page. A second page on the same
   * marker — a reload restored into a new document, a duplicated tab, "reopen closed tab" —
   * is refused rather than handed the same bootstrap to type into a second conversation.
   * Memory only: a command restored from a previous run has no page waiting for it.
   */
  owner: string | null;
}

/** The wire form the extension receives. */
export interface BridgeCommand {
  id: string;
  kind: 'open-chat';
  /** Text to type into the conversation. Short by design. */
  text: string;
  /** Agent this tab will be, when the command comes from multi-agent mode. */
  agent: string | null;
}

let server: http.Server | null = null;
let port: number | null = null;
let lastSeenAt: number | null = null;
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
    lastSeenAt
  };
}

/**
 * Whether this app can currently see the browser at all.
 *
 * False before the extension has ever talked to this process, and again once it has
 * gone quiet — in both cases "no tab reported that conversation" means nothing.
 */
export function browserPresent(): boolean {
  return lastSeenAt !== null && Date.now() - lastSeenAt < BROWSER_PRESENT_MS;
}

/**
 * Forgets the token, so the next browser to ask gets a new one.
 *
 * The only remaining manual step in the extension's lifecycle, and it is a revocation
 * rather than a setup: there is nothing to press to connect.
 */
export async function unpair(): Promise<void> {
  await setSecret('bridgeToken', '');
  logInfo('bridge: browser disconnected');
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
function extensionProtocol(req: http.IncomingMessage): number | null {
  const value = Number(req.headers['x-extension-protocol'] ?? NaN);
  return Number.isSafeInteger(value) ? value : null;
}

function protocolCompatible(req: http.IncomingMessage): boolean {
  return extensionProtocol(req) === BRIDGE_PROTOCOL;
}

function noteExtensionVersion(req: http.IncomingMessage): void {
  const version = req.headers['x-extension-version'];
  const protocol = extensionProtocol(req);
  if (typeof version === 'string' && version !== extensionVersion) {
    extensionVersion = version.slice(0, 32);
    logInfo(`bridge: browser extension ${extensionVersion} connected`);
  }
  if (!versionWarned && protocol !== null && protocol !== BRIDGE_PROTOCOL) {
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
  'conversation_title',
  'user_message',
  'assistant_message',
  'page_tool',
  'turn_start',
  'turn_end',
  'chat_error',
  // Not stored as transcript content. These request records populate the exact
  // requestId -> conversationId correlation registry.
  'tool_evidence'
]);
const OUTCOMES = new Set(['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown']);
const MAX_OBSERVATIONS = 200;
/** Connector requests accepted from one turn. Far above any real turn's call count. */
const MAX_CALL_EVIDENCE = 200;
/** The shape of a tool name we are willing to match a recorded call against. */
const TOOL_NAME = /^[a-z0-9_.-]{1,64}$/i;

/**
 * Rebuilds the per-call evidence the page reported, field by field.
 *
 * The extension read this out of ChatGPT's React state, and the page can post the same
 * message shape itself, so none of it is trusted: every field is reconstructed rather than
 * copied, the tool name is *checked* against its pattern and never trimmed to fit (trimming
 * turns a value that failed validation into one that passes), and duplicate message ids are
 * dropped on both sides rather than one of them being picked.
 *
 * What this evidence may do is bounded in the recorder, not here: it can say which
 * conversation a call this app *already ran* belongs to. It never creates a record, never
 * names an agent, and never carries an argument value.
 */
function parseCallEvidence(input: unknown): PageCallEvidence[] {
  if (!Array.isArray(input)) return [];
  const out: PageCallEvidence[] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const raw of input.slice(0, MAX_CALL_EVIDENCE)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const tool = typeof item['tool'] === 'string' && TOOL_NAME.test(item['tool']) ? item['tool'] : '';
    const messageId = typeof item['messageId'] === 'string' ? item['messageId'].slice(0, 120) : '';
    if (!tool || !messageId) continue;
    if (seen.has(messageId)) {
      duplicated.add(messageId);
      continue;
    }
    seen.add(messageId);
    out.push({
      messageId,
      tool,
      order: typeof item['order'] === 'number' && Number.isFinite(item['order'])
        ? Math.max(0, Math.min(MAX_CALL_EVIDENCE, Math.floor(item['order'])))
        : out.length,
      answered: item['answered'] === true,
      // Rebuilt like everything else here — an opaque id checked for shape, and a finite
      // number — so the page cannot smuggle anything through them.
      requestId:
        typeof item['requestId'] === 'string' && /^[a-z0-9_-]{1,100}$/i.test(item['requestId'])
          ? item['requestId']
          : null,
      createTime:
        typeof item['createTime'] === 'number' && Number.isFinite(item['createTime']) ? item['createTime'] : null
    });
  }
  return out.filter((call) => !duplicated.has(call.messageId));
}

/**
 * Turns whatever the extension posted into observations we are willing to store.
 *
 * The extension reads an undocumented page that can change under it, so nothing from
 * it is trusted structurally: unknown kinds are dropped, text is capped, and an impossible
 * timestamp is replaced with now. Historical transcript timestamps are valid input: opening
 * a months-old chat is exactly when we need ChatGPT's own creation time so its messages can
 * be interleaved with already-recorded MCP calls instead of all appearing at reload time.
 */
function parseObservations(input: unknown): ChatObservation[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const earliestChatGpt = Date.UTC(2022, 10, 30);
  const out: ChatObservation[] = [];
  for (const raw of input.slice(0, MAX_OBSERVATIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const kind = typeof item['kind'] === 'string' ? item['kind'] : '';
    if (!OBSERVATION_KINDS.has(kind)) continue;
    const time = typeof item['time'] === 'number' && Number.isFinite(item['time']) ? item['time'] : now;
    const observation: ChatObservation = {
      kind: kind as ChatObservation['kind'],
      time: time > now + 60_000 || time < earliestChatGpt ? now : time
    };
    if (item['authoredTime'] === true) observation.authoredTime = true;
    // Long final handoff-style answers are valid transcript content too. Keep this aligned
    // with the page-side assistant bound so the bridge does not silently become the next
    // truncation point after Fiber/content.js accepted the whole message.
    if (typeof item['text'] === 'string') observation.text = item['text'].slice(0, 256_000);
    if (typeof item['messageId'] === 'string') observation.messageId = item['messageId'].slice(0, 100);
    if (typeof item['turnId'] === 'string') observation.turnId = item['turnId'].slice(0, 100);
    if (typeof item['renderedHtml'] === 'string') observation.renderedHtml = item['renderedHtml'].slice(0, 120_000);
    if (item['state'] === 'streaming' || item['state'] === 'final') observation.state = item['state'];
    if (typeof item['fiberConversationId'] === 'string') {
      const fiberId = conversationId(item['fiberConversationId']);
      if (fiberId) observation.fiberConversationId = fiberId;
    }
    if (item['final'] === true) observation.final = true;
    if (typeof item['outcome'] === 'string' && OUTCOMES.has(item['outcome'])) {
      observation.outcome = item['outcome'] as ChatObservation['outcome'];
    }
    if (typeof item['detail'] === 'string') observation.detail = item['detail'].slice(0, 500);
    if (Array.isArray(item['calls'])) observation.calls = parseCallEvidence(item['calls']);
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

/**
 * Is ChatGPT working in this chat right now?
 *
 * The live half of the automatic-compaction rule, and the reason it is asked here rather
 * than remembered in the session: `generating` is a fact about the connection this process
 * is holding open, so it cannot survive a restart, a closed tab or a crash the way a
 * durable flag can — which is exactly the property that keeps a stale chat quiet. Reopening
 * a 500k conversation from last week starts no turn, so it never looks like work.
 *
 * In-flight tool calls are deliberately *not* counted. They are global to the app rather
 * than to one chat, and a worker's `exec_command` running elsewhere must not make an idle
 * chat look busy. It costs nothing: ChatGPT keeps the turn open while it waits for a tool
 * result, so mid-tool-call is already mid-turn here.
 */
function chatIsWorking(conversationId: string): boolean {
  const current = liveConversations().find((entry) => entry.conversationId === conversationId);
  return Boolean(current && (current.generating || current.activeTurnId));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { ok: originAllowed, origin } = originOf(req);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    // A preflight always carries an Origin, so a missing one here is not our extension.
    if (!origin) return json(res, 403, { error: 'forbidden_origin' }, null);
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type, x-extension-version, x-extension-protocol',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      // Chrome asks for this before letting an extension reach a loopback address.
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600'
    });
    res.end();
    return;
  }

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
        compatible: protocolCompatible(req),
        paired: (await getSecret('bridgeToken')) !== null
      },
      origin
    );
  }

  if (route === '/pair' && req.method === 'POST') {
    if (!protocolCompatible(req)) {
      return json(res, 426, { error: 'incompatible_extension', bridge: BRIDGE_PROTOCOL, version: APP_VERSION }, origin);
    }
    if (rateLimited()) return json(res, 429, { error: 'rate_limited' }, origin);
    try {
      await readBody(req);
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    // Silent provisioning on loopback.
    //
    // There used to be a six-digit code here, so the user had to be looking at the app
    // before a browser could attach. In practice both halves are the same person on the
    // same machine, installed together, and the code was a step that failed far more
    // often than it protected anything — the app was unreachable and the user was typing
    // numbers. The bearer token is still real and still required on every other route; it
    // is simply issued to whoever asks on 127.0.0.1 rather than to whoever can read the
    // window. What that gives up is stated plainly: any program already running as this
    // user can obtain the token, and with it read recorded ChatGPT activity and queue an
    // "open a fresh chat" command. It can still not read a file, run anything, or change
    // a permission — the bridge has no route that does. A web page cannot: originOf
    // refuses anything that is not a chrome-extension:// origin, above.
    const token = randomBytes(32).toString('base64url');
    await setSecret('bridgeToken', token);
    lastSeenAt = Date.now();
    logInfo('bridge: browser extension connected and provisioned');
    changed();
    return json(res, 200, { token }, origin);
  }

  if (!(await authorised(req))) return json(res, 401, { error: 'unauthorised' }, origin);
  if (!protocolCompatible(req)) {
    return json(res, 426, { error: 'incompatible_extension', bridge: BRIDGE_PROTOCOL, version: APP_VERSION }, origin);
  }
  // Charge only an authenticated extension. A random local process must not be able to
  // consume the browser's shared budget before failing origin/authentication.
  if (rateLimited()) return json(res, 429, { error: 'rate_limited' }, origin);
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
      // Recovery only. The page's label is not authority: it may bind a worker only while
      // the app itself still owns a claimed bootstrap for that exact slot. The normal path
      // binds from /commands/ack below using the command id, without trusting this field.
      const pending = commands.some(
        (command) =>
          command.spec.type === 'worker' &&
          command.spec.agent === body['agent'] &&
          command.claimedAt !== null
      );
      if (pending) bindConversation(body['agent'], id);
    }
    const observations = parseObservations(body['events']);
    observationWritesInFlight += 1;
    try {
      const agent = agentForConversation(id);
      // The command acknowledgement normally supplies this origin before the worker's first
      // observation. Its pending copy lives in recorder memory until a session exists, though,
      // so an app restart in that narrow gap used to create an origin-less worker session even
      // though the broker had durably restored the exact worker binding and task. Reconstitute
      // the same origin from that authoritative binding before the recorder creates the session.
      if (agent && agent !== 'prime') {
        const worker = swarmState().agents.find(
          (entry) => entry.id === agent && entry.role === 'worker' && entry.conversationId === id
        );
        if (worker) {
          await noteChatOrigin(id, {
            kind: 'worker',
            fromSessionId: null,
            agentId: worker.id,
            task: worker.task
          });
        }
      }
      const result = await recordChatObservations(id, observations, agent);
      // Workers are one-shot jobs. A settled assistant answer plus its matching turn_end is
      // first-hand page evidence that the worker has completed a turn; waiting for the model
      // to make another MCP call solely to say `finish` leaves normal final answers as zombie
      // workers forever. Historical assistant messages replayed on reload do not carry a fresh
      // matching turn_end in this batch, so they cannot terminalise a worker.
      const final = [...observations]
        .reverse()
        .find((entry) => entry.kind === 'assistant_message' && entry.final === true && entry.text && entry.turnId);
      if (
        final &&
        observations.some((entry) => entry.kind === 'turn_end' && entry.turnId === final.turnId)
      ) {
        const finished = finishWorkerConversation(id, final.text ?? 'Worker completed its task.');
        if (finished?.report) await recordAgentMessage(finished.report, 'sent');
      }
      return json(res, 200, { sessionId: result.sessionId, stored: result.stored }, origin);
    } finally {
      observationWritesInFlight -= 1;
    }
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
    if (id) {
      await closeConversation(id);
      forgetRetiredWorker(id);
      // The extension owns this lifecycle. A swarm whose prime chat is gone has nobody to
      // report to, and workers that keep going are tabs writing files for a run nobody is
      // reading — so the run ends here, rather than the model being asked whether it is
      // done. A Compact & Resume in flight is the one case this does not apply to, and the
      // broker knows that because the continuation pinned the prime binding before the old
      // chat was replaced.
      if (primeConversationGone(id)) logInfo(`bridge: the prime chat ${id} closed, so its run ended`);
      else if (workerConversationGone(id)) logInfo(`bridge: worker chat ${id} closed, so its worker slot was released`);
    }
    return json(res, 200, { ok: true }, origin);
  }

  // The activity feed the extension uses to relabel ChatGPT's tool blocks. It only
  // ever returns summaries of calls this app made — never file contents.
  if (route === '/activity') {
    const id = conversationId(url.searchParams.get('conversationId'));
    const since = Number(url.searchParams.get('since') ?? 0);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    const retiredWorker = retiredWorkerForConversation(id);
    // Every open ChatGPT tab polls this for its own conversation every few seconds, so
    // this is the app's primary first-hand evidence of which chats exist right now.
    let live = liveConversations().find((entry) => entry.conversationId === id);
    if (!live) {
      // `/activity` itself proves that this ChatGPT page is still open. After an app restart
      // the durable session can keep receiving exact MCP calls while the recorder's live map
      // is empty; returning an empty feed here leaves Overwrite stale forever. Reattach only
      // when a durable session already exists, so a random poll cannot manufacture history.
      await restoreRecordedConversation(id);
      live = liveConversations().find((entry) => entry.conversationId === id);
    }
    if (!live) {
      return json(res, 200, {
        sessionId: null,
        entries: [],
        stream: [],
        userAnchors: [],
        nextSince: Number.isFinite(since) ? Math.max(0, since) : 0,
        job: null,
        ...(retiredWorker ? { retiredWorker } : {})
      }, origin);
    }
    const summary = await getSession(live.sessionId);
    const requestedSince = Number.isFinite(since) ? Math.max(0, since) : 0;
    // A page reload begins at cursor zero. Never turn that into a full JSONL parse/response:
    // large audited sessions used to freeze the Electron main process here for tens of
    // seconds. The browser stream is presentation state, so send a bounded newest window and
    // explicitly tell the page to replace its local projection when its cursor predates it.
    const recent = await readRecentEvents(live.sessionId, 1200);
    const firstAvailable = recent.reduce((first, event) => Math.min(first, event.seq), Number.MAX_SAFE_INTEGER);
    const resetActivity =
      firstAvailable !== Number.MAX_SAFE_INTEGER &&
      requestedSince < firstAvailable &&
      !(requestedSince === 0 && firstAvailable === 1);
    const events = recent.filter((event) => resetActivity || event.seq >= requestedSince);
    // App-owned transcript feed. Presentation-only: raw tool I/O stays in the local
    // session store. This is the source the connected page will render chronologically.
    const stream = events.flatMap((event) => {
      const base = { seq: event.seq, time: event.time, turnId: event.turnId ?? null, agent: event.agent ?? null };
      switch (event.kind) {
        case 'tool_call':
          return [{ ...base, kind: 'tool_call', tool: event.call.tool, callId: event.call.callId,
            requestId: event.call.requestId ?? null,
            attribution: event.call.attribution, outcome: event.call.outcome, durationMs: event.call.durationMs,
            summary: event.call.summary, changes: event.call.changes ?? [] }];
        case 'progress':
          // One caption, at the position it first appeared. `origin` is what makes that
          // work from a cursor: the page has usually already consumed the first record and
          // will never see it again, so the supersession has to carry the seq it replaces.
          // Keying the page's own store by that seq is then the whole of "updated in place".
          return [
            {
              ...base,
              seq: event.origin ?? event.seq,
              kind: 'progress',
              text: event.message.text,
              progressId: event.progressId ?? null
            }
          ];
        case 'page_tool':
          // Same supersession contract as `progress`, for the same reason: ChatGPT rewrites
          // an activity row's label as the step lands, and the page's store keys on the seq
          // of the first record so the rewrite updates that row instead of adding one.
          return [
            {
              ...base,
              seq: event.origin ?? event.seq,
              kind: 'page_tool',
              label: event.label,
              messageId: event.messageId
            }
          ];
        case 'assistant_message':
          return [{
            ...base,
            kind: 'assistant_message',
            text: event.message.text,
            renderedHtml: event.renderedHtml?.text ?? '',
            state: event.state ?? (event.final ? 'final' : 'streaming'),
            final: event.final,
            messageId: event.messageId ?? null,
            origin: event.origin ?? event.seq
          }];
        case 'agent_message':
          return [{ ...base, kind: 'agent_message', from: event.from, to: event.to, text: event.message.text,
            delivery: event.delivery, messageId: event.messageId }];
        case 'chat_error':
          return [{ ...base, kind: 'chat_error', text: event.message.text }];
        case 'turn_start':
          return [{ ...base, kind: 'turn_start' }];
        case 'turn_end':
          return [{ ...base, kind: 'turn_end', outcome: event.outcome, detail: event.detail ?? '' }];
        default:
          return [];
      }
    });
    // Stable page-authored boundaries for presentation reconciliation. The extension only
    // needs identity and order here, never the user's text: a visible assistant response is
    // exactly the response after one visible user message, even when our own local
    // turn_start/turn_end lifecycle was split by a reload or a transient terminal marker.
    // Keeping anchors separate from `stream` means they can participate in the join without
    // ever becoming synthetic transcript rows.
    const userAnchors = events.flatMap((event) =>
      event.kind === 'user_message' && event.messageId
        ? [{ seq: event.origin ?? event.seq, time: event.time, messageId: event.messageId }]
        : []
    );

    // Legacy tool-only view, kept only while the old native-row relabeller is still a
    // fallback. It is derived from the same stream cursor and contains no raw args/result.
    const nextSince = events.reduce((next, event) => Math.max(next, event.seq + 1), requestedSince);

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
              // ChatGPT's own id for the connector request this call answered, from the
              // `x-request-id` it sent. `turnId` is a `data-turn-id`, which is minted per
              // page load — the same turn is `g-…` while it streams and `request-WEB:…`
              // after a refresh — so it cannot survive a reload, and without this the
              // relabeller had nothing durable left to match a reloaded transcript on.
              requestId: event.call.requestId ?? null,
              attribution: event.call.attribution,
              outcome: event.call.outcome,
              durationMs: event.call.durationMs,
              summary: event.call.summary,
              changes: event.call.changes ?? [],
              // Raw arguments stay in the local session store; browser rendering needs only the summary.


              agent: event.agent ?? null
            }
          ]
        : []
    );
    return json(
      res,
      200,
      {
        sessionId: live.sessionId,
        generating: live.generating,
        // What the *currently attached* chat is carrying, not what the local session has
        // accumulated over its whole life. A session that has been compacted keeps its
        // history and its identity across the move, so a meter reading the lifetime figure
        // would come back full the moment the replacement chat opened and compact it again.
        tokens: summary?.contextTokens ?? 0,
        // Over the line *and* mid-turn. Both halves matter: the level is what makes it
        // fire at all, and the liveness is what keeps it off a stale chat that is merely
        // being opened — see chatIsWorking.
        autoCompactReady: autoCompactionReady(summary) && chatIsWorking(live.conversationId),
        // What the composer's meter fills against, and what its automatic trigger fires
        // on. Sent from here rather than worked out in the page so that the bar someone
        // is watching and the threshold that acts are the same number: a meter that
        // filled against a figure of its own would show a full bar and do nothing, or
        // compact a conversation that still looked half empty.
        context: contextView(),
        // This chat was opened by the app, so its first user message is not the user's —
        // it is the handoff brief or the worker bootstrap this app typed. The page uses
        // it to fold that message away. Read off the session record rather than remembered
        // in the tab, so it still holds after a reload, days later.
        bootstrap: summary?.origin?.kind ?? null,
        entries,
        stream,
        userAnchors,
        resetActivity,
        truncatedFrom: resetActivity ? firstAvailable : null,
        nextSince,
        // How this chat's own Compact & Resume is going, so the page can say what is
        // happening instead of spinning.
        job: resumeJobFor(live.sessionId),
        // Local calls still running in this process. ChatGPT-native compaction waits for
        // this to reach zero after interrupting the turn, so the handoff is written about
        // a settled machine rather than one mid-edit.
        pendingTools: inFlightToolCalls(),
        // The generation this chat currently has open, if it has one. A content script that
        // has just been reloaded into a turn already in flight adopts this instead of
        // minting a second id for the same run. See liveConversations().
        activeTurnId: live.activeTurnId ?? null,
        ...(retiredWorker ? { retiredWorker } : {})
      },
      origin
    );
  }

  /**
   * Claims the one durable automatic-compaction edge for this chat.
   *
   * This is intentionally separate from `/compact`: the browser claims *before* it starts
   * the stop-and-settle barrier. A failed barrier, reload or lost response can therefore
   * never turn one threshold crossing into an automatic retry loop.
   */
  if (route === '/compact/claim-auto' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
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
    // A claim is only meaningful while this chat is still mid-turn: an automatic compaction
    // is a handoff *out of work in progress*, and once the answer has landed there is
    // nothing left to carry across. Checked again inside the durable write, so a turn that
    // finishes while the claim is queued leaves the trigger unspent for the next one.
    if (!chatIsWorking(id)) return json(res, 200, { claimed: false, sessionId }, origin);
    const claimed = await claimAutoCompaction(sessionId, id, () => chatIsWorking(id));
    return json(res, 200, { claimed, sessionId }, origin);
  }

  /**
   * Compact & Resume, all of it, in one route.
   *
   * Three shapes, because it is one button with one transaction behind it:
   *
   *   open    — `{conversationId}`: start the continuation and hand back the prompt the page
   *             injects, plus the token every later step quotes.
   *   capture — `{conversationId, token, summary}`: the page watched the compaction turn
   *             finish and is handing over the final assistant answer for *that* generation.
   *             That text is the brief; there is no tool call to make and nothing to save.
   *   cancel  — `{conversationId, cancel: true}`: give up, and stay in this chat.
   *
   * Nothing here opens a chat on its own. The replacement is queued only once a brief
   * exists, which is the whole of "an interrupted or empty compaction leaves you where you
   * were".
   */
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

    if (body['cancel'] === true) {
      const cancelled = cancelResume(sessionId);
      return json(res, 200, { cancelled, sessionId, job: resumeJobFor(sessionId) }, origin);
    }

    // The capture. The page is the only party that can tell which output belongs to the
    // compaction turn, and it says so by quoting the token it was given when that turn was
    // marked. A brief for a continuation that has moved on is answered with what is already
    // stored rather than written again — see attachSummary.
    if (typeof body['summary'] === 'string') {
      const token = typeof body['token'] === 'string' ? body['token'] : '';
      const entry = continuationByToken(token);
      if (!entry || entry.sessionId !== sessionId) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const handoff = await attachSummary(token, boundBrief(String(body['summary'])));
      if (!handoff) {
        return json(
          res,
          409,
          { error: 'brief_not_stored', sessionId, job: resumeJobFor(sessionId) },
          origin
        );
      }
      const command = queueResume(sessionId, token);
      logInfo(`bridge: captured the compaction brief for ${sessionId}; opening the replacement chat`);
      return json(
        res,
        200,
        { stored: true, sessionId, handoffId: handoff.id, commandId: command?.id ?? null, job: resumeJobFor(sessionId) },
        origin
      );
    }

    // The same press arriving again — an impatient second click, a retried request — is the
    // same transaction, answered with itself. That idempotency lives in openContinuation.
    const already = continuationForSession(sessionId);
    if (already && already.state !== 'awaiting-summary') {
      return json(res, 200, { started: false, sessionId, token: already.token, job: resumeJobFor(sessionId) }, origin);
    }

    const opened = openContinuation(sessionId, id);
    // Remembered from the press, not from the queued chat: a transaction that fails before
    // anything is queued still has to be reportable, or the page polls a button that says
    // nothing about the compaction it just watched fail.
    rememberToken(sessionId, opened.token);
    changed();
    // The instruction leaves this route once per transaction. A second request for the same
    // continuation — a retried POST whose answer was lost, a reloaded tab, an impatient
    // second press — is answered with the token and nothing to submit, because submitting it
    // again would start a second compaction turn for one transaction and leave two answers
    // each claiming to be the brief. A page that already armed one is watching it; a page
    // that did not can only wait or cancel.
    const armed = armContinuation(opened.token);
    logInfo(
      armed
        ? `bridge: browser started Compact & Resume for ${sessionId} (${opened.token.slice(0, 8)})`
        : `bridge: browser asked again for a compaction already under way for ${sessionId}`
    );
    return json(
      res,
      armed ? 202 : 200,
      {
        started: armed,
        armed: !armed,
        sessionId,
        token: opened.token,
        // The prompt the page injects as the compaction turn. Its answer is the brief.
        prompt: armed ? nativeHandoffPrompt() : null,
        job: resumeJobFor(sessionId)
      },
      origin
    );
  }

  // The targeted-open path: one page, opened by the app, redeeming the one command the
  // app opened it for. The id is not a credential — this route is behind the same bearer
  // token as everything else — it is a correlation marker, which is why a leaked URL or a
  // synced history entry is worth nothing on its own.
  if (route === '/commands/redeem' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    tidyCommands();
    const wanted = typeof body['id'] === 'string' ? body['id'] : '';
    const client = typeof body['client'] === 'string' ? body['client'].slice(0, 64) : '';
    const command = commands.find((entry) => entry.id === wanted);
    if (!command) {
      // Cancelled, superseded, already sent, or from a previous run of the app. The page
      // does nothing, which is the point: a stale marker must never type anything.
      return json(res, 404, { error: 'no_such_command' }, origin);
    }
    // One command, one page. `client` is the page's own per-document id, and the first one
    // to redeem owns the command until its lease lapses — a second tab on the same marker
    // is told there is nothing for it, while the owner's own retries are the same owner and
    // are answered every time.
    //
    // This is what makes the marker safe to be in a URL. A marker can be reloaded, synced,
    // restored by "reopen closed tab", or opened twice by a user watching a slow tab; every
    // one of those is a second page that would otherwise be handed the same brief and send
    // it, and two replacement chats for one session is the failure the whole continuation
    // transaction exists to make impossible.
    if (!client) return json(res, 400, { error: 'bad_client' }, origin);
    if (command.owner && command.owner !== client && isLeased(command)) {
      return json(res, 409, { error: 'command_taken' }, origin);
    }
    command.owner = client;
    // Renew rather than count another attempt: the app already spent one opening this
    // page, and this is that same attempt arriving.
    command.claimedAt = Date.now();
    // `claim()` armed the original browser-open deadline. A page can legitimately spend a
    // large part of that window just getting Chrome/ChatGPT started before it redeems the
    // marker, and content.js then has its own bounded composer + conversation-id wait. Merely
    // moving `claimedAt` made `isLeased()` say the lease was fresh while the old timer still
    // expired it at the original wall-clock deadline. Renew both halves of the lease here.
    armDeadline(command);
    changed();
    persistCommands();
    return json(res, 200, { command: describe(command, client) }, origin);
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
    const status: AckStatus = raw === 'failed' ? 'failed' : 'sent';
    const error = typeof body['error'] === 'string' ? body['error'].slice(0, 200) : null;
    const client = typeof body['client'] === 'string' ? body['client'].slice(0, 64) : '';
    // Binding first: a tab that reported its conversation but timed out before sending
    // should still have its agent filed correctly.
    const conversation = conversationId(body['conversationId']);
    const ownedCommand = commands.find((command) => command.id === id) ?? null;
    // Every current page echoes its per-document client. If its command has already expired,
    // been cancelled or been superseded, accepting the late ACK as success strands a real
    // tab whose model can never be bound to the worker/session it was opened for. Legacy
    // protocol pages omitted client and keep their old idempotent no-op response.
    if (!ownedCommand && client) {
      return json(res, 404, { error: 'no_such_command' }, origin);
    }
    // The document that redeemed the marker is the only document allowed to finish it.
    // `client` is optional on the wire for compatibility with an extension already open
    // during an app upgrade, but every current page sends it. When present, fail closed if
    // the command has since been superseded/released or another document owns it: accepting
    // a delayed ACK from the old page could otherwise bind a worker or commit a continuation
    // to the wrong chat after ownership had moved.
    if (ownedCommand && client && ownedCommand.owner !== client) {
      return json(res, 409, { error: 'command_owner_changed' }, origin);
    }
    const agent = ownedCommand?.spec.type === 'worker' ? ownedCommand.spec.agent : null;
    // This is where a worker starts. The extension is the only party that knows which fresh
    // tab it opened for which slot, and it knows it before the model in that tab has said
    // anything — so binding here makes the worker active before it reads its task, and every
    // later call from that chat routes by the conversation alone. Nothing is asked of the
    // model to make that true. It binds once: a later report naming a different chat for the
    // same worker is refused, not obeyed.
    if (agent && conversation && /^[a-z0-9-]{1,40}$/i.test(agent)) bindConversation(agent, conversation);
    // The one moment at which the queued command and the conversation it became are
    // both in hand, and so the only chance to name that chat after the work rather
    // than after the bootstrap prompt about to be typed into it.
    const opened = status === 'sent' ? commandOrigin(id) : null;
    if (conversation && opened) {
      await noteChatOrigin(conversation, opened).catch((err: Error) =>
        logWarn(`could not record the origin of a fresh chat: ${err.message}`)
      );
    }
    // The moment the app learns which chat the replacement turned out to be, and therefore
    // the only moment the session can be moved. Committing here — rather than asking the
    // model to present a handover key it can fail to carry — is what keeps the session, its
    // workspace and its swarm together across a compaction. A commit that does not land
    // leaves the session in the old chat and the command unfinished, so it is retried.
    let moved = true;
    if (status === 'sent') {
      const command = commands.find((entry) => entry.id === id);
      if (command?.spec.type === 'resume') {
        moved = conversation ? await commitContinuation(command.spec.token, conversation) : false;
        if (!moved) {
          logWarn(`bridge: the replacement chat for ${command.spec.sessionId} could not take the session over`);
          ackCommand(id, 'failed', 'the replacement chat could not take the session over');
          return json(res, 200, { ok: true, committed: false }, origin);
        }
      }
    }
    ackCommand(id, status, error);
    return json(res, 200, { ok: true, committed: moved }, origin);
  }

  return json(res, 404, { error: 'not_found' }, origin);
}

// ------------------------------------------------------------ stale swarm

interface DurableQuiescence {
  quiescent: boolean;
  ended: boolean;
  lastOutcome: string | null;
}

/**
 * Durable proof that one bound ChatGPT conversation has been inactive long enough to treat
 * as orphaned. Silence by itself is never enough: a still-open turn fails this check even if
 * its last write is hours old.
 */
async function durableQuiescence(conversationId: string, now: number): Promise<DurableQuiescence> {
  const live = liveConversations().find((entry) => entry.conversationId === conversationId);
  if (live?.generating) return { quiescent: false, ended: false, lastOutcome: null };
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) return { quiescent: false, ended: false, lastOutcome: null };
  const modifiedAt = await sessionDurableModifiedAt(summary.id);
  const lastDurableWrite = Math.max(summary.updatedAt, summary.endedAt ?? 0, modifiedAt ?? 0);
  if (lastDurableWrite <= 0 || now - lastDurableWrite < STALE_SWARM_MS) {
    return { quiescent: false, ended: summary.endedAt !== null, lastOutcome: summary.lastTurnOutcome };
  }

  let lastOutcome: string | null = summary.lastTurnOutcome;
  if (summary.activeTurnId) return { quiescent: false, ended: summary.endedAt !== null, lastOutcome };
  // Pre-1.8.8 metadata has no durable open-turn projection. Bound that one migration path
  // to the newest tail instead of reparsing the full lifetime on every 30-second sweep.
  if (summary.activeTurnId === undefined) {
    const openTurns = new Set<string>();
    for (const event of await readRecentEvents(summary.id, 4096, { kinds: ['turn_start', 'turn_end'] })) {
      if (event.kind === 'turn_start' && event.turnId) openTurns.add(event.turnId);
      else if (event.kind === 'turn_end') {
        if (event.turnId) openTurns.delete(event.turnId);
        lastOutcome = event.outcome;
      }
    }
    if (openTurns.size > 0) return { quiescent: false, ended: summary.endedAt !== null, lastOutcome };
  }
  if (summary.endedAt !== null) return { quiescent: true, ended: true, lastOutcome };
  // A live-but-idle session needs one durable terminal turn. A session with only a bootstrap
  // message and no turn_end is not proof that ChatGPT ever finished the worker/prime turn.
  return { quiescent: lastOutcome !== null, ended: false, lastOutcome };
}

/**
 * Retires only runs that durable state proves are quiescent/orphaned.
 *
 * Immediate cleanup remains the normal path: worker Turn completed terminalises its slot,
 * and the prime's next authenticated MCP call acknowledges final reports and releases the run.
 * This sweep exists for the abandoned-tail case where no such next call arrives.
 */
export async function sweepStaleSwarm(now = Date.now()): Promise<boolean> {
  const runId = currentRunId();
  if (!runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;

  let state = swarmState();
  if (!state.running) return false;

  // First recover the case where browser completion was durably recorded but the bridge died
  // before finishWorkerConversation() ran. Invited/unbound workers remain the bootstrap
  // timeout's responsibility; there is no conversation/session whose inactivity we can prove.
  for (const worker of state.agents.filter((agent) => agent.role === 'worker' && agent.state !== 'finished' && agent.state !== 'failed')) {
    if (!worker.conversationId) continue;
    const proof = await durableQuiescence(worker.conversationId, now);
    if (currentRunId() !== runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;
    if (!proof.quiescent) continue;

    if (proof.lastOutcome === 'completed') {
      const finished = finishWorkerConversation(
        worker.conversationId,
        'Worker turn completed and remained durably inactive for the orphan grace period.'
      );
      if (finished?.report) await recordAgentMessage(finished.report, 'sent');
    } else {
      const failed = failAgent(
        worker.id,
        proof.ended
          ? 'the worker session ended and remained durably inactive'
          : `the worker turn ended ${proof.lastOutcome ?? 'without a completed outcome'} and remained durably inactive`,
        `[${worker.id} stale] Its ChatGPT work is durably quiescent after the orphan grace period. The worker slot is free.`
      );
      if (failed?.report) await recordAgentMessage(failed.report, 'sent');
    }
  }

  if (currentRunId() !== runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;
  state = swarmState();
  const workers = state.agents.filter((agent) => agent.role === 'worker');
  if (workers.length === 0 || workers.some((agent) => agent.state !== 'finished' && agent.state !== 'failed')) return false;

  // Normal safe release: every final report has already been acknowledged.
  if (releaseQuiescentRun()) return true;

  // Orphan fallback may discard still-pending final reports only after the prime and every
  // bound terminal worker are themselves durably quiescent for the full grace period.
  const prime = state.agents.find((agent) => agent.role === 'prime') ?? null;
  if (!prime?.conversationId) return false;
  const primeProof = await durableQuiescence(prime.conversationId, now);
  if (!primeProof.quiescent) return false;
  for (const worker of workers) {
    if (!worker.conversationId) continue;
    const proof = await durableQuiescence(worker.conversationId, now);
    if (!proof.quiescent) return false;
  }
  if (currentRunId() !== runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;
  return releaseQuiescentRun({
    allowPendingReports: true,
    reason: 'all workers are terminal and the run remained durably quiescent past the orphan grace period'
  });
}

// -------------------------------------------------------------------- server

/** Unsubscribes this module's swarm-end listener. Held so a restart cannot double it. */
let dropSwarmEndListener: (() => void) | null = null;
let staleSwarmTimer: NodeJS.Timeout | null = null;
let staleSweepInFlight: Promise<boolean> | null = null;
let bridgeStarting: Promise<number | null> | null = null;

function runStaleSwarmSweep(): Promise<boolean> {
  if (staleSweepInFlight) return staleSweepInFlight;
  staleSweepInFlight = sweepStaleSwarm().finally(() => {
    staleSweepInFlight = null;
  });
  return staleSweepInFlight;
}

export async function startBridge(): Promise<number | null> {
  if (server) return port;
  if (bridgeStarting) return bridgeStarting;
  bridgeStarting = startBridgeOnce();
  try {
    return await bridgeStarting;
  } finally {
    bridgeStarting = null;
  }
}

async function startBridgeOnce(): Promise<number | null> {
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
      // Port 0 means the OS picked one; the socket knows which.
      const address = instance.address();
      const actual = typeof address === 'object' && address ? address.port : candidate;
      server = instance;
      port = actual;
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
      // When a run ends — cleared in the app, finished, or taken over by another chat —
      // its worker chats must stop existing everywhere at once. A queued bootstrap that
      // outlives its run is a tab that opens later, introduces itself as a worker of
      // something that is gone, and cannot join.
      //
      // `onSwarmEnd` keeps a set of listeners, so the disposer is held and released on
      // stop. Without that, a settings save that stops and starts the bridge left the
      // previous listener registered and the next run end cancelled commands and typed
      // stop notices once per restart the app had ever done.
      dropSwarmEndListener?.();
      dropSwarmEndListener = onSwarmEnd((reason) => {
        // Cancelling the queue stops the worker chats that have not opened yet. The ones
        // already open are not typed into: driving somebody's conversation to tell it to
        // stop is a second control channel, and the app has no business writing into a chat
        // it did not open for this. A worker whose run is gone finds that out the moment it
        // calls the connector, which is the only place it can act from anyway.
        cancelWorkerCommands(reason);
      });
      if (staleSwarmTimer) clearInterval(staleSwarmTimer);
      staleSwarmTimer = setInterval(() => {
        void runStaleSwarmSweep().catch((err: Error) => logWarn(`stale swarm sweep failed: ${err.message}`));
      }, STALE_SWARM_SWEEP_MS);
      staleSwarmTimer.unref?.();
      // Anything restored from the previous run goes out now rather than waiting for a
      // browser to come and ask.
      deliver();
      logInfo(`bridge listening on 127.0.0.1:${actual}`);
      changed();
      return actual;
    }
  }
  logWarn(`bridge could not bind any of ports ${PORTS.join(', ')}; the browser extension will not connect`);
  return null;
}

export async function stopBridge(): Promise<void> {
  // A settings save can race start and stop. Waiting here prevents stop from observing
  // `server === null`, returning, and then having an in-progress start publish a listener
  // after the app already considers the bridge down.
  if (bridgeStarting) await bridgeStarting.catch(() => null);
  const instance = server;
  if (!instance) return;
  server = null;
  port = null;
  for (const command of commands) {
    if (command.timer) clearTimeout(command.timer);
    command.timer = null;
  }
  dropSwarmEndListener?.();
  dropSwarmEndListener = null;
  if (staleSwarmTimer) clearInterval(staleSwarmTimer);
  staleSwarmTimer = null;
  await new Promise<void>((resolve) => {
    // Stop admission and drain accepted extension writes. Abruptly destroying sockets here
    // could lose an /events or /closed item after Chrome had already handed it to the app.
    // Keep shutdown bounded because a wedged localhost client must not pin Electron forever.
    let settled = false;
    const force = setTimeout(() => {
      if (settled) return;
      logWarn('bridge drain timed out after 15s; forcing remaining connections closed');
      instance.closeAllConnections();
    }, 15_000);
    force.unref?.();
    instance.closeIdleConnections?.();
    instance.close(() => {
      settled = true;
      clearTimeout(force);
      resolve();
    });
  });
  logInfo('bridge stopped');
  changed();
}

// ------------------------------------------------------------------ commands

function specKey(spec: CommandSpec): string {
  return spec.type === 'worker' ? `worker:${spec.agent}` : `resume:${spec.sessionId}`;
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
      lastError: command.lastError
    }))
  });
}

function queue(spec: CommandSpec): Command {
  const key = specKey(spec);
  const existing = commands.find((command) => specKey(command.spec) === key);
  if (existing) {
    // The same bootstrap arriving twice — a restart re-requesting a worker whose chat was
    // never bound, or the user pressing Compact & Resume again — is one job, not two tabs.
    const superseded = JSON.stringify(existing.spec) !== JSON.stringify(spec);
    if (superseded) {
      // Only a genuinely different bootstrap restarts the clock and takes the lease back.
      // An identical repeat must leave the claim alone: releasing it would let the
      // deliver() that follows open a second tab for a chat that is already opening,
      // which is precisely the storm of duplicate chats this queue exists to prevent.
      existing.createdAt = Date.now();
      existing.claimedAt = null;
      // Any page that redeemed the previous payload no longer owns the replacement. Current
      // pages echo their document client on ACK, so a late result from that old payload is
      // refused by /commands/ack rather than applied to this newer one.
      existing.owner = null;
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = null;
      // A newer handoff for the same chat replaces the older one in place. The queued job
      // stays one job — what changes is which handoff the fresh chat will be told to resume
      // — and its deadline starts again from this delivery, because this is new work.
      existing.spec = spec;
      existing.lastError = null;
    }
    changed();
    persistCommands();
    return existing;
  }
  const command: Command = {
    id: randomBytes(8).toString('hex'),
    spec,
    createdAt: Date.now(),
    claimedAt: null,
    timer: null,
    lastError: null,
    owner: null
  };
  commands.push(command);
  if (commands.length > MAX_COMMANDS) {
    // Through drop(), never a raw shift.
    //
    // A queued command is not just a row in an array: a worker command owns an `invited`
    // agent slot that only ever ends when something ends it, and a resume command owns a
    // job the page is sitting there waiting on. Shifting one out left both behind — the
    // worker counted towards the limit and held the single in-flight agent bootstrap so
    // nothing after it could open, and the resume job stayed `busy` with no command left
    // to finish it, which disables Compact & resume until the app restarts. Overflow is
    // rare, which is exactly why it must not be the one path that skips the cleanup.
    const oldest = commands[0];
    if (oldest) drop(oldest, 'the command queue was full and this was the oldest entry in it');
  }
  changed();
  persistCommands();
  return command;
}

// --------------------------------------------------------------- resume jobs

/**
 * One press of Compact & Resume, followed from the press to the fresh chat.
 *
 * The button used to be fire-and-forget, and the browser half guessed when it was done
 * by waiting a second and a half. A real compaction runs for minutes, so the user got an
 * enabled button back long before anything happened, pressed it again, and every press
 * became its own handoff and its own fresh tab — tabs that then arrived minutes later,
 * several at once. The job is the thing the page waits on instead of guessing: one per
 * session, from the press until the fresh chat has actually been opened, failed or been
 * cancelled.
 */
export type ResumeStage =
  /** ChatGPT was asked for the brief and has not finished writing it yet. */
  | 'handoff-pending'
  | 'opening'
  | 'waiting-for-browser'
  | 'done'
  | 'failed';

/**
 * What the page is told about a Compact & Resume in flight.
 *
 * Derived, never stored. The continuation transaction is the state — it knows whether a
 * brief exists, whether a replacement chat has claimed it and whether the move landed — and
 * this reads it, adding only the one thing the transaction cannot know: whether the browser
 * has actually been given the command yet. A job record of its own was a second copy of that
 * state, and the two could disagree about whether a session had moved.
 */
export interface ResumeJobView {
  sessionId: string;
  stage: ResumeStage;
  startedAt: number;
  /** True while the button must stay disabled. */
  busy: boolean;
  handoffId: string | null;
  error: string | null;
}

const RUNNING_STAGES = new Set<ResumeStage>(['handoff-pending', 'opening', 'waiting-for-browser']);

/**
 * The token of the last continuation opened for a session.
 *
 * The transaction itself is the state; this is only how the bridge finds it again, and it is
 * how a *finished* one can still be reported once — `continuationForSession` answers about
 * open transactions only, which is right for everything that acts on one, but a page polling
 * every two seconds still has to be told "that finished" rather than "there is nothing".
 */
const sessionTokens = new Map<string, string>();

function rememberToken(sessionId: string, token: string): void {
  sessionTokens.set(sessionId, token);
  if (sessionTokens.size > 50) {
    const oldest = sessionTokens.keys().next();
    if (!oldest.done) sessionTokens.delete(oldest.value);
  }
}

/** The job for a session, if there is one worth telling the page about. */
export function resumeJobFor(sessionId: string): ResumeJobView | null {
  const token = sessionTokens.get(sessionId);
  const entry = (token ? continuationByToken(token) : null) ?? continuationForSession(sessionId);
  if (!entry) return null;
  const command = commands.find((cmd) => cmd.spec.type === 'resume' && cmd.spec.sessionId === sessionId);
  const stage: ResumeStage =
    entry.state === 'committed'
      ? 'done'
      : entry.state === 'aborted'
        ? 'failed'
        : entry.state === 'awaiting-summary'
          ? 'handoff-pending'
          : command && !isLeased(command) && !openInBrowser
            ? 'waiting-for-browser'
            : 'opening';
  return {
    sessionId,
    stage,
    startedAt: entry.openedAt,
    busy: RUNNING_STAGES.has(stage),
    handoffId: entry.handoffId,
    error: entry.error
  };
}

/**
 * The context-window settings the composer needs, as one object.
 *
 * Both numbers the meter can fill against, plus whether anything acts on them. `warn` and
 * `limit` are the lines the app already draws in its own session view; `threshold` is the
 * one the user set for automatic compaction, and it only means anything while `auto` is
 * on. The page decides which to show, but it is not allowed to invent any of them.
 */
function contextView(): { auto: boolean; threshold: number; warn: number; limit: number } {
  const config = getConfig();
  return {
    auto: config.compaction.auto,
    threshold: config.compaction.autoTokens,
    warn: config.sessions.advisoryTokens,
    limit: config.sessions.limitTokens
  };
}

/**
 * Stops waiting on a session's resume and withdraws the replacement chat.
 *
 * The deliberate escape hatch: a compaction that will never finish, or a resume the user
 * changed their mind about, must not leave a tab to be opened later "when ChatGPT is next in
 * front of me" — which is exactly how the user ended up closing five chats. Aborting the
 * transaction is what makes a brief still being written land nowhere, and the session stays
 * attached to the chat it is in.
 */
export function cancelResume(sessionId: string): boolean {
  const token = sessionTokens.get(sessionId);
  const entry = token ? continuationByToken(token) : continuationForSession(sessionId);
  const aborted = entry ? abortContinuation(entry.token, 'cancelled') : false;
  const queued = commands.find((command) => command.spec.type === 'resume' && command.spec.sessionId === sessionId);
  if (queued) {
    commands = commands.filter((command) => command !== queued);
    persistCommands();
    logInfo(`bridge: cancelled the queued fresh chat for ${sessionId}`);
  }
  if (!aborted && !queued) return false;
  changed();
  return true;
}

/**
 * Queues the bootstrap for a worker chat.
 *
 * Called by the broker through onSpawnRequest. Nothing about identity is passed in or
 * stored: the chat this opens is bound to the slot by the extension's report, and the
 * recovery key exists only if the user asks the app for one after that has failed.
 */
export function queueWorkerBootstrap(agent: string, task: string): BridgeCommand | null {
  const command = queue({ type: 'worker', agent, task });
  deliver();
  return describe(command, null);
}

/**
 * Queues the replacement chat for a continuation whose brief has been captured.
 *
 * Keyed by session, and carrying the transaction's token rather than any text: the token is
 * the single-use authority for this move, so the command cannot become a second way of
 * claiming a continuation, and a second command for the same session folds into this one.
 */
export function queueResume(sessionId: string, token: string): BridgeCommand | null {
  rememberToken(sessionId, token);
  const command = queue({ type: 'resume', sessionId, token });
  changed();
  deliver();
  return describe(command, null);
}

// ----------------------------------------------------------------- delivery

/**
 * Opens a URL in the user's browser. Wired to Electron's shell at startup.
 *
 * Injected rather than imported so this module stays testable without Electron, and so
 * a build with no window (or a test) simply falls back to the polling path instead of
 * having a browser-launching side effect nobody asked for.
 */
let openInBrowser: ((url: string) => Promise<void>) | null = null;

export function setBrowserOpener(open: ((url: string) => Promise<void>) | null): void {
  openInBrowser = open;
}

/** Where the app sends the browser. The marker is an id, not a credential. */
export function commandUrl(id: string, conversationId?: string | null): string {
  // Both a query and a fragment: ChatGPT is a single-page app that rewrites its own URL
  // during boot, and which of the two survives has changed between builds. The content
  // script accepts either, and redeeming still requires the extension's bearer token —
  // so a copied link, a history entry or a synced tab is worth nothing on its own.
  const marker = `clf=${encodeURIComponent(id)}`;
  // A continuation opens the worker's own conversation rather than a new one. The page
  // still has to redeem the marker, and the command it gets back names this same
  // conversation, so the two have to agree before anything is typed.
  const base = conversationId ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}` : 'https://chatgpt.com/';
  return `${base}?${marker}#${marker}`;
}

/**
 * Sends the next queued bootstrap to the browser, now. The only way one is ever delivered.
 *
 * This is the whole answer to "the fresh chat opened five minutes late, or only once I
 * happened to open ChatGPT again". Delivery used to be pull-only: the app queued a command
 * and waited for some ChatGPT tab's content script to poll for it, which meant a browser
 * with no ChatGPT tab open — or no browser at all — was a queue that nothing drained, and
 * which tab picked the job up was whichever one happened to ask. Opening the target chat
 * directly makes the app the active party: it launches the browser if it is closed, creates
 * the tab if there is none, and the marker in the URL tells that one page which command it
 * is for, so no other tab and no global pending slot is involved.
 *
 * The poll route is gone with it, and so is the recovery it offered. One press opens one
 * chat; if that does not work, it fails and says so, rather than leaving a job in a queue
 * for a tab that may open in an hour.
 */
function deliver(): void {
  tidyCommands();
  const command = nextDeliverable();
  if (!command) return;
  if (!openInBrowser) {
    // Nothing can open a browser in this process, and nothing will come and ask. Ending it
    // here is what keeps the failure honest: the continuation stays in the chat it is in and
    // the worker slot fails, instead of a job sitting in a queue that has no reader.
    drop(command, 'this app has no way to open a browser window');
    return;
  }
  claim(command);
  const url = commandUrl(command.id);
  logInfo(`bridge: opening a fresh ChatGPT chat for ${specKey(command.spec)}`);
  void openInBrowser(url).catch((err: Error) => {
    // One command is one browser-open attempt. A rejected opener can never produce an ACK,
    // so leaving the row unleased merely blocks everything behind it until some unrelated
    // future action calls deliver() again. End it honestly and immediately, then advance.
    const why = `the browser could not be opened (${err.message})`;
    command.lastError = why;
    drop(command, why);
    deliver();
  });
}

/**
 * Arms the one-shot that ends this command if its deadline passes.
 *
 * The whole clock of the delivery path. Unref'd, so a pending bootstrap can never hold
 * the app (or a test run) open, and disarmed by `retire()` on every path that finishes a
 * command — so a command that succeeds costs one cleared timer and nothing else.
 */
function armDeadline(command: Command): void {
  if (command.timer) clearTimeout(command.timer);
  command.timer = setTimeout(() => {
    command.timer = null;
    expire(command);
  }, COMMAND_DEADLINE_MS);
  command.timer.unref?.();
}

/**
 * The deadline passed. Decide what actually happened, then end it either way.
 *
 * Two of the three outcomes are quiet successes that simply have no acknowledgement of
 * their own: a worker whose chat was bound is done being a command, and a command already
 * gone has nothing left to end. The third is the failure this design chose over retrying —
 * the tab never redeemed, or redeemed and never typed, or typed into a chat it never named
 * — and `drop()` is what makes it safe: the continuation is aborted and its session stays
 * where it is, or the worker slot is failed so the prime stops waiting on a chat that does
 * not exist. Nothing is left pending for a later sweep to find.
 */
function expire(command: Command): void {
  if (!commands.includes(command)) return;
  const spec = command.spec;
  if (spec.type === 'worker' && !pendingWorkerSpawns().some((worker) => worker.id === spec.agent)) {
    retire(command, 'its worker is bound and running');
    return;
  }
  drop(command, command.lastError ?? 'the chat this app opened did not report back in time');
  deliver();
}

/** Finishes a command that has nothing left to do, timer and all. */
function retire(command: Command, why: string): void {
  if (command.timer) clearTimeout(command.timer);
  command.timer = null;
  if (!commands.includes(command)) return;
  commands = commands.filter((entry) => entry !== command);
  logInfo(`bridge: ${specKey(command.spec)} is done — ${why}`);
  changed();
  persistCommands();
}

/**
 * The text the extension types, built fresh for each attempt.
 *
 * A resume is handed the brief itself, as an ordinary first message. There is no tool call
 * to make, no handoff id to quote and no handshake to get wrong: the model in the new chat
 * reads what the model in the old chat wrote, which is the only thing the brief was ever
 * for. Everything the *app* needs to carry across — the session, its history, its workspace,
 * its swarm — travels through the rebind instead, and none of it depends on the model doing
 * anything at all.
 */
function bootstrapText(spec: CommandSpec, summary: string): string {
  if (spec.type === 'worker') {
    // The task, and then how to report — nothing about identity, because there is nothing
    // for the model to do about it. This chat was opened for a worker slot and is bound to
    // it by the extension's report before this text is read, so there is no join to make, no
    // key to carry and no handshake to get wrong. A worker that opened this and started
    // working immediately is behaving exactly as designed.
    return (
      `${spec.task}\n\n` +
      '(You are a worker agent in a ChatGPT Local Files multi-agent run, and this app already knows which worker ' +
      'this chat is. Message the prime agent with the agents tool, action=message to="prime", when you find something ' +
      'that would change what should be done — then carry on; replies arrive on later tool results, so never wait or ' +
      'poll. Call agents action=finish once, at the end, with your result: it is terminal. Everything goes through the ' +
      'prime agent; do not try to contact other workers.)'
    );
  }
  return (
    'Continuing a ChatGPT Local Files session that was compacted. This is the brief the previous chat wrote about ' +
    'its own work; carry on from it rather than starting again.\n\n' +
    summary
  );
}

/**
 * The wire form of a command, and — for a resume — the moment its brief is claimed.
 *
 * Claiming here rather than at queue time is what makes the transaction's one-claim rule
 * mean something: the claimant is the page that redeemed the marker, so that page's own
 * retries are the same claim while a second page is refused — by the redeem route before it
 * gets here, and by the transaction itself if it somehow does. A continuation that can no
 * longer be claimed yields no text, and the command carries nothing to type.
 */
function describe(command: Command, client: string | null): BridgeCommand {
  const spec = command.spec;
  // The claimant is the *page*, not the command: a command is a piece of work, and a piece
  // of work can be offered to a second tab after the first one dies. Claiming under the
  // command id would make every tab that ever redeemed this marker the same claimant, which
  // is the one thing the transaction's single-claim rule is there to prevent.
  const claimed = spec.type === 'resume' && client ? claimContinuation(spec.token, `${command.id}:${client}`) : null;
  // A resume that has not been claimed carries no text at all, rather than the wrapper with
  // an empty brief inside it. The polling listing is only "there is work, open a marked
  // tab"; the brief exists on the wire exactly once, in the reply to the page that redeemed.
  const text = spec.type === 'resume' && !claimed ? '' : bootstrapText(spec, claimed?.summary ?? '');
  return {
    id: command.id,
    kind: 'open-chat',
    text,
    agent: spec.type === 'worker' ? spec.agent : null
  };
}

function drop(command: Command, why: string): void {
  if (command.timer) clearTimeout(command.timer);
  command.timer = null;
  if (!commands.includes(command)) return;
  commands = commands.filter((entry) => entry !== command);
  // A resume whose replacement chat never opened has to end its transaction too, or the
  // session sits "opening" forever with nothing coming. Aborting leaves the session
  // attached to the chat it is already in, which is the safe side of this failure.
  if (command.spec.type === 'resume') abortContinuation(command.spec.token, why);
  // Giving up on a worker's chat has to end the worker, not just the command. Deleting
  // the command alone left the slot `invited` for good: it counted towards the worker
  // limit, it held the one in-flight agent-bearing bootstrap so the next worker never
  // opened, it kept the run looking alive to takeover, and the prime went on waiting for
  // a report from a chat that does not exist.
  if (command.spec.type === 'worker') failAgent(command.spec.agent, why);
  logWarn(`bridge: gave up on ${specKey(command.spec)} — ${why}`);
  changed();
  persistCommands();
  // Deliberately no deliver() here: a drop is always either inside a deliver() already or
  // immediately followed by one (queue() overflow, whose two callers both deliver on the
  // next line), and the next command — usually the worker that was queued behind this one
  // — is picked up by the nextDeliverable() that follows the tidy pass. Calling deliver()
  // from here would reenter it mid-pass instead.
}

/**
 * Retires and expires commands. Run before anything is handed out or delivered.
 */
function tidyCommands(): void {
  const now = Date.now();
  const pendingWorkers = new Set(pendingWorkerSpawns().map((worker) => worker.id));
  for (const command of [...commands]) {
    const workerAgent = command.spec.type === 'worker' ? command.spec.agent : null;
    if (workerAgent && !pendingWorkers.has(workerAgent)) {
      // The slot was bound (or the run ended) since this was queued, so there is nothing
      // left for a chat to be opened for.
      retire(command, 'its worker is bound and running');
      continue;
    }
    if (now - command.createdAt > COMMAND_TTL_MS) {
      drop(command, 'it has been waiting too long to still be what the user expects');
    }
  }
}

/** Whether a page is already working on this command, with time still on its deadline. */
const isLeased = (command: Command): boolean =>
  command.claimedAt !== null && Date.now() - command.claimedAt < COMMAND_DEADLINE_MS;

/**
 * The one command that may go to the browser right now, or null.
 *
 * One at a time, whatever kind it is. The browser half can only be opening one tab anyway,
 * and a worker chat is identified by the extension reporting which tab it opened for which
 * slot — so two bootstraps in flight is precisely the state where that report can be made
 * about the wrong tab.
 */
function nextDeliverable(): Command | null {
  if (commands.some(isLeased)) return null;
  return commands[0] ?? null;
}

/**
 * Takes the lease for the one attempt this command gets.
 *
 * Nothing is minted here and nothing is handed to a model. A worker chat is authenticated by
 * being the chat this app opened for the slot — the extension reports which one that was —
 * and a resume is authenticated by the continuation token the app holds. There is no
 * capability travelling through tool arguments in either direction.
 */
function claim(command: Command): void {
  // A new attempt is a new page. The tab that held the last one is gone or has stopped
  // answering — that is what expiring the lease means — so whichever page redeems next owns
  // it, and the continuation is claimed under that page rather than the dead one.
  command.owner = null;
  command.claimedAt = Date.now();
  armDeadline(command);
  changed();
  persistCommands();
}

/**
 * What a page reports about the one command it was opened for.
 *
 * Two outcomes, both final. There was a third — `working`, sent from a periodic tick while
 * the page was still typing — and it existed to push the deadline out; it is gone with the
 * ticker that sent it. A bootstrap now either lands inside its one deadline or fails, and
 * failing is an ending rather than a pause: this app opens exactly one chat per press, and
 * a chat that could not be started is reported rather than quietly retried into existence
 * minutes later.
 */
type AckStatus = 'sent' | 'failed';

/** What a queued command says the chat it opened is for. Null once the command is gone. */
function commandOrigin(id: string): SessionOrigin | null {
  const spec = commands.find((entry) => entry.id === id)?.spec;
  if (!spec) return null;
  if (spec.type === 'worker') return { kind: 'worker', fromSessionId: null, agentId: spec.agent, task: spec.task };
  return { kind: 'resume', fromSessionId: spec.sessionId, agentId: null, task: '' };
}

function ackCommand(id: string, status: AckStatus, error: string | null): void {
  const command = commands.find((entry) => entry.id === id);
  if (!command) return;
  if (status === 'sent') {
    if (command.spec.type === 'worker') {
      // Binding is the completion boundary, and by now it has either happened or it never
      // will: the same request bound the agent a few lines above, from the conversation the
      // page reported. A bound worker is a running worker, so the command is done — it used
      // to stay leased here "waiting for the worker to join", which is a step that no longer
      // exists. A worker that is still pending could not be identified at all: the page typed
      // the task into a chat this app cannot name, so nothing that chat does can ever reach
      // the run. That is a failure rather than something to wait out, and failing the slot is
      // what stops the prime waiting on a chat nobody can reach.
      const agent = command.spec.agent;
      if (pendingWorkerSpawns().some((worker) => worker.id === agent)) {
        drop(command, 'the chat this app opened for it never said which conversation it was');
      } else {
        retire(command, 'the worker is bound to its chat and running');
      }
    } else {
      // A resume is already committed by the time an ack says "sent" — the route commits
      // before it gets here, and refuses the ack if it could not. So the command is simply
      // done, and the transaction is the record of what happened to the session.
      retire(command, 'the fresh chat has the brief');
    }
  } else {
    // A page that says it failed has already exhausted its own in-page attempts, so there
    // is nothing left to wait for and nothing to hand to anybody else: this command ends
    // here, and ends its worker or its continuation with it. Waiting out the deadline
    // first would only delay the same answer.
    command.claimedAt = null;
    command.lastError = error;
    drop(command, error ? `the browser could not start the chat — ${error}` : 'the browser could not start the chat');
  }
  changed();
  persistCommands();
  // A retired or released command may be what was blocking the next one — the second
  // worker of a swarm, most often. Send it now rather than at the next tick.
  deliver();
}

/**
 * Withdraws queued worker chats, immediately.
 *
 * Cancellation has to reach the browser in the same beat as the app: the queue is
 * emptied here, and the next /commands poll tells the extension which ids are still
 * alive so a tab it is already holding a bootstrap for is dropped rather than opened.
 *
 * With `agent`, only that worker's bootstrap is withdrawn. Clearing one slot must not
 * take the queued tabs of its siblings with it — the whole-run form is what `onSwarmEnd`
 * uses, and pointing it at a single agent is what makes a per-worker clear safe.
 */
export function cancelWorkerCommands(reason: string, agent?: string): number {
  const doomed = commands.filter(
    (command) => command.spec.type === 'worker' && (agent === undefined || command.spec.agent === agent)
  );
  if (doomed.length === 0) return 0;
  const dead = new Set(doomed.map((command) => command.id));
  commands = commands.filter((command) => !dead.has(command.id));
  const what = agent === undefined ? 'worker chat(s)' : `worker chat(s) for ${agent}`;
  logInfo(`bridge: cancelled ${doomed.length} queued ${what} — ${reason}`);
  changed();
  persistCommands();
  // No deliver() here on purpose. drop() reaches this path from inside a delivery and
  // documents that its callers are already in one; the next poll picks up whatever was
  // queued behind the cancelled command.
  return doomed.length;
}

/** What the UI shows about work waiting on the browser. */
export function pendingCommands(): Array<{ id: string; what: string; lastError: string | null }> {
  return commands.map((command) => ({
    id: command.id,
    what: specKey(command.spec),
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
    // Worker bootstraps only. A resume's authority is its continuation transaction, which
    // lives in memory and does not survive a restart — so there is nothing left for the
    // replacement chat to claim, and the session simply stays in the chat it is in.
    if (spec.type !== 'worker') continue;
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    if (now - createdAt > COMMAND_TTL_MS) continue;
    if (commands.some((entry) => specKey(entry.spec) === specKey(spec))) continue;
    commands.push({
      id: raw.id,
      spec,
      createdAt,
      claimedAt: null,
      timer: null,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      owner: null
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
  resetContinuationsForTests();
  sessionTokens.clear();
  openInBrowser = null;
  lastSeenAt = null;
  extensionVersion = null;
  versionWarned = false;
  requestWindow = { start: Date.now(), count: 0 };
}

export function bridgePort(): number | null {
  return port;
}
