/**
 * What runs on the ChatGPT page.
 *
 * Two jobs, both read-only as far as the conversation is concerned:
 *
 *  1. Observe. Messages, turn boundaries, live progress lines and visible errors are
 *     reported to the local app. Nothing is inferred that the page does not show, and
 *     a turn that stops for no visible reason is reported as exactly that.
 *
 *  2. Relabel. The app knows what every MCP tool call actually did, because it ran it.
 *     Where a run of "Called tool" blocks in a turn matches the calls recorded for the
 *     same turn one-for-one, each block's label is replaced with the real thing. If the
 *     counts disagree, or the app could not attribute a call to this turn, nothing is
 *     touched: ChatGPT's own UI is left exactly as it was rather than being decorated
 *     with a guess.
 *
 * Every selector lives in chatgpt-dom.js. This file only deals in the shapes that
 * module returns, so a ChatGPT redesign cannot reach past it.
 */

(() => {
  'use strict';

  const OBSERVE_MS = 1000;
  const ACTIVITY_MS = 2500;
  const STATUS_MS = 15_000;
  const COMMAND_MS = 6000;
  /** Longer than any honest tool call: past this a silent turn is called stalled. */
  const STALL_MS = 10 * 60 * 1000;

  let alive = true;
  let status = { connected: false, paired: false };

  let conversationId = null;
  let agent = null;

  const queue = [];
  let flushing = false;

  /** Message ids already reported from this page load. */
  const seenMessages = new Set();
  const seenErrors = new Set();

  let generating = false;
  let turnId = null;
  let turnStartedAt = 0;
  let lastProgress = '';
  let lastChangeAt = 0;
  let stallReported = false;
  let userStopped = false;

  /** Progress lines captured live, per turn, for the injected chronological view. */
  const progressByTurn = new Map();

  let since = 0;
  let entries = [];
  let bootstrapTried = false;
  let compactBusy = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Talks to the service worker. Returns null once the extension is reloaded. */
  async function ask(message) {
    if (!alive) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      if (text.includes('Extension context invalidated') || text.includes('receiving end does not exist')) {
        alive = false;
      }
      return null;
    }
  }

  // ------------------------------------------------------------- observing

  /**
   * Records one observation, stamped with the conversation it was observed in.
   *
   * The conversation id is captured here rather than read at flush time. This tab can
   * navigate from chat A to chat B in the moment between the two, and labelling a
   * whole batch with whatever is current then files A's messages into B's history —
   * silently, permanently, and with no way to tell afterwards which entries were real.
   */
  function emit(observation) {
    queue.push({
      conversationId,
      agent,
      event: { time: Date.now(), ...observation }
    });
    if (queue.length > 400) queue.splice(0, queue.length - 400);
  }

  /**
   * Hands everything observed so far to the service worker, immediately.
   *
   * The worker journals it durably and owns delivery to the app from there. That split
   * matters: this script dies with the page, and ChatGPT virtualises old turns, so
   * anything still held here when the tab reloads is usually unrecoverable.
   *
   * Observations with no conversation id are handed over too, not held back. On a
   * brand new chat the first user message is observed *before* ChatGPT has assigned an
   * id, and holding it here until one arrived meant a reload in that window took the
   * opening message of the session with it. The worker files those under this tab and
   * renames them when bindConversation() reports the real id.
   */
  async function flush() {
    if (flushing || queue.length === 0) return;
    flushing = true;
    try {
      const batch = queue.slice(0, 200);
      const reply = await ask({
        type: 'events',
        entries: batch,
        conversationId: conversationId || undefined
      });
      // The worker accepting means it is journalled, not that the app has it. Only then
      // is it safe to forget here.
      if (reply && reply.ok === true) {
        const sent = new Set(batch);
        for (let index = queue.length - 1; index >= 0; index--) {
          if (sent.has(queue[index])) queue.splice(index, 1);
        }
      }
    } finally {
      flushing = false;
    }
  }

  /**
   * Tells the worker which conversation this tab turned out to be.
   *
   * Sent once per id, including after a reload, because the entries waiting to be
   * renamed may have been journalled by a previous page load of this same tab.
   */
  let boundId = null;
  async function bindConversation(id) {
    if (!id || boundId === id) return;
    boundId = id;
    await ask({ type: 'bind', conversationId: id });
  }

  /**
   * Forgets what belongs to the chat we just left.
   *
   * The observation queue is deliberately *not* cleared: every entry in it already
   * carries the conversation it was observed in, so anything still waiting for the app
   * is delivered to the right session rather than being thrown away because the tab
   * moved on.
   */
  function resetConversation() {
    seenMessages.clear();
    seenErrors.clear();
    progressByTurn.clear();
    entries = [];
    since = 0;
    generating = false;
    turnId = null;
    lastProgress = '';
    userStopped = false;
    stallReported = false;
  }

  function currentAssistantTurn() {
    const turns = CLF_DOM.turns();
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].role === 'assistant') return turns[index];
    }
    return null;
  }

  function lastAssistantText() {
    const messages = CLF_DOM.messages();
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'assistant') return messages[index].text;
    }
    return '';
  }

  /**
   * Why a turn stopped.
   *
   * Deliberately conservative. "The model hit its output limit" is a claim this page
   * gives no evidence for, so it is never made: an unexplained stop stays unknown.
   */
  function endOutcome(turn) {
    if (userStopped) return { outcome: 'stopped' };
    if (turn && CLF_DOM.interrupted(turn)) {
      return { outcome: 'interrupted', detail: 'ChatGPT marked the turn interrupted' };
    }
    const errors = CLF_DOM.errors().filter((text) => !seenErrors.has(text));
    if (errors.length > 0) return { outcome: 'failed', detail: errors[0] };
    if (lastAssistantText().length > 0) return { outcome: 'completed' };
    if (turnStartedAt > 0 && Date.now() - lastChangeAt > STALL_MS) {
      return { outcome: 'stalled', detail: 'no visible output and no progress for ten minutes' };
    }
    return { outcome: 'unknown' };
  }

  function observe() {
    const id = CLF_DOM.conversationId();
    if (id !== conversationId) {
      if (conversationId) {
        // A genuine move to another chat: close the old one out and start clean.
        void ask({ type: 'closed', conversationId });
        conversationId = id;
        resetConversation();
      } else {
        // The same chat has just learned its own id — ChatGPT assigns one only once the
        // first turn is under way. This is not a new conversation, so turn state stays,
        // and the worker renames the observations it already journalled under this tab.
        conversationId = id;
        void bindConversation(id);
      }
    }

    const turn = currentAssistantTurn();
    const nowGenerating = CLF_DOM.generating();

    if (nowGenerating && !generating) {
      generating = true;
      userStopped = false;
      stallReported = false;
      turnId = turn ? turn.id : null;
      turnStartedAt = Date.now();
      lastChangeAt = Date.now();
      lastProgress = '';
      emit({ kind: 'turn_start', turnId: turnId || undefined });
    }

    // Progress lines are only meaningful while they are moving. Captured live they
    // give the one thing a page reloaded from history can never reconstruct: the
    // order things happened in.
    if (turn) CLF_DOM.markProgress(turn);

    if (nowGenerating && turn) {
      const line = CLF_DOM.progressLine(turn);
      if (line && line !== lastProgress) {
        lastProgress = line;
        lastChangeAt = Date.now();
        emit({ kind: 'progress', text: line, turnId: turn.id || undefined });
        const key = turn.id || 'current';
        const list = progressByTurn.get(key) || [];
        list.push({ time: Date.now(), text: line });
        if (list.length > 300) list.shift();
        progressByTurn.set(key, list);
      }
      if (!stallReported && Date.now() - lastChangeAt > STALL_MS) {
        stallReported = true;
        emit({
          kind: 'progress',
          text: 'No visible progress for ten minutes. The turn is still marked as generating.',
          turnId: turn.id || undefined
        });
      }
    }

    if (!nowGenerating && generating) {
      generating = false;
      const result = endOutcome(turn);
      emit({ kind: 'turn_end', turnId: turnId || undefined, ...result });
      turnStartedAt = 0;
    }

    for (const message of CLF_DOM.messages()) {
      if (!message.id || !message.text) continue;
      if (seenMessages.has(message.id)) continue;
      if (message.role === 'user') {
        seenMessages.add(message.id);
        emit({
          kind: 'user_message',
          text: message.text,
          messageId: message.id,
          turnId: message.turnId || undefined
        });
      } else if (message.role === 'assistant' && !nowGenerating) {
        // Held until the turn is over so a half-written answer is never stored as
        // the answer. The app keeps user messages whole; assistant text it caps.
        seenMessages.add(message.id);
        emit({
          kind: 'assistant_message',
          text: message.text,
          messageId: message.id,
          turnId: message.turnId || undefined,
          final: true
        });
      }
    }

    for (const error of CLF_DOM.errors()) {
      if (seenErrors.has(error)) continue;
      seenErrors.add(error);
      emit({ kind: 'chat_error', text: error });
    }

    void flush();
  }

  // ------------------------------------------------------------ relabelling

  const TOOL_GLYPHS = {
    edit: '✎',
    create: '+',
    delete: '×',
    move: '↗',
    read: '◉',
    search: '⌕',
    browse: '▱',
    run: '›_',
    process: '›_',
    screen: '▣',
    input: '↖',
    clipboard: '▤',
    session: '◷',
    agent: '◆',
    other: '◇'
  };

  function glyph(kind) {
    return TOOL_GLYPHS[kind] || TOOL_GLYPHS.other;
  }

  function labelText(entry) {
    return entry.summary.detail ? `${entry.summary.title} · ${entry.summary.detail}` : entry.summary.title;
  }

  /**
   * Turns ChatGPT's generic tool header into the same semantic shape as the app:
   * icon + strong title + secondary input/detail + result metric. The app remains the
   * source of truth for the words; this page code only lays out the summary it receives.
   */
  function applyLabel(block, entry) {
    const label = CLF_DOM.toolLabel(block);
    if (!label) return;
    const metric = block.querySelector('.clf-metric');
    const detail = block.querySelector('.clf-tool-detail');
    const icon = block.querySelector('.clf-tool-icon');
    const wantedDetail = entry.summary.detail || '';
    const metricOk = Boolean(entry.summary.metric) === Boolean(metric) &&
      (!entry.summary.metric || metric.textContent === entry.summary.metric);
    const detailOk = Boolean(wantedDetail) === Boolean(detail) && (!wantedDetail || detail.textContent === wantedDetail);
    const iconOk = icon && icon.textContent === glyph(entry.summary.kind);
    if (
      block.dataset.clfCall === entry.callId &&
      label.textContent === entry.summary.title &&
      metricOk &&
      detailOk &&
      iconOk
    ) return;

    if (!block.dataset.clfOriginal) block.dataset.clfOriginal = label.textContent || '';
    block.dataset.clfCall = entry.callId;
    block.dataset.clfKind = entry.summary.kind || 'other';
    label.textContent = entry.summary.title;
    label.classList.add('clf-tool-title');
    label.title = `${entry.tool} — ${entry.outcome}${
      entry.durationMs ? ` in ${Math.round(entry.durationMs)} ms` : ''
    }\nOriginally: ${block.dataset.clfOriginal}`;
    block.classList.remove('clf-good', 'clf-bad', 'clf-warn', 'clf-neutral');
    block.classList.add('clf-tool', `clf-${entry.summary.tone}`);

    const glyphNode = icon || document.createElement('span');
    glyphNode.className = 'clf-tool-icon';
    glyphNode.setAttribute('aria-hidden', 'true');
    glyphNode.textContent = glyph(entry.summary.kind);
    if (!icon && label.parentElement) label.parentElement.insertBefore(glyphNode, label);

    let detailNode = detail;
    if (wantedDetail) {
      detailNode = detailNode || document.createElement('span');
      detailNode.className = 'clf-tool-detail';
      detailNode.textContent = wantedDetail;
      if (!detail) label.insertAdjacentElement('afterend', detailNode);
    } else if (detailNode) {
      detailNode.remove();
      detailNode = null;
    }

    if (entry.summary.metric) {
      const chip = metric || document.createElement('span');
      chip.className = 'clf-metric';
      chip.textContent = entry.summary.metric;
      if (!metric) (detailNode || label).insertAdjacentElement('afterend', chip);
    } else if (metric) {
      metric.remove();
    }
  }

  function timelineRows(turn, calls) {
    const progress = progressByTurn.get(turn.id || 'current') || [];
    const rows = [
      ...progress.map((item) => ({
        time: item.time,
        text: item.text,
        metric: '',
        tone: 'progress',
        kind: 'progress',
        type: 'progress'
      })),
      ...calls.map((call) => ({
        time: call.time,
        text: labelText(call),
        metric: call.summary.metric || '',
        tone: call.summary.tone,
        kind: call.summary.kind || 'other',
        type: 'tool'
      }))
    ];
    rows.sort((a, b) => a.time - b.time);
    return rows;
  }

  /**
   * Our own chronological view of the turn, folded away under the tool blocks.
   *
   * ChatGPT renders every tool block after the whole reasoning stack, so its own order
   * cannot show what happened between two tool calls. This can — but only for a turn
   * this tab watched live, which is why it is an addition rather than a replacement.
   */
  function injectTimeline(turn, calls) {
    const blocks = CLF_DOM.toolBlocks(turn);
    const holder = blocks.length > 0 ? blocks[blocks.length - 1].parentElement : null;
    if (!holder) return;
    const rows = timelineRows(turn, calls);
    const signature = `${rows.length}:${rows.length > 0 ? rows[rows.length - 1].time : 0}`;

    let box = holder.querySelector(':scope > .clf-timeline');
    if (box && box.dataset.clfSignature === signature) return;
    if (!box) {
      box = document.createElement('details');
      box.className = 'clf-timeline';
      box.open = true;
      const head = document.createElement('summary');
      head.textContent = 'Local timeline';
      box.append(head);
      const body = document.createElement('div');
      body.className = 'clf-timeline-body';
      box.append(body);
      holder.append(box);
    }
    box.dataset.clfSignature = signature;
    box.querySelector('summary').textContent = `Local timeline — ${rows.length} step${
      rows.length === 1 ? '' : 's'
    }`;

    const body = box.querySelector('.clf-timeline-body');
    body.replaceChildren(
      ...rows.map((row) => {
        const line = document.createElement('div');
        line.className = `clf-row clf-${row.tone} clf-${row.type}`;
        const time = document.createElement('span');
        time.className = 'clf-time';
        time.textContent = new Date(row.time).toLocaleTimeString();
        const rowIcon = document.createElement('span');
        rowIcon.className = 'clf-row-icon';
        rowIcon.setAttribute('aria-hidden', 'true');
        rowIcon.textContent = row.type === 'progress' ? '·' : glyph(row.kind);
        const label = document.createElement('span');
        label.className = 'clf-label';
        label.textContent = row.text;
        line.append(time, rowIcon, label);
        if (row.metric) {
          const metric = document.createElement('span');
          metric.className = 'clf-metric';
          metric.textContent = row.metric;
          line.append(metric);
        }
        return line;
      })
    );
  }

  function paint() {
    if (entries.length === 0) return;
    const byTurn = new Map();
    for (const entry of entries) {
      // No turn, or a call the app itself could not attribute confidently: leave it
      // out entirely rather than guessing which block it belongs to.
      if (!entry.turnId || entry.attribution === 'inferred') continue;
      const list = byTurn.get(entry.turnId) || [];
      list.push(entry);
      byTurn.set(entry.turnId, list);
    }
    for (const turn of CLF_DOM.turns()) {
      if (turn.role !== 'assistant' || !turn.id) continue;
      const calls = byTurn.get(turn.id);
      if (!calls || calls.length === 0) continue;
      const blocks = CLF_DOM.toolBlocks(turn);
      // One block per recorded call, or no relabelling at all. A partial match would
      // put the wrong summary on a real tool call, which is worse than showing none.
      if (blocks.length !== calls.length) continue;
      blocks.forEach((block, index) => applyLabel(block, calls[index]));
      try {
        injectTimeline(turn, calls);
      } catch {
        // The page owns this DOM; if it will not take our node, do without it.
      }
    }
  }

  async function pullActivity() {
    if (!conversationId || !status.paired) return;
    const reply = await ask({ type: 'activity', conversationId, since });
    if (!reply || reply.ok !== true || !reply.data) return;
    const fresh = Array.isArray(reply.data.entries) ? reply.data.entries : [];
    if (fresh.length > 0) {
      entries = entries.concat(fresh);
      if (entries.length > 2000) entries.splice(0, entries.length - 2000);
      since = fresh[fresh.length - 1].seq;
    }
    paint();
  }

  // -------------------------------------------------------------- commands

  async function checkStatus() {
    const reply = await ask({ type: 'status' });
    if (reply) status = { connected: reply.connected === true, paired: reply.paired === true };
  }

  async function pollCommands() {
    if (!status.paired) return;
    await ask({ type: 'poll' });
  }

  /**
   * Adds one Local Files action to ChatGPT's own + submenu instead of another floating
   * control beside the composer. We clone the menu's first row only for its current
   * spacing/classes; no ChatGPT listener or id is copied, and the action itself is ours.
   */
  function injectCompactMenu() {
    if (!conversationId || !status.paired || compactBusy) return;
    const plus = document.querySelector('[data-testid="composer-plus-btn"][aria-expanded="true"]');
    if (!plus) return;
    const menus = [...document.querySelectorAll('[role="menu"][data-state="open"], [role="menu"]')].filter(
      (node) => node.querySelector('[role="menuitem"]')
    );
    const menu = menus[menus.length - 1];
    if (!menu || menu.querySelector('[data-clf-compact-menu]')) return;
    const template = menu.querySelector('[role="menuitem"]');
    if (!template || !template.parentElement) return;

    const item = template.cloneNode(true);
    if (!(item instanceof HTMLElement)) return;
    item.dataset.clfCompactMenu = '1';
    item.removeAttribute('id');
    item.removeAttribute('data-testid');
    item.removeAttribute('data-radix-collection-item');
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
    for (const child of item.querySelectorAll('[id], [data-testid], [data-radix-collection-item]')) {
      child.removeAttribute('id');
      child.removeAttribute('data-testid');
      child.removeAttribute('data-radix-collection-item');
    }

    const leaves = [...item.querySelectorAll('*')].filter(
      (node) => node.children.length === 0 && (node.textContent || '').trim().length > 0
    );
    const label = leaves[0] || item;
    label.textContent = 'Compact & continue';
    const trailing = [...item.children].find((node) => String(node.className).includes('trailing'));
    trailing?.remove();
    const iconBox = item.querySelector('svg')?.parentElement;
    if (iconBox) {
      iconBox.replaceChildren(document.createTextNode('↻'));
      iconBox.classList.add('clf-compact-icon');
    }

    const activate = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (compactBusy) return;
      compactBusy = true;
      label.textContent = 'Starting compaction…';
      const reply = await ask({ type: 'compact', conversationId, resume: true });
      if (reply && reply.ok === true) {
        label.textContent = 'Compaction started';
      } else {
        label.textContent = 'Compaction failed — open Local Files';
      }
      // The bridge only acknowledges that compaction started; the long request runs in
      // the app. Release the local click guard so a provider failure can be retried by
      // reopening the menu instead of requiring a page reload. A still-running job is
      // rejected by /compact with 409, so this cannot start two at once.
      setTimeout(() => {
        compactBusy = false;
      }, 1500);
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') void activate(event);
    });
    template.parentElement.append(item);
  }

  /**
   * Picks up a "continue in a fresh chat" instruction, if this tab is the fresh chat.
   *
   * Only ever runs on a conversation that does not exist yet and whose composer is
   * empty, so it cannot overwrite anything the user was writing.
   *
   * Every exit reports its outcome. The app holds the command under a lease rather than
   * deleting it when it is handed out, so a composer that never appears, an insertion
   * ChatGPT refuses, or a tab the user closes mid-way all end with the command going
   * back on the queue instead of a worker chat that never opens. Only a message this
   * tab actually sent is reported as sent — including when the conversation id never
   * turns up, because retrying then would type the same instruction a second time.
   */
  async function maybeBootstrap() {
    if (bootstrapTried || CLF_DOM.conversationId()) return;
    bootstrapTried = true;
    const reply = await ask({ type: 'bootstrap' });
    const boot = reply && reply.bootstrap;
    if (!boot) return;

    const fail = (why) => ask({ type: 'ack', id: boot.id, status: 'failed', error: why });

    // ChatGPT paints the composer before the app has fully hydrated. Touching it during
    // that window can look successful for a frame and then React replaces the subtree,
    // which is exactly how we ended up with a blank worker tab holding a live lease.
    // Require four consecutive ready samples before inserting anything.
    let stable = 0;
    for (let tries = 0; tries < 80 && stable < 4; tries++) {
      const composer = CLF_DOM.composer();
      const ready = document.readyState === 'complete' && composer && composer.isConnected;
      stable = ready ? stable + 1 : 0;
      if (stable < 4) await sleep(250);
    }
    if (stable < 4) return void (await fail('ChatGPT never became stably ready for bootstrap'));
    if (!CLF_DOM.insertPrompt(boot.text)) return void (await fail('ChatGPT refused the inserted text'));
    await sleep(500);
    const composer = CLF_DOM.composer();
    if (!composer || !(composer.textContent || '').includes(boot.text.slice(0, 80))) {
      return void (await fail('ChatGPT replaced the composer while inserting the bootstrap'));
    }
    if (!CLF_DOM.send()) return void (await fail('the send button never became usable'));
    agent = boot.agent || null;

    // The conversation id only exists once ChatGPT has accepted the message; the app
    // needs it to tie this chat to the handoff (and to an agent, in multi-agent mode).
    // The lease is renewed while waiting so a slow first response is not mistaken for a
    // dead tab, but the message has been sent either way.
    for (let tries = 0; tries < 80; tries++) {
      await sleep(500);
      const id = CLF_DOM.conversationId();
      if (id) {
        await ask({ type: 'ack', id: boot.id, status: 'sent', conversationId: id, agent });
        return;
      }
      if (tries % 20 === 19) await ask({ type: 'ack', id: boot.id, status: 'working' });
    }
    // Sent, but this tab never saw an id. The app files this chat's activity by the
    // agent it reports with its observations instead.
    await ask({ type: 'ack', id: boot.id, status: 'sent', agent });
  }

  // ----------------------------------------------------------------- start

  document.addEventListener(
    'click',
    (event) => {
      const stop = CLF_DOM.stopButton();
      if (stop && event.target instanceof Node && stop.contains(event.target)) userStopped = true;
      const plus = document.querySelector('[data-testid="composer-plus-btn"]');
      if (plus && event.target instanceof Node && plus.contains(event.target)) {
        setTimeout(injectCompactMenu, 0);
      }
    },
    true
  );

  window.addEventListener('pagehide', () => {
    // Hand over anything still queued before this script stops existing. The worker
    // outlives the page, so this is the last chance for these observations to survive.
    void flush();
    if (conversationId) void ask({ type: 'closed', conversationId });
  });

  function every(ms, fn) {
    const timer = setInterval(() => {
      if (!alive) {
        clearInterval(timer);
        return;
      }
      try {
        const result = fn();
        if (result && typeof result.catch === 'function') result.catch(() => undefined);
      } catch {
        // One bad tick must never stop the loop.
      }
    }, ms);
  }

  void checkStatus().then(() => {
    void maybeBootstrap();
    observe();
    void pullActivity();
  });

  every(OBSERVE_MS, () => {
    observe();
    injectCompactMenu();
  });
  every(ACTIVITY_MS, pullActivity);
  every(STATUS_MS, checkStatus);
  every(COMMAND_MS, pollCommands);
})();
