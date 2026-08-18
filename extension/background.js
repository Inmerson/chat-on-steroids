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
const BRIDGE_PROTOCOL = 4;

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
 * The one `load()` in flight, shared by everything that has to wait for it.
 *
 * `loaded` alone is not a guard, because it is only set after two awaited storage reads.
 * Chrome stops this worker after seconds of idling, so the cold path is the normal path:
 * two tabs report at the same moment, both see `loaded === false`, and both walk the whole
 * of load(). The first finishes, its handler enqueues an observation and persists it — and
 * then the second finishes and assigns the journal it read *before* that write straight
 * over the global. The entry the first handler already answered `ok` for is gone, and
 * nothing anywhere reports a loss, because as far as both halves are concerned each did
 * its job. Serialising initialisation is the whole fix: after this, the second caller
 * awaits the same promise and never re-reads.
 */
let loading = null;

/**
 * Set when the user disconnected on purpose, and cleared only when they connect again.
 *
 * Without it, "Disconnect" cleared the token and the very next `/hello` handed this
 * browser a new one — a button whose effect lasted until the next poll, roughly two
 * seconds. Auto-provisioning is right for a browser that has never connected and wrong
 * for one that was told to stop, and only this flag can tell those two apart.
 */
let disconnected = false;

/**
 * The `/pair` in flight, shared by everything that wants a token.
 *
 * Several tabs coming back at once all find no token and all call `/pair`. Each call
 * mints a fresh credential and invalidates the one before it, so the tabs rotate each
 * other's tokens: every request 401s, drops its token, and provisions again. One promise
 * means one credential no matter how many callers arrive together.
 */
let pairing = null;

/**
 * When the app was last confirmed to be on `port`, and how long that is believed for.
 *
 * `discover()` used to run a `/hello` before every authenticated request, which doubled
 * the bridge traffic of an already-chatty poll and, with several tabs open, could spend
 * the 900/min budget on nothing but asking whether the app was still there. A failed
 * request re-checks immediately, so nothing is lost by believing a recent answer.
 */
let portCheckedAt = 0;
const PORT_TRUST_MS = 30_000;

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

/**
 * Which ChatGPT conversation each browser tab currently represents.
 *
 * Conversation lifetime is a browser-level fact, not a document-level one. A content
 * script dies on reload and `pagehide` fires even though the tab and conversation are
 * still alive; with two tabs on one chat, either document can disappear while the other
 * remains. Keeping this in the service worker lets a tab reload without closing the
 * app-side session and lets `/closed` mean the last live tab really left.
 *
 * Persisted in storage.session because Chrome routinely stops this worker while tabs stay
 * open. `chrome.tabs.onRemoved` wakes it again and can then retire the right conversation.
 */
let tabConversations = {};

/**
 * Command ids this browser has already delivered.
 *
 * All that is left of the delivery bookkeeping. There used to be an `opened` list beside it,
 * for a periodic alarm that opened tabs for commands nobody had delivered; the app opens the
 * chat itself, exactly once, and a command that does not get taken up fails rather than being
 * arranged for again. This one stays because a marked page that reloads must not type the
 * same bootstrap into a second conversation.
 */
let settled = [];

function load() {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = loadOnce().finally(() => {
      // Only ever cleared after loadOnce() has run to completion or thrown. A throw leaves
      // `loaded` false, so the next caller genuinely retries rather than proceeding on
      // half-initialised globals.
      loading = null;
    });
  }
  return loading;
}

async function loadOnce() {
  const stored = await chrome.storage.local.get(['port', 'token', 'disconnected']);
  port = typeof stored.port === 'number' ? stored.port : null;
  token = typeof stored.token === 'string' ? stored.token : null;
  // Deliberately in `local` rather than `session`: a choice to disconnect that a browser
  // restart undoes is not a choice, it is a delay.
  disconnected = stored.disconnected === true;
  const live = await chrome.storage.session.get(['settled', 'journal', 'tabConversations']);
  settled = Array.isArray(live.settled) ? live.settled : [];
  journal = Array.isArray(live.journal) ? live.journal : [];
  tabConversations =
    live.tabConversations && typeof live.tabConversations === 'object' && !Array.isArray(live.tabConversations)
      ? { ...live.tabConversations }
      : {};
  loaded = true;
}

async function persist() {
  await chrome.storage.local.set({ port, token, disconnected });
}

