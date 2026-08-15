/**
 * Service worker: the only part of the extension that talks to the app.
 *
 * The pairing token lives here and in chrome.storage.local, never in a content
 * script and never in the page. A content script that were somehow compromised can
 * ask this worker to post observations about the page it is already reading; it
 * cannot read the token, cannot reach the app on its own (the app refuses a
 * https://chatgpt.com origin), and there is no message that makes the app touch a
 * file, run a command or change a permission.
 *
 * Discovery is a scan of five fixed loopback ports for a /hello that identifies the
 * app. Nothing is broadcast and nothing listens.
 *
 * This worker also owns the observation journal. A content script lives only as long as
 * its page: a reload, a navigation or a crash takes its memory with it, and ChatGPT
 * virtualises old turns, so what is gone is often gone for good. So a content script
 * hands an observation over immediately and the durable copy lives here, in
 * chrome.storage.session — which survives this worker being shut down (Chrome does that
 * after seconds of idling) and dies with the browser, which is the right lifetime for a
 * record the app has not accepted yet.
 */

const PORTS = [8765, 8766, 8767, 8768, 8769];
const HELLO_TIMEOUT_MS = 1200;
/** Bumped only when the request/response shape changes; the app compares it. */
const BRIDGE_PROTOCOL = 3;

/**
 * Journal caps. The byte figure is what actually matters — chrome.storage.session has a
 * ten-megabyte budget for the whole extension — and the count keeps a pathological run
 * of tiny events from making every write expensive.
 */
const MAX_JOURNAL = 4000;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const BATCH = 100;

let port = null;
let token = null;
let loaded = false;

/**
 * Observations accepted from content scripts but not yet accepted by the app.
 *
 * Each entry carries the conversation it was observed in, captured at that moment.
 * Flushing groups by that field rather than labelling a whole batch with whatever
 * conversation happens to be current — a tab that moves from chat A to chat B while the
 * app is unreachable would otherwise file A's messages into B's history.
 */
let journal = [];
let flushing = false;

/** The instruction waiting for the next fresh ChatGPT tab to pick up. */
let pendingBootstrap = null;
/** Command ids this browser has already delivered, so a re-offer is not typed twice. */
let settled = [];

async function load() {
  if (loaded) return;
  const stored = await chrome.storage.local.get(['port', 'token']);
  port = typeof stored.port === 'number' ? stored.port : null;
  token = typeof stored.token === 'string' ? stored.token : null;
  const live = await chrome.storage.session.get(['bootstrap', 'settled', 'journal']);
  pendingBootstrap = live.bootstrap || null;
  settled = Array.isArray(live.settled) ? live.settled : [];
  journal = Array.isArray(live.journal) ? live.journal : [];
  loaded = true;
}

async function persist() {
  await chrome.storage.local.set({ port, token });
}

async function persistLive() {
  await chrome.storage.session.set({ bootstrap: pendingBootstrap, settled: settled.slice(-40) });
}

/**
 * Writes the journal where it will survive this worker being shut down.
 *
 * Chrome stops the service worker after seconds of idling, so an in-memory journal is
 * not a journal at all. If the write is refused the size estimate was optimistic, so
 * compact harder and try once more; only if *that* fails is durability genuinely lost,
 * and then the journal says so in place rather than pretending it is safe.
 */
let durabilityGap = false;

async function persistJournal() {
  try {
    await chrome.storage.session.set({ journal });
    durabilityGap = false;
    return true;
  } catch {
    makeRoom(true);
    try {
      await chrome.storage.session.set({ journal });
      durabilityGap = false;
      return true;
    } catch (err) {
      if (!durabilityGap) {
        durabilityGap = true;
        journal.push(
          gapEntry(
            journal.length > 0 ? journal[journal.length - 1].conversationId : null,
            'chat_error',
            '⚠ The browser refused to store this extension’s pending observations. Until the app accepts them they exist only in memory, so closing the browser or reloading the extension would lose them.'
          )
        );
      }
      return false;
    }
  }
}

// --------------------------------------------------------------------- journal

/**
 * Events that are dropped only when there is genuinely nothing else to give up.
 *
 * Progress lines are not among them: they are dense, repetitive, and their outline can
 * be inferred from what surrounds them. A user message cannot be inferred from anything.
 */
