(() => {
  'use strict';

  const LEASE_KEY = 'agentTabLeases';
  const QUEUE_KEY = 'agentTabLeaseQueue';
  const TELEMETRY_KEY = 'agentTabLeaseTelemetry';
  const MAX_AGENT_TABS = 5;
  const MAX_QUEUE = 400;
  const MAX_CLOSE_ATTEMPTS = 3;
  const MAX_DURABLE_COMMANDS = 400;
  const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

  let leases = {};
  let queue = [];
  let loaded = false;
  let loading = null;
  let writes = Promise.resolve();
  let drainingQueue = null;
  let openingLeaseReservations = 0;
  const closing = new Set();
  /**
   * Worker commands whose irreversible bootstrap `sent` result became durable during this
   * service-worker lifetime. This is transport evidence only, never close eligibility.
   *
   * The ACK can beat marker registration by a few microtasks, so keep the exact bound chat and
   * agent with the command id. A later lease may inherit `bootstrapSent`; it still remains open
   * until the broker-owned content document separately reports `agent_tab_releasable`.
   */
  const bootstrapCommands = new Map();

  function load() {
    if (loaded) return Promise.resolve();
    if (!loading) {
      loading = chrome.storage.session
        .get([LEASE_KEY, QUEUE_KEY])
        .then((stored) => {
          const storedLeases = stored?.[LEASE_KEY];
          const storedQueue = stored?.[QUEUE_KEY];
          leases = {};
          if (storedLeases && typeof storedLeases === 'object' && !Array.isArray(storedLeases)) {
            for (const [key, raw] of Object.entries(storedLeases)) {
              if (
                !raw ||
                typeof raw !== 'object' ||
                !Number.isInteger(raw.tabId) ||
                raw.tabId < 0 ||
                typeof raw.commandId !== 'string' ||
                !raw.commandId
              ) continue;
              leases[key] = {
                commandId: raw.commandId,
                tabId: raw.tabId,
                registeredAt: Number.isFinite(raw.registeredAt) ? raw.registeredAt : Date.now(),
                bootstrapSent: raw.bootstrapSent === true || raw.handoffDurable === true,
                releasable: raw.releasable === true,
                agent: typeof raw.agent === 'string' && raw.agent ? raw.agent : null,
                conversationId: cleanConversationId(raw.conversationId),
                ...(raw.leaseManagerCreated === true ? { leaseManagerCreated: true } : {})
              };
            }
          }
          queue = Array.isArray(storedQueue)
            ? storedQueue
                .filter(
                  (entry) =>
                    entry &&
                    typeof entry === 'object' &&
                    typeof entry.commandId === 'string' &&
                    entry.commandId &&
                    typeof entry.url === 'string' &&
                    markerFrom(entry.url) === entry.commandId
                )
                .slice(-MAX_QUEUE)
                .map((entry) => ({
                  commandId: entry.commandId,
                  url: entry.url,
                  queuedAt: Number.isFinite(entry.queuedAt) ? entry.queuedAt : Date.now()
                }))
            : [];
          loaded = true;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  function persist() {
    const leaseSnapshot = { ...leases };
    const queueSnapshot = queue.map((entry) => ({ ...entry }));
    const telemetrySnapshot = {
      budget: MAX_AGENT_TABS,
      used: liveLeaseCount(),
      queued: queue.length,
      observedAt: Date.now()
    };
    const write = writes.then(() =>
      chrome.storage.session.set({
        [LEASE_KEY]: leaseSnapshot,
        [QUEUE_KEY]: queueSnapshot,
        [TELEMETRY_KEY]: telemetrySnapshot
      })
    );
    writes = write.then(
      () => undefined,
      () => undefined
    );
    return write;
  }

  function markerFrom(urlText) {
    if (typeof urlText !== 'string' || !urlText) return null;
    try {
      const url = new URL(urlText);
      if (!CHATGPT_HOSTS.has(url.hostname)) return null;
      const queryMarker = url.searchParams.get('clf');
      if (queryMarker) return queryMarker;
      const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
      if (!hash) return null;
      return new URLSearchParams(hash).get('clf');
    } catch {
      return null;
    }
  }

  function cleanConversationId(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    return /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
  }

  function conversationFrom(urlText) {
    if (typeof urlText !== 'string' || !urlText) return null;
    try {
      const url = new URL(urlText);
      if (!CHATGPT_HOSTS.has(url.hostname)) return null;
      const match = /^\/c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(url.pathname);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function senderOwnsCommand(sender, commandId) {
    if (typeof commandId !== 'string' || !commandId) return false;
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || tabId < 0) return false;
    return markerFrom(sender?.url) === commandId || markerFrom(sender?.tab?.url) === commandId;
  }

  function leaseKey(tabId) {
    return String(tabId);
  }

  function liveLeaseCount() {
    return Object.values(leases).filter(
      (lease) => lease && typeof lease === 'object' && Number.isInteger(lease.tabId) && lease.tabId >= 0
    ).length;
  }

  function leaseCapacityUsed() {
    return liveLeaseCount() + openingLeaseReservations;
  }

  function queueCommand(commandId, url) {
    if (!commandId || markerFrom(url) !== commandId) return false;
    if (queue.some((entry) => entry.commandId === commandId)) return true;
    queue = [...queue, { commandId, url, queuedAt: Date.now() }].slice(-MAX_QUEUE);
    return true;
  }

  async function drainQueue() {
    await load();
    if (drainingQueue) return drainingQueue;
    const work = (async () => {
      while (queue.length > 0 && leaseCapacityUsed() < MAX_AGENT_TABS) {
        const entry = queue[0];
        if (!entry || markerFrom(entry.url) !== entry.commandId) {
          queue.shift();
          await persist();
          continue;
        }
        let created = null;
        openingLeaseReservations += 1;
        try {
          created = await chrome.tabs.create({ url: entry.url, active: false });
        } catch {
          break;
        } finally {
          openingLeaseReservations -= 1;
        }
        if (!created || !Number.isInteger(created.id) || created.id < 0) break;

        queue = queue.filter((queued) => queued.commandId !== entry.commandId);
        const tabId = created.id;
        const bootstrap = bootstrapCommands.get(entry.commandId) ?? null;
        leases[leaseKey(tabId)] = {
          commandId: entry.commandId,
          tabId,
          registeredAt: Date.now(),
          bootstrapSent: bootstrap !== null,
          releasable: false,
          agent: bootstrap?.agent ?? null,
          conversationId: bootstrap?.conversationId ?? null,
          leaseManagerCreated: true
        };
        await persist();
      }
    })();
    const tracked = work.finally(() => {
      if (drainingQueue === tracked) drainingQueue = null;
    });
    drainingQueue = tracked;
    return tracked;
  }

  async function forget(tabId) {
    await load();
    const key = leaseKey(tabId);
    if (!leases[key]) return;
    delete leases[key];
    await persist();
    await drainQueue();
  }

  /**
   * A lease proves that this extension once owned a tab, not that it owns whatever that numeric
   * tab id shows forever. ChatGPT navigation can turn the same tab into an ordinary user view
   * before the durable ACK arrives. Re-prove the exact command marker immediately before every
   * destructive close attempt. Any missing/changed/unreadable tab fails closed: release the stale
   * lease and leave browser state alone.
   */
  async function stillOwnsLease(lease) {
    try {
      const tab = await chrome.tabs.get(lease.tabId);
      if (!tab || typeof tab.url !== 'string') return false;
      const marker = markerFrom(tab.url);
      if (marker) return marker === lease.commandId;
      if (lease?.bootstrapSent && lease?.conversationId) {
        return conversationFrom(tab.url) === lease.conversationId;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function releaseStaleLease(key, lease, drainAfter = true) {
    if (leases[key] !== lease) return;
    delete leases[key];
    await persist();
    if (drainAfter) await drainQueue();
  }

  async function closeReleasableLease(tabId, drainAfter = true) {
    await load();
    const key = leaseKey(tabId);
    const lease = leases[key];
    if (!lease?.bootstrapSent || !lease?.releasable || closing.has(tabId)) return false;

    closing.add(tabId);
    try {
      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        if (!(await stillOwnsLease(lease))) {
          await releaseStaleLease(key, lease, drainAfter);
          return false;
        }
        try {
          await chrome.tabs.remove(tabId);
          if (leases[key] === lease) {
            delete leases[key];
            await persist();
          }
          if (drainAfter) await drainQueue();
          return true;
        } catch {
          if (attempt + 1 < MAX_CLOSE_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
          }
        }
      }
      return false;
    } finally {
      closing.delete(tabId);
    }
  }

  async function closeOverflowTab(tabId, commandId) {
    for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
      if (!(await stillOwnsLease({ tabId, commandId }))) return false;
      try {
        await chrome.tabs.remove(tabId);
        return true;
      } catch {
        if (attempt + 1 < MAX_CLOSE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }
    return false;
  }

  async function register(message, sender) {
    await load();
    const commandId = typeof message?.id === 'string' ? message.id : '';
    if (!senderOwnsCommand(sender, commandId)) return { ok: false, error: 'unowned_agent_tab' };

    const tabId = sender.tab.id;
    const key = leaseKey(tabId);
    const existing = leases[key];
    if (existing && existing.commandId !== commandId) {
      return { ok: false, error: 'agent_tab_command_mismatch' };
    }

    if (!existing && !bootstrapCommands.has(commandId) && leaseCapacityUsed() >= MAX_AGENT_TABS) {
      const url = typeof sender?.url === 'string' && markerFrom(sender.url) === commandId ? sender.url : sender?.tab?.url;
      if (!queueCommand(commandId, url)) return { ok: false, error: 'agent_tab_queue_rejected' };
      await persist();
      const closed = await closeOverflowTab(tabId, commandId);
      return closed ? { ok: true, queued: true } : { ok: false, error: 'agent_tab_budget_close_failed' };
    }

    const bootstrap = bootstrapCommands.get(commandId) ?? null;
    const lease = existing ?? {
      commandId,
      tabId,
      registeredAt: Date.now(),
      bootstrapSent: false,
      releasable: false,
      agent: null,
      conversationId: null
    };
    if (bootstrap) {
      lease.bootstrapSent = true;
      lease.agent = bootstrap.agent;
      lease.conversationId = bootstrap.conversationId;
    }
    leases[key] = lease;
    queue = queue.filter((entry) => entry.commandId !== commandId);
    await persist();
    return { ok: true };
  }

  function durableWorkerCommands(value) {
    const commands = new Map();
    if (!Array.isArray(value)) return commands;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.status !== 'sent') continue;
      if (typeof entry.agent !== 'string' || !entry.agent) continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      commands.set(entry.id, {
        agent: entry.agent,
        conversationId: cleanConversationId(entry.conversationId)
      });
    }
    return commands;
  }

  function rememberBootstrapCommands(commands) {
    for (const [commandId, bootstrap] of commands) {
      bootstrapCommands.delete(commandId);
      bootstrapCommands.set(commandId, bootstrap);
    }
    while (bootstrapCommands.size > MAX_DURABLE_COMMANDS) {
      const oldest = bootstrapCommands.keys().next().value;
      if (typeof oldest !== 'string') break;
      bootstrapCommands.delete(oldest);
    }
  }

  async function noteDurableAcks(value) {
    const commands = durableWorkerCommands(value);
    if (commands.size === 0) return;
    rememberBootstrapCommands(commands);
    await load();

    const close = [];
    let changed = false;
    for (const lease of Object.values(leases)) {
      if (!lease || typeof lease !== 'object') continue;
      const bootstrap = commands.get(lease.commandId);
      if (!bootstrap) continue;
      if (!lease.bootstrapSent) {
        lease.bootstrapSent = true;
        changed = true;
      }
      if (lease.agent !== bootstrap.agent) {
        lease.agent = bootstrap.agent;
        changed = true;
      }
      if (lease.conversationId !== bootstrap.conversationId) {
        lease.conversationId = bootstrap.conversationId;
        changed = true;
      }
      if (lease.releasable) close.push(lease.tabId);
    }
    const beforeQueue = queue.length;
    queue = queue.filter((entry) => !commands.has(entry.commandId));
    if (queue.length !== beforeQueue) changed = true;
    if (changed) await persist();
    for (const tabId of close) await closeReleasableLease(tabId);
    await drainQueue();
  }

  async function markReleasable(sender) {
    await load();
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: 'unowned_agent_tab' };
    const key = leaseKey(tabId);
    const lease = leases[key];
    if (!lease) return { ok: false, error: 'unowned_agent_tab' };
    if (!(await stillOwnsLease(lease))) {
      await releaseStaleLease(key, lease);
      return { ok: false, error: 'stale_agent_tab' };
    }
    if (!lease.releasable) {
      lease.releasable = true;
      await persist();
    }
    if (lease.bootstrapSent) await closeReleasableLease(tabId);
    return { ok: true, releasable: true };
  }

  async function recoverDurableLeases() {
    await load();
    let changed = false;
    for (const [key, lease] of Object.entries(leases)) {
      if (
        !lease ||
        typeof lease !== 'object' ||
        !Number.isInteger(lease.tabId) ||
        lease.tabId < 0 ||
        typeof lease.commandId !== 'string' ||
        !lease.commandId ||
        !(await stillOwnsLease(lease))
      ) {
        delete leases[key];
        changed = true;
      }
    }
    // Publish one synchronized snapshot on every service-worker start even when recovery found
    // nothing to repair. Without this, a cold browser session with zero agent tabs stays
    // indistinguishable from "telemetry unavailable" until the first worker opens.
    await persist();
    const releasable = Object.values(leases)
      .filter(
        (lease) =>
          lease &&
          typeof lease === 'object' &&
          lease.bootstrapSent === true &&
          lease.releasable === true
      )
      .map((lease) => lease.tabId)
      .filter((tabId) => Number.isInteger(tabId) && tabId >= 0);
    for (const tabId of releasable) await closeReleasableLease(tabId);
    await drainQueue();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'agent_tab_register' && message?.type !== 'agent_tab_releasable') return undefined;
    const operation = message.type === 'agent_tab_register' ? register(message, sender) : markReleasable(sender);
    void operation.then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if ((areaName !== 'local' && areaName !== 'session') || !changes?.commandAckOutbox) return;
    void noteDurableAcks(changes.commandAckOutbox.newValue);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void forget(tabId);
  });

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.tabs
      .query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] })
      .then((tabs) =>
        Promise.all(
          tabs
            .filter((tab) => Number.isInteger(tab.id) && markerFrom(tab.url))
            .map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['agent-tab-content.js'] }))
        )
      )
      .catch(() => undefined);
  });

  void recoverDurableLeases();
})();