async function persistLive() {
  await chrome.storage.session.set({
    settled: settled.slice(-40),
    tabConversations
  });
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

/**
 * Finds the app, preferring the port that worked last time.
 *
 * A recent confirmation is believed rather than re-checked. The alternative was a
 * `/hello` in front of every authenticated request, which doubled the traffic of a poll
 * that already runs every two seconds in every open tab. Nothing is lost by it: a request
 * to a port the app has left fails, and a failure re-checks immediately.
 */
async function discover(force = false) {
  await load();
  if (port !== null && !force) {
    if (Date.now() - portCheckedAt < PORT_TRUST_MS) return { port, paired: token !== null };
    const body = await hello(port);
    if (body) {
      portCheckedAt = Date.now();
      return { port, paired: body.paired === true };
    }
  }
  for (const candidate of PORTS) {
    const body = await hello(candidate);
    if (body) {
      port = candidate;
      portCheckedAt = Date.now();
      await persist();
      return { port: candidate, paired: body.paired === true };
    }
  }
  port = null;
  portCheckedAt = 0;
  await persist();
  return null;
}

/** Forgets that the app was ever confirmed, so the next call really looks. */
function forgetPort() {
  portCheckedAt = 0;
}

/** One authenticated request. Returns { ok, status, data } and never throws. */
async function call(path, init = {}, retried = false) {
  await load();
  const found = await discover();
  if (!found) return { ok: false, status: 0, error: 'app_not_found' };
  if (!token) {
    // Somebody disconnected this browser on purpose. Quietly getting a new token here is
    // how "Disconnect" came to mean "disconnect until the next poll".
    if (disconnected) return { ok: false, status: 401, error: 'disconnected' };
    // First use. Ask the app for a token instead of asking the user for one — see
    // provision() for why that is not a downgrade.
    const got = await provision();
    if (!got.ok) return { ok: false, status: 401, error: got.error || 'not_paired' };
  }
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
      // Our token no longer matches the app's — it was reset, or the app's storage was
      // rebuilt. Drop ours and provision a new one once, rather than retrying forever
      // with a credential that will never work again or making the user do it by hand.
      token = null;
      await persist();
      if (retried) return { ok: false, status: 401, error: 'not_paired' };
      return call(path, init, true);
    }
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    // The request never reached anything, so the belief that the app is on this port is
    // exactly what has just been disproved. Next call looks properly.
    forgetPort();
    return { ok: false, status: 0, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Gets this browser a bearer token, with nothing for the user to type.
 *
 * There used to be a six-digit code shown in the app and entered in the extension popup.
 * It bought nothing: the only callers that can reach the app at all are already on this
 * machine's loopback interface — the app refuses any web origin outright — so the code
 * was asking the user to prove something the network had already proved. What it did cost
 * was the first-run path, which failed until somebody found the popup.
 *
 * The token itself stays: it is what keeps a second local program from driving the bridge
 * by accident, and it is why the marker in a chat URL is harmless on its own.
 */
function provision() {
  // Singleflight. Everything that wants a token waits on the same request: `/pair` mints
  // a fresh credential and invalidates the one before it, so two concurrent callers do
  // not get two tokens, they get one working token and one that has already been revoked.
  if (pairing) return pairing;
  pairing = pairOnce().finally(() => {
    pairing = null;
  });
  return pairing;
}

async function pairOnce() {
  const found = await discover(true);
  if (!found) return { ok: false, error: 'app_not_found' };
  try {
    const response = await fetch(`http://127.0.0.1:${found.port}/pair`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...versionHeaders() },
      body: JSON.stringify({})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.token !== 'string') {
      return { ok: false, error: data.error || `HTTP ${response.status}`, message: data.message };
    }
    token = data.token;
    // Connecting is the counterpart of disconnecting, and the only thing that clears it.
    disconnected = false;
    await persist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// -------------------------------------------------------------------- commands

/**
 * Fetches the one command a marked page was opened for.
 *
 * Redeeming by id is what replaced the single global "pending bootstrap" slot. That slot
 * was consumed by whichever fresh tab asked first, so a tab that came up before the slot
 * was filled got nothing and never asked again, while a later unrelated tab could take a
 * bootstrap meant for something else. An id in the URL cannot be taken by the wrong page,
 * survives the tab being reloaded, and can be asked for as many times as it takes.
 *
 * The app answers 404 for a command that has been cancelled, superseded, or already
 * sent, so a stale marker types nothing.
 */
async function redeemCommand(id, client) {
  await load();
  if (!id || settled.includes(id)) return { ok: true, command: null };
  const result = await call('/commands/redeem', { method: 'POST', body: JSON.stringify({ id, client }) });
  if (result.status === 404) return { ok: true, command: null, gone: true };
  // Another page already owns this command. Not an error to report: this page simply is not
  // the one the app is talking to, and it must type nothing.
  if (result.status === 409) return { ok: true, command: null, gone: true };
  if (!result.ok) return { ok: false, error: result.error || `HTTP ${result.status}` };
  const command = result.data && result.data.command ? result.data.command : null;
  return { ok: true, command };
}

async function ackCommand(id, status, error, conversationId, agent) {
  if (status === 'sent' && !agent) {
    // Resume commands are finished once their bootstrap message was sent. Worker
    // commands are different: the app deliberately keeps them until the join really
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

function tabId(sender) {
  return sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
}

function cleanConversationId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
}

/** Records a tab's current conversation without writing storage on every poll. */
async function noteTabConversation(sender, value) {
  const id = tabId(sender);
  const conversationId = cleanConversationId(value);
  if (id === null || !conversationId) return false;
  const key = String(id);
  if (tabConversations[key] === conversationId) return false;
  tabConversations[key] = conversationId;
  await persistLive();
  return true;
}

function conversationStillOpen(conversationId) {
  return Object.values(tabConversations).some((value) => value === conversationId);
}

/**
 * Removes one tab's ownership and closes the app-side conversation only if it was last.
 *
 * `expected` protects an old page's delayed close from deleting a mapping that the same
 * tab has already replaced with a new conversation.
 */
async function releaseTab(tab, expected = null) {
  await load();
  if (typeof tab !== 'number') return { ok: true, closed: false };
  const key = String(tab);
  const current = cleanConversationId(tabConversations[key]);
  const wanted = cleanConversationId(expected);
  if (current && (!wanted || current === wanted)) {
    delete tabConversations[key];
    await persistLive();
  }
  const conversationId = wanted || current;
  if (!conversationId || conversationStillOpen(conversationId)) {
    return { ok: true, closed: false };
  }
  // Deliver anything still queued before telling the app the final browser view is gone.
  await drain();
  return call('/closed', {
    method: 'POST',
    body: JSON.stringify({ conversationId })
  });
}

function conversationFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname !== 'chatgpt.com') return null;
    const match = /^\/c\/([0-9a-f-]{8,64})/i.exec(url.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const HANDLERS = {
  async status() {
    await load();
    const found = await discover();
    // Provisioning here as well as in call() is what makes the popup show "Connected"
    // the first time it is opened, rather than a truthful but useless "not paired".
    // Not after a deliberate disconnect: opening the popup to check is not a request to
    // undo the thing the popup was opened to check.
    if (found && !token && !disconnected) await provision();
    return {
      connected: found !== null,
      port: found ? found.port : null,
      paired: token !== null,
      disconnected,
      pending: journal.length
    };
  },
  async pair() {
    await load();
    return provision();
  },
  async unpair() {
    await load();
    token = null;
    // Remembered, not just cleared. Otherwise the next request — two seconds away in any
    // open tab — provisions a new token and the browser is connected again.
    disconnected = true;
    await persist();
    return { ok: true };
  },
  /**
   * Ask every ChatGPT tab this worker already knows about to rebuild its Local Files
   * activity stream immediately. `tabConversations` is the same durable tab registry used
   * for conversation lifetime, so this needs neither broad tab-query permissions nor URL
   * guessing from the popup.
   */
  async overwriteNow() {
    await load();
    const tabs = Object.keys(tabConversations)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
    let applied = 0;
    for (const id of tabs) {
      try {
        const result = await chrome.tabs.sendMessage(id, { type: 'clf-overwrite-now' });
        if (result && result.ok === true) applied += 1;
      } catch {
        // A tab may be between navigations/reloads and temporarily have no receiver. The
        // registry is tab-lifetime state, so do not retire it merely because one send raced.
      }
    }
    return { ok: true, tabs: applied, attempted: tabs.length };
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
    await noteTabConversation(sender, message.conversationId);
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
    await noteTabConversation(sender, message.conversationId);
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
  async activity(message, sender) {
    await load();
    await noteTabConversation(sender, message.conversationId);
    const query = `?conversationId=${encodeURIComponent(message.conversationId)}&since=${Number(message.since) || 0}`;
    return call(`/activity${query}`);
  },
  async closed(message, sender) {
    // releaseTab drains the queue and posts /closed itself, and only when this was the
    // last live tab on the conversation.
    return releaseTab(tabId(sender), message.conversationId);
  },
  async compact(message, sender) {
    await load();
    await noteTabConversation(sender, message.conversationId);
    return call('/compact', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: message.conversationId,
        resume: message.resume !== false,
        cancel: message.cancel === true,
        // The capture. `token` names the transaction the page was given when it marked the
        // compaction turn, and `summary` is that turn's own answer. Both are forwarded
        // verbatim and only together: the app refuses a brief whose token does not name an
        // open continuation for this chat, which is what keeps some other tab's text from
        // ever becoming this session's handoff.
        ...(typeof message.token === 'string' && typeof message.summary === 'string'
          ? { token: message.token, summary: message.summary }
          : {})
      })
    });
  },
  /** The marked page asking for the one command it was opened for. */
  async redeem(message) {
    return redeemCommand(String(message.id || ''), String(message.client || ''));
  },
  async ack(message) {
    return ackCommand(
      String(message.id || ''),
      message.status === 'failed' ? 'failed' : 'sent',
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

// Document unload is not conversation lifetime. A real tab close is: reload keeps the
// same tab id, while closing it wakes the service worker and retires only that tab's claim.
chrome.tabs.onRemoved.addListener((id) => {
  void releaseTab(id).catch(() => undefined);
});

// -------------------------------------------------------------------- recovery

/**
 * The only thing that runs without a page.
 *
 * A service worker is not a daemon: Chrome stops it after seconds of idling, and nothing
 * in a stopped worker fires. An alarm is the one wake-up that survives that, which is why
 * the leftovers — a command restored from a previous run, a tab closed before its content
 * script came up — are picked up here and not on a timer.
 */