const ESSENTIAL = new Set(['user_message', 'assistant_message', 'chat_error', 'turn_start', 'turn_end']);

/**
 * Cached per-entry serialised size, kept out-of-band so measuring an entry does not
 * mutate the thing we later write to chrome.storage.session.
 *
 * The old cache lived as `entry.b`. That made every measured entry several bytes larger
 * after it had been measured, so the journal could report itself under the 4 MiB cap
 * while the actual JSON written to Chrome was already over it.
 */
const sizeCache = new WeakMap();

function sizeOf(entry) {
  const cached = sizeCache.get(entry);
  if (typeof cached === 'number') return cached;
  let bytes = 500;
  try {
    bytes = JSON.stringify(entry).length;
  } catch {
    // A malformed observation will be rejected by the app later; keep its pressure
    // estimate conservative here so it cannot bypass the browser journal cap.
  }
  sizeCache.set(entry, bytes);
  return bytes;
}

/** Exact JSON-array size for the journal itself, including commas and brackets. */
function totalBytes() {
  if (journal.length === 0) return 2;
  let sum = 2 + journal.length - 1;
  for (const entry of journal) sum += sizeOf(entry);
  return sum;
}

function overBudget(bytes) {
  return journal.length > MAX_JOURNAL || bytes > MAX_JOURNAL_BYTES;
}

function gapEntry(conversationId, kind, text) {
  return { conversationId, agent: null, gap: true, event: { kind, time: Date.now(), text } };
}

/**
 * Brings the journal back inside both budgets — count *and* bytes.
 *
 * Both matter and for different reasons: the count keeps a run of tiny events from
 * making every write expensive, and the byte figure is the one Chrome enforces. Being
 * under one while over the other is what quietly turned this journal back into plain
 * RAM, because chrome.storage.session then refused the write.
 *
 * Progress lines go first, oldest first. Essentials are given up only when dropping
 * every last progress line still leaves the journal over budget — and when that
 * happens it is stated in the record, in place, rather than closed over. A history with
 * an acknowledged hole is usable; one with an invisible hole is not.
 *
 * `tighten` compacts to roughly three quarters of the budget instead of exactly to it,
 * used when Chrome has already refused a write and the estimate is evidently optimistic.
 */
