(() => {
  'use strict';

  const LEASE_KEY = 'agentTabLeases';
  const QUEUE_KEY = 'agentTabLeaseQueue';
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
   * Worker command ids whose irreversible `sent` result became durable during this service-worker lifetime.
   *
   * `agent-tab-content.js` runs before the main recorder, but its registration request and the later ACK still
   * cross asynchronous extension events. The storage change can therefore win by a few microtasks. Remembering
   * the durable fact closes that race without inferring ownership: a late tab is still eligible only after its
   * own marker has independently proved the exact same command id.
   */
  const durableCommands = new Set();

  function load() {
    if (loaded) return Promise.resolve();
    if (!loading) {
      loading = chrome.storage.session
        .get([LEASE_KEY, QUEUE_KEY])
        .then((stored) => {
          const storedLeases = stored?.[LEASE_KEY];
          const storedQueue = stored?.[QUEUE_KEY];
          leases = storedLeases && typeof storedLeases === 'object' && !Array.isArray(storedLeases) ? { ...storedLeases } : {};
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
    const write = writes.then(() =>
      chrome.storage.session.set({ [LEASE_KEY]: leaseSnapshot, [QUEUE_KEY]: queueSnapshot })
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
          created = await chrome.tabs.create({ url: entry.url });
        } catch {
          break;
        } finally {
          openingLeaseReservations -= 1;
        }
        if (!created || !Number.isInteger(created.id) || created.id < 0) break;

        queue = queue.filter((queued) => queued.commandId !== entry.commandId);
        const tabId = created.id;
        leases[leaseKey(tabId)] = {
          commandId: entry.commandId,
          tabId,
          registeredAt: Date.now(),
          handoffDurable: durableCommands.has(entry.commandId),
          leaseManagerCreated: true
        };
        await persist();
        if (durableCommands.has(entry.commandId)) await closeDurableLease(tabId, false);
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
      return markerFrom(tab?.url) === lease.commandId;
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

  async function closeDurableLease(tabId, drainAfter = true) {
    await load();
    const key = leaseKey(tabId);
    const lease = leases[key];
    if (!lease?.handoffDurable || closing.has(tabId)) return false;

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

    if (!existing && !durableCommands.has(commandId) && leaseCapacityUsed() >= MAX_AGENT_TABS) {
      const url = typeof sender?.url === 'string' && markerFrom(sender.url) === commandId ? sender.url : sender?.tab?.url;
      if (!queueCommand(commandId, url)) return { ok: false, error: 'agent_tab_queue_rejected' };
      await persist();
      const closed = await closeOverflowTab(tabId, commandId);
      return closed ? { ok: true, queued: true } : { ok: false, error: 'agent_tab_budget_close_failed' };
    }

    const lease = existing ?? {
      commandId,
      tabId,
      registeredAt: Date.now(),
      handoffDurable: false
    };
    if (durableCommands.has(commandId)) lease.handoffDurable = true;
    leases[key] = lease;
    queue = queue.filter((entry) => entry.commandId !== commandId);
    await persist();
    if (lease.handoffDurable) await closeDurableLease(tabId);
    return { ok: true };
  }

  function durableWorkerCommandIds(value) {
    const ids = new Set();
    if (!Array.isArray(value)) return ids;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.status !== 'sent') continue;
      if (typeof entry.agent !== 'string' || !entry.agent) continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      ids.add(entry.id);
    }
    return ids;
  }

  function rememberDurableCommands(commandIds) {
    for (const commandId of commandIds) {
      durableCommands.delete(commandId);
      durableCommands.add(commandId);
    }
    while (durableCommands.size > MAX_DURABLE_COMMANDS) {
      const oldest = durableCommands.values().next().value;
      if (typeof oldest !== 'string') break;
      durableCommands.delete(oldest);
    }
  }

  async function noteDurableAcks(value) {
    const commandIds = durableWorkerCommandIds(value);
    if (commandIds.size === 0) return;
    rememberDurableCommands(commandIds);
    await load();

    const close = [];
    let changed = false;
    for (const lease of Object.values(leases)) {
      if (!lease || typeof lease !== 'object') continue;
      if (!commandIds.has(lease.commandId)) continue;
      if (!lease.handoffDurable) {
        lease.handoffDurable = true;
        changed = true;
      }
      close.push(lease.tabId);
    }
    const beforeQueue = queue.length;
    queue = queue.filter((entry) => !commandIds.has(entry.commandId));
    if (queue.length !== beforeQueue) changed = true;
    if (changed) await persist();
    for (const tabId of close) await closeDurableLease(tabId);
    await drainQueue();
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
    if (changed) await persist();
    const durable = Object.values(leases)
      .filter((lease) => lease && typeof lease === 'object' && lease.handoffDurable === true)
      .map((lease) => lease.tabId)
      .filter((tabId) => Number.isInteger(tabId) && tabId >= 0);
    for (const tabId of durable) await closeDurableLease(tabId);
    await drainQueue();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'agent_tab_register') return undefined;
    void register(message, sender).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes?.commandAckOutbox) return;
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
