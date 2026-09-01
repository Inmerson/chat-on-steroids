(() => {
  'use strict';

  const LEASE_KEY = 'agentTabLeases';
  const MAX_CLOSE_ATTEMPTS = 3;
  const MAX_DURABLE_COMMANDS = 400;
  const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

  let leases = {};
  let loaded = false;
  let loading = null;
  let writes = Promise.resolve();
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
        .get(LEASE_KEY)
        .then((stored) => {
          const value = stored?.[LEASE_KEY];
          leases = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
          loaded = true;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  function persist() {
    const snapshot = { ...leases };
    const write = writes.then(() => chrome.storage.session.set({ [LEASE_KEY]: snapshot }));
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

  async function forget(tabId) {
    await load();
    const key = leaseKey(tabId);
    if (!leases[key]) return;
    delete leases[key];
    await persist();
  }

  async function closeDurableLease(tabId) {
    await load();
    const key = leaseKey(tabId);
    const lease = leases[key];
    if (!lease?.handoffDurable || closing.has(tabId)) return false;

    closing.add(tabId);
    try {
      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        try {
          await chrome.tabs.remove(tabId);
          if (leases[key] === lease) {
            delete leases[key];
            await persist();
          }
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

    const lease = existing ?? {
      commandId,
      tabId,
      registeredAt: Date.now(),
      handoffDurable: false
    };
    if (durableCommands.has(commandId)) lease.handoffDurable = true;
    leases[key] = lease;
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
    if (changed) await persist();
    for (const tabId of close) await closeDurableLease(tabId);
  }

  async function recoverDurableLeases() {
    await load();
    const durable = Object.values(leases)
      .filter((lease) => lease && typeof lease === 'object' && lease.handoffDurable === true)
      .map((lease) => lease.tabId)
      .filter((tabId) => Number.isInteger(tabId) && tabId >= 0);
    for (const tabId of durable) await closeDurableLease(tabId);
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