function makeRoom(tighten = false) {
  const countCap = tighten ? Math.floor(MAX_JOURNAL * 0.75) : MAX_JOURNAL;
  const byteCap = tighten ? Math.floor(MAX_JOURNAL_BYTES * 0.75) : MAX_JOURNAL_BYTES;
  const fits = () => journal.length <= countCap && totalBytes() <= byteCap;
  if (fits()) return;

  /** Updates a gap and invalidates its cached serialised size. */
  const setGapText = (gap, text) => {
    gap.event.text = text;
    sizeCache.delete(gap);
  };

  // Pass one: progress and other non-essential lines, oldest first. The gap marker is
  // inserted on the first removal and counts against the limits while we keep trimming,
  // so pressure can never make the algorithm delete its own evidence of what was lost.
  let dropped = 0;
  let progressGap = null;
  while (!fits()) {
    const index = journal.findIndex((entry) => !entry.gap && !ESSENTIAL.has(entry.event.kind));
    if (index < 0) break;
    const [entry] = journal.splice(index, 1);
    dropped++;
    if (!progressGap) {
      progressGap = gapEntry(entry.conversationId, 'progress', '');
      journal.splice(Math.min(index, journal.length), 0, progressGap);
    }
    setGapText(
      progressGap,
      `⚠ ${dropped} progress line(s) observed here were dropped in the browser before the app accepted them. The app was unreachable and the local queue was full.`
    );
  }
  if (fits()) return;

  // Pass two: essentials themselves have to go. This is real loss, so keep one durable
  // marker naming exactly what kinds disappeared. As above, the marker is present while
  // trimming, which guarantees the final journal is genuinely inside both caps.
  const counts = {};
  let lost = 0;
  let lossGap = null;
  while (!fits()) {
    const index = journal.findIndex((entry) => !entry.gap);
    if (index < 0) break;
    const [entry] = journal.splice(index, 1);
    lost++;
    counts[entry.event.kind] = (counts[entry.event.kind] || 0) + 1;
    if (!lossGap) {
      lossGap = gapEntry(entry.conversationId, 'chat_error', '');
      journal.splice(Math.min(index, journal.length), 0, lossGap);
    }
    const detail = Object.entries(counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ');
    setGapText(
      lossGap,
      `⚠ ${lost} observation(s) (${detail}) were lost in the browser before the app accepted them: the local journal hit its storage limit while the app was unreachable. This part of the history is incomplete.`
    );
  }
}

function enqueue(entries) {
  for (const entry of entries) {
    if (!entry || !entry.event || typeof entry.event.kind !== 'string') continue;
    journal.push({
      conversationId: typeof entry.conversationId === 'string' ? entry.conversationId : null,
      // Observations made before ChatGPT has assigned a conversation id are held under
      // the tab that saw them; bindProvisional() renames them once the id exists.
      provisional: typeof entry.provisional === 'string' ? entry.provisional : null,
      agent: typeof entry.agent === 'string' ? entry.agent : null,
      event: entry.event
    });
  }
  makeRoom();
}

/**
 * Gives a real conversation id to everything a tab observed before one existed.
 *
 * A brand new chat has no id until ChatGPT accepts the first message, and that is
 * exactly when the first user message is observed. Those entries are journalled here
 * immediately under the tab's key, so a reload in that window does not take them with
 * it, and this renames them the moment the id turns up.
 *
 * Only entries observed in the last ten minutes are bound. A tab that sat on an empty
 * composer this morning and is used for a different chat this afternoon must not have
 * the morning's observations filed into the afternoon's conversation.
 */
const PROVISIONAL_TTL_MS = 10 * 60 * 1000;

function bindProvisional(provisional, conversationId) {
  if (!provisional || !conversationId) return 0;
  const cutoff = Date.now() - PROVISIONAL_TTL_MS;
  let bound = 0;
  for (const entry of journal) {
    if (entry.provisional !== provisional || entry.conversationId) continue;
    if (typeof entry.event.time === 'number' && entry.event.time < cutoff) continue;
    entry.conversationId = conversationId;
    entry.provisional = null;
    sizeCache.delete(entry);
    bound++;
  }
  return bound;
}

/**
 * Delivers what the app has not accepted yet, one conversation at a time.
 *
 * Nothing leaves the journal until the app answers 200 for that batch. A 413 is the one
 * case where retrying unchanged is pointless, so the batch is halved instead.
 */
async function drain() {
  await load();
  if (flushing || journal.length === 0 || !token) return { ok: true, pending: journal.length };
  flushing = true;
  try {
    let guard = 0;
    while (journal.length > 0 && guard++ < 20) {
      const head = journal.find((entry) => entry.conversationId);
      if (!head) break;
      const conversationId = head.conversationId;
      const mine = journal.filter((entry) => entry.conversationId === conversationId).slice(0, BATCH);
      const agent = (mine.find((entry) => entry.agent) || {}).agent || undefined;
      const result = await call('/events', {
        method: 'POST',
        body: JSON.stringify({
          conversationId,
          agent,
          events: mine.map((entry) => entry.event)
        })
      });
      if (result.status === 413 && mine.length > 1) {
        // Too big for the app to accept. Send half; the remainder stays queued.
        const half = mine.slice(0, Math.floor(mine.length / 2));
        const retry = await call('/events', {
          method: 'POST',
          body: JSON.stringify({ conversationId, agent, events: half.map((entry) => entry.event) })
        });
        if (!retry.ok) break;
        const sent = new Set(half);
        journal = journal.filter((entry) => !sent.has(entry));
        continue;
      }
      if (!result.ok) break;
      const sent = new Set(mine);
      journal = journal.filter((entry) => !sent.has(entry));
    }
    await persistJournal();
    return { ok: true, pending: journal.length };
  } finally {
    flushing = false;
  }
}

// -------------------------------------------------------------------- transport

async function hello(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HELLO_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${candidate}/hello`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: versionHeaders()
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body && body.app === 'chatgpt-local-files' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Lets the app say plainly when the two halves are out of step. */
function versionHeaders() {
  let version = '0';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // Not worth failing a request over.
  }
  return { 'x-extension-version': version, 'x-extension-protocol': String(BRIDGE_PROTOCOL) };
}

/** Finds the app, preferring the port that worked last time. */
async function discover(force = false) {
  await load();
  if (port !== null && !force) {
    const body = await hello(port);
    if (body) return { port, paired: body.paired === true };
  }
  for (const candidate of PORTS) {
    const body = await hello(candidate);
    if (body) {
      port = candidate;
      await persist();
      return { port: candidate, paired: body.paired === true };
    }
  }
  port = null;
  await persist();
  return null;
}

/** One authenticated request. Returns { ok, status, data } and never throws. */
async function call(path, init = {}) {
  await load();
  const found = await discover();
  if (!found) return { ok: false, status: 0, error: 'app_not_found' };
  if (!token) return { ok: false, status: 401, error: 'not_paired' };
  try {
    const response = await fetch(`http://127.0.0.1:${found.port}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...versionHeaders(),
        authorization: `Bearer ${token}`
      }
    });
    if (response.status === 401) {
      // The app was unpaired, or its stored token was replaced. Forget ours rather
      // than retrying with a credential that will never work again.
      token = null;
      await persist();
      return { ok: false, status: 401, error: 'not_paired' };
    }
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message ? err.message : err) };
  }
}

