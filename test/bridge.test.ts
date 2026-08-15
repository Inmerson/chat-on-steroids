/**
 * The local bridge, over real HTTP.
 *
 * This server is the one thing in the app a web page could try to reach, and it holds
 * the credential the extension authenticates with, so the tests here are mostly about
 * what it refuses: a page origin, a missing token, a second guess at a pairing code.
 * The happy paths matter too, but they are the cheap half.
 */

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const {
  bridgePort,
  cancelPairing,
  pendingCommands,
  queueResume,
  resetBridgeForTests,
  restoreCommands,
  startBridge,
  startPairing,
  stopBridge,
  unpair
} = await import('../src/main/bridge.js');
const { flushDurable, initDurableStore, readDurable, writeDurableSoon } = await import('../src/main/durable.js');
const { initSessionStore, readEvents, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { recordToolCall, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { createAgents, joinBoundConversation, resetSwarm } = await import('../src/main/agents.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

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

/** Pairs the way the extension does, and remembers the token for later requests. */
async function pair(): Promise<string> {
  const { code } = startPairing();
  const reply = await request('POST', '/pair', { body: { code }, auth: null });
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
  resetBridgeForTests();
  resetRecorderForTests();
  resetSwarm();
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
    expect(reply.body.version).toBe('1.5.1');
    expect(reply.body.bridge).toBe(3);
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

// ----------------------------------------------------------------- pairing

describe('pairing', () => {
  it('refuses to pair when the user is not looking at a code', async () => {
    const reply = await request('POST', '/pair', { body: { code: '123456' }, auth: null });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe('no_pairing');
  });

  it('issues a token for the code shown in the app', async () => {
    const issued = await pair();
    expect(issued).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const hello = await request('GET', '/hello', { auth: null });
    expect(hello.body.paired).toBe(true);
  });

  it('burns the code on a single wrong guess', async () => {
    const { code } = startPairing();
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await request('POST', '/pair', { body: { code: wrong }, auth: null })).body.error).toBe('bad_code');
    // The right code now fails too: six digits are only safe without retries.
    const second = await request('POST', '/pair', { body: { code }, auth: null });
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('no_pairing');
  });

  it('stops accepting a code the user cancelled', async () => {
    const { code } = startPairing();
    cancelPairing();
    expect((await request('POST', '/pair', { body: { code }, auth: null })).body.error).toBe('no_pairing');
  });

  it('drops the token when the user unpairs', async () => {
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
      ['GET', '/commands'],
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
  it('hands back only tool-call summaries, with the turn they belong to', async () => {
    await pair();
    const conversationId = '99999999-8888-7777-6666-555555555555';
    await request('POST', '/events', {
      body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-42' }] }
    });
    await recordToolCall({
      tool: 'edit_file',
      args: { path: '/project/src/main.ts', secretish: 'value' },
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
        durationMs: null
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
    expect(reply.body.generating).toBe(true);
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
      body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 't' }] }
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
    const all = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(all.body.entries).toHaveLength(3);
    const lastSeq = all.body.entries.at(-1).seq;
    const after = await request('GET', `/activity?conversationId=${conversationId}&since=${lastSeq + 1}`);
    expect(after.body.entries).toEqual([]);
  });

  it('never sends a live agent credential through session history or the extension activity feed', async () => {
    await pair();
    const conversationId = '45454545-6767-8989-abab-cdcdcdcdcdcd';
    await request('POST', '/events', {
      body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'secret-turn' }] }
    });
    const created = createAgents({ workers: [{ task: 'security check' }], caller: {} });
    const secret = created.primeSecret!;
    await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/secret.ts', agent_key: secret, note: `echo ${secret}` },
      content: [{ type: 'text', text: `result accidentally echoed ${secret}` }],
      // Failed summaries may copy the first result line into summary.detail, so this
      // exercises the leak path that an otherwise-successful call would not touch.
      outcome: 'error',
      durationMs: 2,
      startedAt: Date.now()
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.body.entries).toHaveLength(1);
    const serialised = JSON.stringify(reply.body.entries[0]);
    expect(serialised).not.toContain(secret);
    expect(serialised).toContain('agent key removed');
    const stored = JSON.stringify(await readEvents(reply.body.sessionId));
    expect(stored).not.toContain(secret);
    expect(stored).toContain('agent key removed');
  });
});

// ---------------------------------------------------------------- commands

