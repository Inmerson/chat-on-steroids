/**
 * The local bridge, over real HTTP.
 *
 * This server is the one thing in the app a web page could try to reach, and it holds
 * the credential the extension authenticates with, so the tests here are mostly about
 * what it refuses: a page origin, a missing token, a superseded token.
 * The happy paths matter too, but they are the cheap half.
 */

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../src/main/version.js';

// safeStorage only exists inside a running Electron main process. The bridge stores
// its bearer token through it, so the test provides the same interface, unencrypted.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8')
  },
  clipboard: {},
  shell: {}
}));

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const {
  bridgePort,
  cancelResume,
  commandUrl,
  pendingCommands,
  queueResume,
  resetBridgeForTests,
  restoreCommands,
  resumeJobFor,
  setBrowserOpener,
  startBridge,
  stopBridge,
  unpair
} = await import('../src/main/bridge.js');
const { flushDurable, initDurableStore, readDurable, writeDurableSoon } = await import('../src/main/durable.js');
const { createSession, getSession, initSessionStore, readEvents, resetSessionStoreForTests } = await import(
  '../src/main/session/store.js'
);
const { noteChatOrigin, recordToolCall, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { abortContinuation, attachSummary, continuationByToken, openContinuation } = await import(
  '../src/main/session/continuation.js'
);
const { bindConversation, mintWorkerJoinKey, spawn, pendingWorkerSpawns, resetSwarm, swarmState } = await import(
  '../src/main/agents.js'
);
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
/** The chat that spawns the swarm in these tests: only a proven conversation can. */
const PRIME_CHAT = 'c-prime-bridge';

/**
 * A continuation that has already been given its brief, ready to be queued.
 *
 * `queueResume` takes the transaction's one-time token, not a handoff id: the brief the
 * fresh chat is typed lives in the transaction, and the command carries only the right to
 * claim it. So a queued resume in these tests has to be a real one.
 */
async function readyContinuation(sessionId: string, brief: string, from = 'c-compacted'): Promise<string> {
  const opened = openContinuation(sessionId, from);
  const stored = await attachSummary(opened.token, brief);
  expect(stored, 'the brief was not stored, so there is no resume to queue').not.toBeNull();
  return opened.token;
}

/**
 * A session really attached to a chat, compacted, with its brief already written.
 *
 * The commit rebinds the session from chat A to chat B, so chat A has to be a chat this
 * session is actually in — a bare `createSession` has no conversation to move away from
 * and every commit against it is refused.
 */
async function compactedSession(from: string, brief: string): Promise<{ sessionId: string; token: string }> {
  const reply = await request('POST', '/events', {
    body: {
      conversationId: from,
      events: [{ kind: 'user_message', time: Date.now(), text: 'do the work', messageId: `m-${from}` }]
    }
  });
  const sessionId = reply.body.sessionId as string;
  expect(sessionId, 'the chat was not recorded, so there is no session to compact').toBeTruthy();
  return { sessionId, token: await readyContinuation(sessionId, brief, from) };
}

/** Every URL the app asked the OS to open, in order. Stands in for Electron's shell. */
const opened: string[] = [];

let dir: string;
let base: string;
let token: string | null = null;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; origin?: string | null; auth?: string | null; raw?: string } = {}
): Promise<Reply> {
  const url = new URL(path, base);
  const payload = options.raw ?? (options.body === undefined ? null : JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  // `origin: null` means "send no Origin header", which is what Chrome does for an
  // extension fetch to a host it already holds permission for.
  if (options.origin !== null) headers['origin'] = options.origin ?? EXTENSION_ORIGIN;
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers['authorization'] = `Bearer ${auth}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: any = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // Leave it as text; a non-JSON body is itself a finding.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** The command id in the marked URL the app just opened. */
function lastOpened(): string {
  const url = opened[opened.length - 1];
  expect(url, 'the app opened no chat').toBeTruthy();
  return new URL(url!).searchParams.get('clf')!;
}

/**
 * The one page the app opened, redeeming the one command it was opened for.
 *
 * The only way a bootstrap reaches a browser now. There is no listing route and no poll:
 * a command is delivered to the page holding its marker, or it is not delivered at all.
 */
async function redeem(id = lastOpened(), client = 'tab-1'): Promise<any> {
  const reply = await request('POST', '/commands/redeem', { body: { id, client } });
  expect(reply.status, `redeem ${id} failed`).toBe(200);
  return reply.body.command;
}

/** Connects the way the extension does, and remembers the token for later requests. */
async function pair(): Promise<string> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  token = reply.body.token as string;
  return token;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-bridge-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const baseConfig = defaultConfig();
  await saveConfig({
    ...baseConfig,
    sessions: { ...baseConfig.sessions, record: true },
    multiAgent: { ...baseConfig.multiAgent, enabled: true }
  });
  const port = await startBridge();
  expect(port, 'no loopback port in 8765-8769 was free').not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await stopBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  // The swarm goes first: ending a run queues stop notices into the chats of any workers
  // still live, and those would otherwise be dropped into the queue the bridge reset had
  // just emptied — the previous test's cleanup showing up as the next test's first command.
  resetSwarm();
  resetBridgeForTests();
  opened.length = 0;
  // The app opens the chat itself, always: there is no queue for a tab to come and ask.
  // Tests that need the open to fail replace this with their own opener.
  setBrowserOpener(async (url) => {
    opened.push(url);
  });
  resetRecorderForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
});

// ------------------------------------------------------------------ origin

describe('who is allowed to talk to it', () => {
  it('binds a loopback port only', () => {
    expect(bridgePort()).toBeGreaterThanOrEqual(8765);
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('identifies itself to an extension without any credential', async () => {
    const reply = await request('GET', '/hello', { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.app).toBe('chatgpt-local-files');
    // Against the constant, not a literal: what matters is that the handshake reports the
    // build's own version, and a hard-coded number here only ever fails on release day.
    expect(reply.body.version).toBe(APP_VERSION);
    expect(reply.body.bridge).toBe(4);
    expect(reply.body.paired).toBe(false);
    // Identification must not double as a status leak.
    expect(Object.keys(reply.body)).toEqual(['app', 'version', 'bridge', 'paired']);
  });

  it('refuses every web page origin, chatgpt.com included', async () => {
    for (const origin of ['https://chatgpt.com', 'https://evil.example.com', 'http://localhost:3000', 'null']) {
      const reply = await request('GET', '/hello', { origin, auth: null });
      expect(reply.status, origin).toBe(403);
      expect(reply.body.error).toBe('forbidden_origin');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('serves a request that carries no Origin at all', async () => {
    const reply = await request('GET', '/hello', { origin: null, auth: null });
    expect(reply.status).toBe(200);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an extension preflight with the private-network header Chrome needs', async () => {
    const reply = await request('OPTIONS', '/events', { auth: null });
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);
    expect(reply.headers['access-control-allow-private-network']).toBe('true');
  });

  it('refuses a preflight that arrives without an Origin', async () => {
    const reply = await request('OPTIONS', '/events', { origin: null, auth: null });
    expect(reply.status).toBe(403);
  });
});

// -------------------------------------------------------------- provisioning

describe('provisioning', () => {
  it('issues a token to the extension with nothing for the user to type', async () => {
    const reply = await request('POST', '/pair', { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const hello = await request('GET', '/hello', { auth: null });
    expect(hello.body.paired).toBe(true);
  });

  it('never issues a token to a web page', async () => {
    for (const origin of ['https://chatgpt.com', 'https://evil.example.com', 'null']) {
      const silent = await request('POST', '/pair', { origin, auth: null });
      expect(silent.status, origin).toBe(403);
      expect(silent.body.error).toBe('forbidden_origin');
      expect(silent.body.token).toBeUndefined();
    }
    expect((await request('GET', '/hello', { auth: null })).body.paired).toBe(false);
  });

  it('replaces the token on a second request, so a re-provision supersedes the old one', async () => {
    const first = await pair();
    const second = await pair();
    expect(second).not.toBe(first);
    expect((await request('GET', '/status', { auth: first })).status).toBe(401);
    expect((await request('GET', '/status', { auth: second })).status).toBe(200);
  });

  it('drops the token when the user disconnects the browser', async () => {
    await pair();
    expect((await request('GET', '/status')).status).toBe(200);
    await unpair();
    expect((await request('GET', '/status')).status).toBe(401);
  });
});

// -------------------------------------------------------------------- auth

describe('authorisation', () => {
  it('refuses every route but /hello and /pair without a token', async () => {
    await pair();
    for (const [method, path] of [
      ['GET', '/status'],
      ['GET', '/activity?conversationId=abcdabcd'],
      ['POST', '/events'],
      ['POST', '/closed'],
      ['POST', '/commands/ack']
    ] as const) {
      const reply = await request(method, path, { auth: null, ...(method === 'POST' ? { body: {} } : {}) });
      expect(reply.status, path).toBe(401);
    }
  });

  it('refuses a token of the right shape but the wrong value', async () => {
    const issued = await pair();
    const forged = `${issued.slice(0, -1)}${issued.endsWith('A') ? 'B' : 'A'}`;
    expect((await request('GET', '/status', { auth: forged })).status).toBe(401);
  });

  it('has no route that reads a file or runs anything', async () => {
    await pair();
    for (const path of ['/read', '/exec', '/config', '/secrets', '/../config.json']) {
      expect((await request('GET', path)).status, path).toBe(404);
    }
  });
});

// ------------------------------------------------------------------ events

describe('observations', () => {
  it('refuses anything that is not a conversation id', async () => {
    await pair();
    for (const conversationId of ['', 'not a uuid', '../../etc', 'x'.repeat(100)]) {
      const reply = await request('POST', '/events', { body: { conversationId, events: [] } });
      expect(reply.status, String(conversationId)).toBe(400);
      expect(reply.body.error).toBe('bad_conversation_id');
    }
  });

  it('stores what the page reported and skips what it does not recognise', async () => {
    await pair();
    const conversationId = '6a805197-b090-83eb-bbd8-a32b482941da';
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'user_message', time: Date.now(), text: 'first requirement', messageId: 'm1' },
          { kind: 'turn_start', time: Date.now(), turnId: 'turn-1' },
          { kind: 'progress', time: Date.now(), text: 'reading files' },
          { kind: 'invented_kind', time: Date.now(), text: 'should be dropped' },
          { kind: 'turn_end', time: Date.now(), turnId: 'turn-1', outcome: 'not-a-real-outcome' }
        ]
      }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.stored).toBe(4);

    const events = await readEvents(reply.body.sessionId);
    expect(events.map((event) => event.kind)).toEqual([
      'session_start',
      'user_message',
      'turn_start',
      'progress',
      'turn_end'
    ]);
    const end = events.at(-1)!;
    // An outcome the page invented must not be believed.
    expect(end.kind === 'turn_end' && end.outcome).toBe('unknown');
  });

  it('replaces an impossible timestamp rather than storing it', async () => {
    await pair();
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'progress', time: Date.now() + 10 * 24 * 3600_000, text: 'from the future' }]
      }
    });
    const events = await readEvents(reply.body.sessionId, { kinds: ['progress'] });
    expect(events[0]!.time).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('stores a message once when a reloaded tab reports it twice', async () => {
    await pair();
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const message = { kind: 'user_message', time: Date.now(), text: 'the original task', messageId: 'msg-a' };
    const first = await request('POST', '/events', { body: { conversationId, events: [message] } });
    const second = await request('POST', '/events', { body: { conversationId, events: [message] } });
    expect(first.body.stored).toBe(1);
    expect(second.body.stored).toBe(0);
    expect(await readEvents(first.body.sessionId, { kinds: ['user_message'] })).toHaveLength(1);
  });

  it('refuses an over-sized body with an answer, not a reset connection', async () => {
    await pair();
    const reply = await request('POST', '/events', { raw: 'x'.repeat(600 * 1024) });
    expect(reply.status).toBe(413);
    expect(reply.body.error).toBe('body_too_large');
  });
});

// ---------------------------------------------------------------- activity

describe('activity feed', () => {
  it('hands back an app-owned render stream plus legacy tool summaries, with no raw tool I/O', async () => {
    await pair();
    const conversationId = '99999999-8888-7777-6666-555555555555';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'turn-42' },
          { kind: 'page_tool', time: Date.now(), turnId: 'turn-42', text: 'Searched the web', messageId: 'native-1' },
          { kind: 'tool_block', time: Date.now(), turnId: 'turn-42', count: 1 }
        ]
      }
    });
    await recordToolCall({
      tool: 'apply_patch',
      args: { patch: '*** Begin Patch\n*** Update File: /project/src/main.ts\n*** End Patch', secretish: 'value' },
      content: [{ type: 'text', text: 'edited' }],
      outcome: 'ok',
      durationMs: 30,
      startedAt: Date.now(),
      evidence: {
        changes: [{ path: '/project/src/main.ts', added: 18, removed: 4, approximate: false }],
        assets: [],
        count: null,
        detail: null,
        exitCode: null,
        timedOut: false,
        durationMs: null,
        running: null,
        processSessionId: null
      }
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.status).toBe(200);
    expect(reply.body.entries).toHaveLength(1);
    const entry = reply.body.entries[0];
    expect(entry.turnId).toBe('turn-42');
    expect(entry.attribution).toBe('turn');
    expect(entry.summary.title).toBe('Edited src/main.ts');
    expect(entry.summary.metric).toBe('+18 −4');
    expect(entry.generating).toBeUndefined();
    expect(entry).not.toHaveProperty('args');
    expect(entry).not.toHaveProperty('argsTruncated');
    expect(entry).not.toHaveProperty('result');
    expect(reply.body.stream.map((item: any) => item.kind)).toEqual(['turn_start', 'page_tool', 'tool_call']);
    expect(reply.body.stream[1]).toMatchObject({
      turnId: 'turn-42',
      kind: 'page_tool',
      label: 'Searched the web',
      messageId: 'native-1'
    });
    expect(reply.body.stream[2]).toMatchObject({
      turnId: 'turn-42',
      tool: 'apply_patch',
      summary: { title: 'Edited src/main.ts', metric: '+18 −4' }
    });
    expect(reply.body.stream[2]).not.toHaveProperty('args');
    expect(reply.body.stream[2]).not.toHaveProperty('result');
    expect(reply.body.generating).toBe(true);
  });

  /**
   * The page folds the chat's first user message away when this says so, and that message
   * is the handoff brief or the worker bootstrap — a screenful of machinery the user did
   * not type. It is read off the session record rather than remembered in the tab, so it
   * still holds when the chat is reopened days later.
   */
  it('says whether the app opened this chat itself, and how', async () => {
    await pair();
    const worker = '66666666-3333-2222-1111-000000000000';
    const own = '77777777-3333-2222-1111-000000000000';
    await noteChatOrigin(worker, { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Build it' });
    for (const conversationId of [worker, own]) {
      await request('POST', '/events', {
        body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-1' }] }
      });
    }

    expect((await request('GET', `/activity?conversationId=${worker}`)).body.bootstrap).toBe('worker');
    // A chat the user started themselves has nothing to fold away.
    expect((await request('GET', `/activity?conversationId=${own}`)).body.bootstrap).toBeNull();
  });

  it('returns nothing for a conversation it has never seen', async () => {
    await pair();
    const reply = await request('GET', '/activity?conversationId=deadbeef-0000-0000-0000-000000000000');
    expect(reply.status).toBe(200);
    expect(reply.body.entries).toEqual([]);
    expect(reply.body.sessionId).toBeNull();
  });

  it('pages by sequence number so the extension never re-reads what it has', async () => {
    await pair();
    const conversationId = '12121212-3434-5656-7878-909090909090';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 't' },
          { kind: 'tool_block', time: Date.now(), turnId: 't', count: 4 }
        ]
      }
    });
    for (let i = 0; i < 3; i++) {
      await recordToolCall({
        tool: 'read_file',
        args: { path: `/project/f${i}.ts` },
        content: [{ type: 'text', text: 'body' }],
        outcome: 'ok',
        durationMs: 2,
        startedAt: Date.now()
      });
    }
    // A later user message is not rendered in the assistant stream, but it still advances
    // the shared sequence cursor so the browser cannot re-read it forever.
    await request('POST', '/events', {
      body: { conversationId, events: [{ kind: 'user_message', time: Date.now(), text: 'next question', messageId: 'next-q' }] }
    });
    const all = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(all.body.entries).toHaveLength(3);
    const lastSeq = all.body.entries.at(-1).seq;
    expect(all.body.nextSince).toBeGreaterThan(lastSeq + 1);
    const after = await request('GET', `/activity?conversationId=${conversationId}&since=${all.body.nextSince}`);
    expect(after.body.entries).toEqual([]);
    expect(after.body.stream).toEqual([]);
    expect(after.body.nextSince).toBe(all.body.nextSince);
  });

  it('never sends a live agent credential through session history or the extension activity feed', async () => {
    await pair();
    const conversationId = '45454545-6767-8989-abab-cdcdcdcdcdcd';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'secret-turn' },
          { kind: 'tool_block', time: Date.now(), turnId: 'secret-turn', count: 2 }
        ]
      }
    });
    spawn({ workers: [{ task: 'security check' }], caller: { conversationId: PRIME_CHAT } });
    // The recovery key is the only credential this app has left: long, single-use, minted
    // for the user rather than for a model, and the one thing that can turn a chat into a
    // worker of this run without the extension having said so.
    const joinKey = mintWorkerJoinKey('worker-1')!;
    await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/secret.ts', join_key: joinKey, note: `echo ${joinKey}` },
      content: [{ type: 'text', text: `result accidentally echoed ${joinKey}` }],
      // Failed summaries may copy the first result line into summary.detail, so this
      // exercises the leak path that an otherwise-successful call would not touch.
      outcome: 'error',
      durationMs: 2,
      startedAt: Date.now()
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.body.entries).toHaveLength(1);
    const serialised = JSON.stringify(reply.body.entries[0]);
    expect(serialised).not.toContain(joinKey);
    expect(reply.body.entries[0]).not.toHaveProperty('args');
    expect(reply.body.entries[0]).not.toHaveProperty('result');
    expect(JSON.stringify(reply.body.stream)).not.toContain(joinKey);
    const stored = JSON.stringify(await readEvents(reply.body.sessionId));
    expect(stored).not.toContain(joinKey);
    expect(stored).toContain('agent key removed');
  });

  /**
   * There is no live worker code any more, and no sentence that hands one out.
   *
   * This used to cover the reply `agents action=join` sent a worker: a three-character
   * routing code in prose, which went to disk, to session history and to the Activity feed
   * verbatim, and which had to be cut out by matching the sentence that published it. A
   * worker is identified by the conversation it is in, so nothing is published and there is
   * nothing to cut. What remains is the recovery key — never given to a model, but capable
   * of passing through this app's own arguments if a *user* pastes it — and it is scrubbed
   * by value like every other registered secret.
   */
  it('never writes a recovery key into an agents call it recorded', async () => {
    await pair();
    const conversationId = '56565656-7878-9a9a-bcbc-dedededede00'.slice(0, 36);
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'join-turn' },
          { kind: 'tool_block', time: Date.now(), turnId: 'join-turn', count: 1 }
        ]
      }
    });
    spawn({ workers: [{ task: 'security check' }], caller: { conversationId: PRIME_CHAT } });
    const joinKey = mintWorkerJoinKey('worker-1')!;

    await recordToolCall({
      tool: 'agents',
      args: { action: 'join', join_key: joinKey },
      content: [{ type: 'text', text: 'You are worker-1 (Worker 1). Later calls need nothing from you.' }],
      outcome: 'ok',
      durationMs: 2,
      startedAt: Date.now()
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(JSON.stringify(reply.body)).not.toContain(joinKey);
    const stored = JSON.stringify(await readEvents(reply.body.sessionId));
    expect(stored).not.toContain(joinKey);
  });
});

// ---------------------------------------------------------------- commands

/**
 * One command, one chat, one delivery.
 *
 * The queue used to be a pull: the app parked a bootstrap and waited for some ChatGPT tab
 * to poll for it, under a lease that was renewed while a page said it was still working,
 * and re-offered when it lapsed. All of that is gone. The app opens the exact chat, the one
 * page holding the marker redeems it, and the page reports which conversation it became —
 * which for a worker is the moment that worker starts existing.
 */
describe('delivering a bootstrap', () => {
  it('opens the chat, hands the brief to the page that redeems it, and forgets it on success', async () => {
    await pair();
    expect(pendingCommands()).toEqual([]);

    const { sessionId, token } = await compactedSession('11111111-2222-3333-4444-555555555555', 'NEXT — finish the bridge rewrite.');
    const command = queueResume(sessionId, token);
    expect(command).not.toBeNull();
    // Opened immediately, by the app, with nothing having asked for it.
    expect(opened).toEqual([commandUrl(command!.id)]);

    // The brief itself is what gets typed: there is no tool call to make and no id to quote.
    const redeemed = await redeem(command!.id);
    expect(redeemed.id).toBe(command!.id);
    expect(redeemed.kind).toBe('open-chat');
    expect(redeemed.text).toContain('NEXT — finish the bridge rewrite.');

    const ack = await request('POST', '/commands/ack', {
      body: { id: command!.id, status: 'sent', conversationId: 'abcdef12-3456-7890-abcd-ef1234567890' }
    });
    expect(ack.status).toBe(200);
    expect(ack.body.committed).toBe(true);
    expect(pendingCommands()).toEqual([]);
  });

  /** One page owns one command. A second document on the same marker gets nothing. */
  it('refuses a second page on the same marker while the first still holds it', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('99999999-8888-7777-6666-555555555555', 'the only brief');
    const command = queueResume(sessionId, token)!;

    expect((await redeem(command.id, 'tab-1')).text).toContain('the only brief');
    const second = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-2' } });
    expect(second.status).toBe(409);
    // The owner's own retries are the same owner, and are answered every time.
    expect((await redeem(command.id, 'tab-1')).text).toContain('the only brief');
  });

  /**
   * The name the fresh chat ends up with.
   *
   * The bootstrap this app types is the first thing said in the chat it opened, and the
   * recorder's ordinary rule — name a session after the first thing said in it — turned
   * that into the session's name. The installed build's list was a column of rows all
   * called `Continue the previous ChatGPT ...`. The acknowledgement is the only moment
   * at which the queued command and the conversation it became are both known, so this
   * is where the name is settled.
   */
  it('names the chat it opened after the work, not after the bootstrap it typed', async () => {
    await pair();
    const source = await createSession({ title: 'Harden the MCP workflows' });
    const command = queueResume(source.id, await readyContinuation(source.id, 'carry on with the MCP work'))!;
    await redeem(command.id);
    const conversationId = 'cccccccc-dddd-eeee-ffff-000000000000';
    await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', conversationId } });

    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          {
            kind: 'user_message',
            time: Date.now(),
            text: 'Continue the previous ChatGPT Local Files session. Read the handoff below.',
            messageId: 'boot-resume'
          }
        ]
      }
    });
    const summary = await getSession(reply.body.sessionId);
    expect(summary?.title).toBe('Resumed · Harden the MCP workflows');
    expect(summary?.origin).toEqual({ kind: 'resume', fromSessionId: source.id, agentId: null, task: '' });
  });

  it('names a worker chat after the agent and the task it was given', async () => {
    await pair();
    spawn({ workers: [{ task: 'Rewrite the recorder fixture' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = '12121212-3434-5656-7878-909090909090';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId }
    });

    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          {
            kind: 'user_message',
            time: Date.now(),
            text: 'Rewrite the recorder fixture',
            messageId: 'boot-worker'
          }
        ]
      }
    });
    expect((await getSession(reply.body.sessionId))?.title).toBe('worker-1 · Rewrite the recorder fixture');
  });

  /** A bootstrap that never reached a tab has no chat to name. */
  it('does not name anything for a failed acknowledgement', async () => {
    await pair();
    const source = await createSession({ title: 'Never opened' });
    const command = queueResume(source.id, await readyContinuation(source.id, 'carry on'))!;
    await redeem(command.id);
    const conversationId = 'dddddddd-eeee-ffff-0000-111111111111';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'failed', error: 'tab died', conversationId }
    });

    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'user_message', time: Date.now(), text: 'a chat the user started', messageId: 'm-own' }]
      }
    });
    const summary = await getSession(reply.body.sessionId);
    expect(summary?.title).toBe('a chat the user started');
    expect(summary?.origin).toBeNull();
  });

  /**
   * One command is one delivery, and a page that gives up ends it.
   *
   * There is no retry budget, nothing sweeping the queue behind this, and no status a page
   * can send to buy itself more time — `working` existed for exactly that and went with the
   * ticker that sent it. A bootstrap that fails fails now, and takes its continuation down
   * with it, so the session is left in the chat it is already in and the user can see that
   * and press the button again.
   */
  it('ends a failed bootstrap instead of retrying it, and has no way to postpone one', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('22222222-3333-4444-5555-666666666666', 'carry on');
    const command = queueResume(sessionId, token)!;
    await redeem(command.id);

    await request('POST', '/commands/ack', { body: { id: command.id, status: 'failed', error: 'tab died' } });
    // Gone from the queue, and gone as a transaction: nothing is coming for this session.
    expect(pendingCommands()).toEqual([]);
    expect(continuationByToken(token)?.state).toBe('aborted');

    // A second press is a second command — the user's decision, not the app's timer.
    const { sessionId: againId, token: againToken } = await compactedSession(
      '33333333-4444-5555-6666-777777777777',
      'carry on'
    );
    const second = queueResume(againId, againToken)!;
    expect(pendingCommands()).toHaveLength(1);

    // An unknown status is not a way in: anything that is not an explicit failure is taken
    // as "sent", which for a resume without a conversation id refuses the commit outright.
    const nonsense = await request('POST', '/commands/ack', { body: { id: second.id, status: 'working' } });
    expect(nonsense.body.committed).toBe(false);
    expect(pendingCommands()).toEqual([]);
    expect(continuationByToken(againToken)?.state).toBe('aborted');
  });

  it('types the worker its task, and nothing about joining, keys or identity', async () => {
    await pair();
    spawn({ workers: [{ task: 'Audit the compaction transaction end to end' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();

    expect(command.agent).toBe('worker-1');
    // The task itself is the first message. That is the whole invariant: the chat this app
    // opened is already a worker, so there is nothing for the model to do about identity.
    expect(command.text.startsWith('Audit the compaction transaction end to end')).toBe(true);
    expect(command.text).not.toMatch(/join/i);
    expect(command.text).not.toMatch(/agent[_ ]key/i);
    expect(command.text).not.toContain('joinKey');
    // It still says how to report, because that is about the work rather than about who it is.
    expect(command.text).toContain('action=message');
    expect(command.text).toContain('finish');

    await flushDurable();
    const stored = await readDurable<unknown>('bridge-commands');
    expect(JSON.stringify(stored)).not.toContain('joinKey');
  });

  /**
   * Binding is the completion boundary.
   *
   * The command used to stay leased after the bootstrap was typed, "waiting for the worker
   * to join", because joining was a thing a model had to do and could be prevented from
   * doing. The extension's report *is* the worker starting, so the same acknowledgement
   * that carries the conversation id both activates the worker and finishes the command.
   */
  it('activates the worker and retires its command on the acknowledgement that names the chat', async () => {
    await pair();
    spawn({ workers: [{ task: 'audit the compaction' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'abcdef12-3456-7890-abcd-ef1234567890';
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('invited');

    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
    });

    const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('active');
    expect(worker.conversationId).toBe(conversationId);
    expect(pendingCommands()).toEqual([]);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  /**
   * The failure the new boundary creates, and its safe ending.
   *
   * A page can type the bootstrap and still never see a conversation id — ChatGPT accepted
   * the message but the tab never showed which chat it landed in. Nothing that chat does can
   * ever reach the run, so the slot is failed rather than left invited for a join that has
   * no way of happening.
   */
  it('fails a worker whose page typed the task but never named its chat', async () => {
    await pair();
    spawn({ workers: [{ task: 'unnameable' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();

    await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', agent: 'worker-1' } });

    const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('failed');
    expect(worker.result).toMatch(/never said which conversation/);
    expect(pendingCommands()).toEqual([]);
  });

  it('opens one worker chat at a time, so a report can never name the wrong tab', async () => {
    await pair();
    spawn({
      workers: [{ task: 'first audit' }, { task: 'second audit' }],
      caller: { conversationId: PRIME_CHAT }
    });

    expect(opened).toHaveLength(1);
    const first = await redeem();
    expect(first.agent).toBe('worker-1');
    const firstConversation = '11111111-2222-3333-4444-555555555555';
    await request('POST', '/commands/ack', {
      body: { id: first.id, status: 'sent', conversationId: firstConversation, agent: 'worker-1' }
    });

    // worker-2's chat opens only once worker-1's is bound.
    expect(opened).toHaveLength(2);
    const second = await redeem();
    expect(second.agent).toBe('worker-2');
    expect(second.text.startsWith('second audit')).toBe(true);
  });

  it('brings an unfinished worker bootstrap back across an app restart, without a credential', async () => {
    await pair();
    spawn({ workers: [{ task: 'survive the restart' }], caller: { conversationId: PRIME_CHAT } });
    const offered = await redeem();
    expect(offered.agent).toBe('worker-1');
    await flushDurable();

    // Nothing in the state file can make anybody a worker: it is a list of what was pending.
    const saved = JSON.stringify(await readDurable('bridge-commands'));
    expect(saved).not.toMatch(/key/i);

    resetBridgeForTests();
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await restoreCommands();
    expect(pendingCommands()).toEqual([{ id: offered.id, what: 'worker:worker-1', lastError: null }]);
  });

  /**
   * A resume is the one command that must not come back.
   *
   * Its authority is the continuation transaction, which lives in memory: after a restart
   * there is nothing left to claim, so restoring the command would open a fresh chat, type
   * a brief into it, and never be able to move the session there. The session simply stays
   * in the chat it is already in, which is the outcome every other failure path also has.
   */
  it('does not restore a queued resume across a restart', async () => {
    await pair();
    const source = await createSession({ title: 'interrupted by a restart' });
    queueResume(source.id, await readyContinuation(source.id, 'carry on'));
    await flushDurable();

    resetBridgeForTests();
    opened.length = 0;
    await restoreCommands();
    expect(pendingCommands()).toEqual([]);
    expect(opened).toEqual([]);
  });

  /**
   * T-33. Overflow used to `commands.shift()`, which deletes the row and nothing else.
   * A queued worker command owns an `invited` agent slot that only ever ends when
   * something ends it, so shifting one out left that worker counting towards the limit,
   * holding the single in-flight agent bootstrap so nothing queued behind it could open,
   * keeping the run looking alive to takeover, and promising the prime a report from a
   * chat that would never exist.
   */
  it('runs the full lifecycle cleanup when the command queue overflows', async () => {
    await pair();
    spawn({ workers: [{ task: 'the worker that gets pushed out of the queue' }], caller: { conversationId: PRIME_CHAT } });
    expect(swarmState().agents.find((info) => info.id === 'worker-1')!.state).toBe('invited');
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);

    // MAX_COMMANDS is 20, and the worker's command is the oldest, so it is the one pushed
    // out by the twenty-first entry.
    for (let n = 0; n < 20; n++) queueResume(`overflow-session-${n}`, `overflow-handoff-${n}`);

    expect(pendingCommands().some((command) => command.what === 'worker:worker-1')).toBe(false);
    expect(pendingCommands()).toHaveLength(20);

    const worker = swarmState().agents.find((info) => info.id === 'worker-1')!;
    expect(worker.state).toBe('failed');
    expect(worker.result).toMatch(/queue was full/);
    // The slot is genuinely free again rather than held by a command nobody has. The run
    // itself is untouched: a worker being lost is not the prime's chat going away, and only
    // that ends a run.
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(swarmState().running).toBe(true);
  });

  it('ignores an acknowledgement for a command that does not exist', async () => {
    await pair();
    const reply = await request('POST', '/commands/ack', { body: { id: 'made-up' } });
    expect(reply.status).toBe(200);
  });

  /** There is no listing route left for a tab to poll, and nothing behind one. */
  it('has no queue for a tab to poll', async () => {
    await pair();
    spawn({ workers: [{ task: 'not for the taking' }], caller: { conversationId: PRIME_CHAT } });
    expect((await request('GET', '/commands')).status).toBe(404);
  });
});

// ----------------------------------------------------------------- delivery

/**
 * The app opening the chat itself.
 *
 * Every case here is one the old pull-only delivery could not serve: it queued a command
 * and waited for a ChatGPT tab's content script to ask for it, so with no ChatGPT tab —
 * or no browser — the queue simply sat there and surfaced minutes later as tabs the user
 * had stopped expecting.
 */
describe('targeted open', () => {
  it('opens the fresh chat the instant a resume is queued, with no tab and no timer involved', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    // Deliberately not paired and never polled: this is the "Chrome closed, no ChatGPT
    // tab, extension asleep" case, and the open has to happen anyway.
    const command = queueResume('session-open', 'handoff-open')!;

    expect(opened).toEqual([commandUrl(command.id)]);
    expect(commandUrl(command.id)).toContain(`clf=${command.id}`);
    expect(resumeJobFor('session-open')).toBeNull();
  });

  it('reports a browser that refused to open, rather than looking busy', async () => {
    setBrowserOpener(async () => {
      throw new Error('no browser');
    });
    queueResume('session-nobrowser', 'handoff-nobrowser');
    // The rejection is handled asynchronously, as it is in the app.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const queued = pendingCommands();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.lastError).toContain('the browser could not be opened');
  });

  /**
   * No opener at all is an ending, not a wait.
   *
   * There used to be a poll route behind this: a command nothing could open simply sat in
   * the queue until some ChatGPT tab came and asked for it. With that gone, a queue with no
   * reader is a job that can never happen, so it fails here — the continuation aborts, the
   * session stays in the chat it is in, and nothing is left for a later sweep to find.
   */
  it('ends a command outright when this process cannot open a browser at all', async () => {
    setBrowserOpener(null);
    await pair();
    const { sessionId, token } = await compactedSession('77777777-8888-9999-aaaa-bbbbbbbbbbbb', 'carry on');
    queueResume(sessionId, token);

    expect(pendingCommands()).toEqual([]);
    expect(continuationByToken(token)?.state).toBe('aborted');
  });

  it('collapses repeated presses for one session into one job, one command and one tab', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    const first = queueResume('session-once', 'handoff-1')!;
    const second = queueResume('session-once', 'handoff-1')!;
    const third = queueResume('session-once', 'handoff-1')!;

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(pendingCommands()).toHaveLength(1);
    // Claimed by the first open, so the repeats find nothing deliverable.
    expect(opened).toEqual([commandUrl(first.id)]);
  });

  it('supersedes a queued resume in place when the same session is compacted again', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await pair();
    const chat = '33333333-4444-5555-6666-777777777777';
    const older = await compactedSession(chat, 'the older brief');
    const first = queueResume(older.sessionId, older.token)!;

    // Pressing the button again is a second compaction of the same session, with its own
    // brief and its own one-time token. The first transaction ends where it stands.
    abortContinuation(older.token, 'the user pressed the button again');
    const newerToken = await readyContinuation(older.sessionId, 'the newer brief', chat);
    const second = queueResume(older.sessionId, newerToken)!;

    // One session is one queued replacement chat, however many times it is compacted.
    expect(second.id).toBe(first.id);
    expect(pendingCommands()).toHaveLength(1);

    const redeemed = await request('POST', '/commands/redeem', { body: { id: second.id, client: 'tab-1' } });
    expect(redeemed.body.command.text).toContain('the newer brief');
    expect(redeemed.body.command.text).not.toContain('the older brief');
  });

  /**
   * The tab opened and then nothing happened. There is no scheduler waiting to try again.
   *
   * This is the whole failure model in one test: the app opens exactly one chat, gives that
   * page a deadline, and when the deadline passes the attempt is over. Over means the
   * continuation is aborted and the session is still attached to the chat it was already
   * in — a state the user can see and act on — rather than a queue entry that reopens a
   * tab minutes later, on its own, for something they have stopped expecting.
   */
  it('ends the continuation when the chat it opened never reports back', async () => {
    vi.useFakeTimers();
    try {
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await pair();
      const { sessionId, token } = await compactedSession('44444444-5555-6666-7777-888888888888', 'carry on');
      const command = queueResume(sessionId, token)!;
      expect(opened).toEqual([commandUrl(command.id)]);

      // The page never redeems, never acks, never types.
      await vi.advanceTimersByTimeAsync(90_000);

      expect(pendingCommands()).toEqual([]);
      expect(continuationByToken(token)?.state).toBe('aborted');
      // And no second tab was opened for it on the way out.
      expect(opened).toEqual([commandUrl(command.id)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws a cancelled resume so no tab opens for it afterwards', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await pair();
    const command = queueResume('session-cancel', 'handoff-cancel')!;
    expect(opened).toHaveLength(1);

    expect(cancelResume('session-cancel')).toBe(true);
    expect(pendingCommands()).toEqual([]);

    // The tab is already open on the marker, and this is what it finds when it redeems:
    // nothing, so it types nothing. That is the whole of cancellation reaching the browser.
    expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } })).status).toBe(404);
    expect(opened).toHaveLength(1);
  });

  it('hands a marked page its own command by id, once, and refuses an unknown id', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('44444444-5555-6666-7777-888888888888', 'the brief itself');
    const command = queueResume(sessionId, token)!;

    const redeemed = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.command.id).toBe(command.id);
    expect(redeemed.body.command.text).toContain('the brief itself');
    // Redeeming again is fine — the page may reload — and the same page is the same
    // claimant, so it gets the same brief back rather than an empty command.
    const again = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } });
    expect(again.body.command.text).toContain('the brief itself');
    expect(pendingCommands()).toHaveLength(1);

    expect((await request('POST', '/commands/redeem', { body: { id: 'not-a-command', client: 'tab-1' } })).status).toBe(
      404
    );
  });
});

// ------------------------------------------------------- worker bootstrap failure

describe('a worker chat that never opens', () => {
  it('fails the worker definitively instead of leaving it invited, and lets the next one through', async () => {
    await pair();
    spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);

    // The page took the bootstrap and could not type it — a tab closed too early, or
    // ChatGPT refusing the message. It says so, and that is the end of this worker: the page
    // gets one attempt, so handing the same command back would only be the app disbelieving
    // it.
    const first = await redeem();
    expect(first.agent).toBe('worker-1');
    await request('POST', '/commands/ack', { body: { id: first.id, status: 'failed', error: 'tab closed' } });

    const state = swarmState();
    const worker1 = state.agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker1.state).toBe('failed');
    expect(worker1.result).toContain('tab closed');
    // No zombie: it is not owed a tab, and it does not count as a live worker.
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-2']);
    expect(pendingCommands().some((command) => command.what === 'worker:worker-1')).toBe(false);

    // The prime is told, rather than waiting for a report that cannot come.
    const prime = state.agents.find((agent) => agent.id === 'prime')!;
    expect(prime.pending).toBeGreaterThan(0);

    // And worker-2 is no longer stuck behind it: its chat opened the moment worker-1 ended.
    const next = await redeem();
    expect(next.agent).toBe('worker-2');
  });
});

// ------------------------------------------------------------- restarting

/**
 * Switching multi-agent mode or recording off and on again restarts this module, and the
 * listener it registers on the swarm has to come off when it does. It did not: every
 * restart added another, so a run ending afterwards was handled once per start the app had
 * ever done — including by handlers belonging to a bridge that no longer exists.
 */
describe('restarting the bridge', () => {
  it('cancels an ended run’s queued worker chats exactly once, however often it has restarted', async () => {
    for (let restart = 0; restart < 2; restart++) {
      await stopBridge();
      const port = await startBridge();
      expect(port).not.toBeNull();
      base = `http://127.0.0.1:${port}`;
    }
    await pair();

    spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingCommands().map((command) => command.what)).toEqual(['worker:worker-1']);

    // A worker chat that has not opened yet must not open for a run that is over.
    resetSwarm();
    expect(pendingCommands()).toEqual([]);
  });

  it('stops listening to the swarm while it is down', async () => {
    await pair();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingCommands()).toHaveLength(1);

    await stopBridge();
    // With the bridge down there is nobody to hear this, which is the point: the listener
    // came off with the module. A stale one would be reaching into the queue of a bridge
    // that is not running.
    resetSwarm();
    expect(pendingCommands()).toHaveLength(1);

    const port = await startBridge();
    expect(port).not.toBeNull();
    base = `http://127.0.0.1:${port}`;
    await pair();
    // And the command is not handed out on the way back up either: its worker belongs to a
    // run that no longer exists, so the ordinary tidy pass retires it when the page asks.
    const id = lastOpened();
    expect((await request('POST', '/commands/redeem', { body: { id, client: 'tab-late' } })).status).toBe(404);
  });
});