async function pair(code) {
  const found = await discover(true);
  if (!found) return { ok: false, error: 'app_not_found' };
  try {
    const response = await fetch(`http://127.0.0.1:${found.port}/pair`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...versionHeaders() },
      body: JSON.stringify({ code })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.token !== 'string') {
      return { ok: false, error: data.error || `HTTP ${response.status}`, message: data.message };
    }
    token = data.token;
    await persist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// -------------------------------------------------------------------- commands

/**
 * Picks up at most one queued "open a fresh chat" command and opens the tab for it.
 *
 * Claiming happens here because the worker is a single instance: several ChatGPT tabs
 * poll, but only one of them can win a command. The claim is a lease held by the app —
 * if this browser never manages to type the message, the app hands the command out
 * again rather than losing it.
 */
async function pollCommands() {
  await load();
  if (pendingBootstrap) {
    const expired = Date.now() - pendingBootstrap.createdAt > pendingBootstrap.leaseMs;
    if (!expired) return { ok: true, waiting: true };
    // A tab was opened but never collected the bootstrap. Previously this memory slot
    // blocked every later worker/resume command forever because only takeBootstrap()
    // knew how to expire it. Release and report it here too, since polling is what keeps
    // running even when the fresh tab died before its content script came up.
    const stale = pendingBootstrap;
    pendingBootstrap = null;
    await persistLive();
    await ackCommand(stale.id, 'failed', 'no fresh ChatGPT tab collected it before the lease expired');
  }
  const result = await call('/commands');
  if (!result.ok) return result;
  const commands = Array.isArray(result.data.commands) ? result.data.commands : [];
  const next = commands.find((command) => command && !settled.includes(command.id));
  if (!next) return { ok: true, waiting: false };
  pendingBootstrap = {
    id: next.id,
    text: String(next.text || '').slice(0, 4000),
    agent: typeof next.agent === 'string' ? next.agent : null,
    leaseMs: Number(next.leaseMs) || 90_000,
    createdAt: Date.now()
  };
  await persistLive();
  try {
    await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
  } catch (err) {
    // No tab, no bootstrap. Tell the app now so it can re-offer immediately instead of
    // waiting out a lease nothing is holding.
    const failed = pendingBootstrap;
    pendingBootstrap = null;
    await persistLive();
    await ackCommand(failed.id, 'failed', String(err && err.message ? err.message : err));
    return { ok: false, error: 'tab_failed' };
  }
  return { ok: true, opened: true };
}

/**
 * Handed to the first fresh chat that asks, once.
 *
 * A bootstrap nobody collected inside its lease is not typed later: the tab was
 * probably closed, and the app is already free to offer it to a new one. Reporting the
 * failure here is what makes that re-offer immediate.
 */
async function takeBootstrap() {
  await load();
  if (!pendingBootstrap) return null;
  const taken = pendingBootstrap;
  if (Date.now() - taken.createdAt > taken.leaseMs) {
    pendingBootstrap = null;
    await persistLive();
    await ackCommand(taken.id, 'failed', 'no fresh ChatGPT tab collected it in time');
    return null;
  }
  pendingBootstrap = null;
  await persistLive();
  return taken;
}

async function ackCommand(id, status, error, conversationId, agent) {
  if (status === 'sent' && !agent) {
    // Resume commands are finished once their bootstrap message was sent. Worker
    // commands are different: the app deliberately keeps them until join_agent really
    // succeeds, so do not blacklist their id here or a post-safety-block retry could
    // never be collected by this service worker.
    settled.push(id);
    await persistLive();
  }
  return call('/commands/ack', {
    method: 'POST',
    body: JSON.stringify({
      id,
      status,
      error: error || undefined,
      conversationId: conversationId || undefined,
      agent: agent || undefined
    })
  });
}

/**
 * A stable key for the tab an observation came from.
 *
 * The tab id, not the page: it survives a reload, which is exactly the window where an
 * un-bound observation would otherwise be lost. Falls back to a per-worker constant if
 * Chrome does not name the sender, which only costs precision when several fresh chats
 * are opened at once and never misfiles anything that already has a conversation id.
 */
function tabKey(sender) {
  const id = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  return id === null ? 'tab-unknown' : `tab-${id}`;
}

const HANDLERS = {
  async status() {
    await load();
    const found = await discover();
    return {
      connected: found !== null,
      port: found ? found.port : null,
      paired: token !== null,
      pending: journal.length
    };
  },
  async pair(message) {
    return pair(String(message.code || ''));
  },
  async unpair() {
    await load();
    token = null;
    await persist();
    return { ok: true };
  },
  /**
   * Takes observations off a content script's hands.
   *
   * Answering ok means "journalled here", not "the app has it". That is the point: the
   * page can be reloaded a moment later, and this worker will keep retrying delivery.
   * Entries with no conversation id yet are journalled too, under the tab that saw
   * them, so the very first message of a fresh chat is durable before ChatGPT has
   * decided what to call the conversation.
   */
  async events(message, sender) {
    await load();
    const key = tabKey(sender);
    const entries = (Array.isArray(message.entries) ? message.entries : []).map((entry) =>
      entry && !entry.conversationId ? { ...entry, provisional: key } : entry
    );
    enqueue(entries);
    if (message.conversationId) bindProvisional(key, message.conversationId);
    const stored = await persistJournal();
    const result = await drain();
    return { ok: true, pending: result.pending, durable: stored };
  },

  /**
   * The tab now knows which conversation it is in.
   *
   * Everything it observed beforehand belongs to that conversation, including anything
   * journalled during a page load that happened before the id existed — the tab key
   * survives a reload, which is the whole reason it is the tab and not the page.
   */
  async bind(message, sender) {
    await load();
    const bound = bindProvisional(tabKey(sender), String(message.conversationId || ''));
    if (bound > 0) {
      await persistJournal();
      await drain();
    }
    return { ok: true, bound };
  },
  async drain() {
    return drain();
  },
  async activity(message) {
    const query = `?conversationId=${encodeURIComponent(message.conversationId)}&since=${Number(message.since) || 0}`;
    return call(`/activity${query}`);
  },
  async closed(message) {
    // Deliver anything still queued for this conversation before saying it is over.
    await drain();
    return call('/closed', {
      method: 'POST',
      body: JSON.stringify({ conversationId: message.conversationId })
    });
  },
  async compact(message) {
    return call('/compact', {
      method: 'POST',
      body: JSON.stringify({ conversationId: message.conversationId, resume: message.resume !== false })
    });
  },
  async poll() {
    await drain();
    return pollCommands();
  },
  async bootstrap() {
    return { ok: true, bootstrap: await takeBootstrap() };
  },
  async ack(message) {
    return ackCommand(
      String(message.id || ''),
      message.status === 'failed' || message.status === 'working' ? message.status : 'sent',
      message.error,
      message.conversationId,
      message.agent
    );
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && typeof message.type === 'string' ? HANDLERS[message.type] : null;
  if (!handler) {
    sendResponse({ ok: false, error: 'unknown_message' });
    return false;
  }
  handler(message, sender).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
  );
  return true;
});