describe('leased commands', () => {
  it('offers a resume bootstrap and forgets it only after a sent acknowledgement', async () => {
    await pair();
    expect((await request('GET', '/commands')).body.commands).toEqual([]);

    const command = queueResume('handoff-1234');
    expect(command).not.toBeNull();
    const listed = await request('GET', '/commands');
    expect(listed.body.commands).toHaveLength(1);
    expect(listed.body.commands[0].id).toBe(command!.id);
    expect(listed.body.commands[0].kind).toBe('open-chat');
    expect(listed.body.commands[0].text).toContain('resume_session');
    expect(listed.body.commands[0].attempt).toBe(1);

    // Claiming is a lease, not consumption. Nobody else gets the command while held.
    expect((await request('GET', '/commands')).body.commands).toEqual([]);
    const ack = await request('POST', '/commands/ack', {
      body: { id: command!.id, status: 'sent', conversationId: 'abcdef12-3456-7890-abcd-ef1234567890' }
    });
    expect(ack.status).toBe(200);
    expect((await request('GET', '/commands')).body.commands).toEqual([]);
  });

  it('releases a failed lease immediately, retries the same command, and lets working renew it', async () => {
    await pair();
    const command = queueResume('handoff-retry')!;
    const first = (await request('GET', '/commands')).body.commands[0];
    expect(first.id).toBe(command.id);
    expect(first.attempt).toBe(1);

    await request('POST', '/commands/ack', { body: { id: command.id, status: 'failed', error: 'tab died' } });
    const retry = (await request('GET', '/commands')).body.commands[0];
    expect(retry.id).toBe(command.id);
    expect(retry.attempt).toBe(2);

    await request('POST', '/commands/ack', { body: { id: command.id, status: 'working' } });
    expect((await request('GET', '/commands')).body.commands).toEqual([]);
    expect(pendingCommands()[0]?.attempts).toBe(2);

    await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent' } });
    expect(pendingCommands()).toEqual([]);
  });

  it('tells an invited worker which agent it is without putting its task or minted credential on disk', async () => {
    await pair();
    createAgents({ workers: [{ task: 'SECRET TASK BODY THAT STAYS IN THE APP' }], caller: {} });
    const listed = await request('GET', '/commands');
    expect(listed.body.commands).toHaveLength(1);
    const command = listed.body.commands[0];
    expect(command.agent).toBe('worker-1');
    expect(command.text).toContain('join_agent');
    expect(command.text).toContain('worker-1');
    expect(command.text).toContain('with no arguments');
    expect(command.text).not.toContain('SECRET TASK BODY');
    expect(command.text).not.toContain('joinKey');

    await flushDurable();
    const stored = await readDurable<unknown>('bridge-commands');
    expect(JSON.stringify(stored)).not.toContain('joinKey');
  });

  it('keeps a worker bootstrap leased after send and retires it only once the worker really joins', async () => {
    await pair();
    createAgents({ workers: [{ task: 'audit the compaction' }], caller: {} });
    const listed = await request('GET', '/commands');
    const command = listed.body.commands[0];
    const conversationId = 'abcdef12-3456-7890-abcd-ef1234567890';
    expect(command.text).toContain('join_agent tool with no arguments');

    await request('POST', '/commands/ack', {
      body: {
        id: command.id,
        status: 'sent',
        conversationId,
        agent: 'worker-1'
      }
    });
    expect(pendingCommands()).toHaveLength(1);
    expect((await request('GET', '/commands')).body.commands).toEqual([]);

    joinBoundConversation(conversationId);
    expect((await request('GET', '/commands')).body.commands).toEqual([]);
    expect(pendingCommands()).toEqual([]);
  });

  it('serializes fresh worker bootstraps so browser-bound joins stay unambiguous', async () => {
    await pair();
    createAgents({
      workers: [
        { task: 'first audit' },
        { task: 'second audit' }
      ],
      caller: {}
    });

    const firstPage = await request('GET', '/commands');
    expect(firstPage.body.commands).toHaveLength(1);
    expect(firstPage.body.commands[0].agent).toBe('worker-1');
    const first = firstPage.body.commands[0];
    const firstConversation = '11111111-2222-3333-4444-555555555555';
    await request('POST', '/commands/ack', {
      body: { id: first.id, status: 'sent', conversationId: firstConversation, agent: 'worker-1' }
    });

    // worker-2 is queued, but cannot open until worker-1 has actually joined.
    expect((await request('GET', '/commands')).body.commands).toEqual([]);
    joinBoundConversation(firstConversation);

    const secondPage = await request('GET', '/commands');
    expect(secondPage.body.commands).toHaveLength(1);
    expect(secondPage.body.commands[0].agent).toBe('worker-2');
  });

  it('persists retry state across an app restart without persisting the minted credential', async () => {
    await pair();
    const command = queueResume('handoff-persist')!;
    const offered = (await request('GET', '/commands')).body.commands[0];
    expect(offered.attempt).toBe(1);
    await request('POST', '/commands/ack', { body: { id: command.id, status: 'failed', error: 'browser closed' } });
    await flushDurable();

    resetBridgeForTests();
    await restoreCommands();
    expect(pendingCommands()).toEqual([
      { id: command.id, what: 'resume:handoff-persist', attempts: 1, lastError: 'browser closed' }
    ]);
    const retried = (await request('GET', '/commands')).body.commands[0];
    expect(retried.id).toBe(command.id);
    expect(retried.attempt).toBe(2);
  });

  it('ignores an acknowledgement for a command that does not exist', async () => {
    await pair();
    const reply = await request('POST', '/commands/ack', { body: { id: 'made-up' } });
    expect(reply.status).toBe(200);
  });
});
