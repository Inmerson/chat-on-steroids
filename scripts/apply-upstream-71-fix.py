from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return source.replace(old, new, 1)


# ---------------------------------------------------------------- bridge
bridge_path = Path('src/main/bridge.ts')
bridge = bridge_path.read_text(encoding='utf-8')

start = bridge.index('let placementCollector: string | null = null;')
end_marker = '\n// -------------------------------------------------------- exact browser recovery\n'
end = bridge.index(end_marker, start)
old_placement = bridge[start:end]
new_placement = r'''let placementCollector: string | null = null;

interface PlacementOffer {
  id: string;
  conversationId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** Existing Background chats mode uses the companion-owned managed window. */
  background: boolean;
  /** False only for fresh workers placed beside their live prime. */
  active: boolean;
  /** One response consumes the offer, while its fallback timer still outlives the handout. */
  available: boolean;
  timer: NodeJS.Timeout | null;
}

/** One offer per fresh command. Concurrent workers must never evict one another's placement/fallback. */
const placementOffers = new Map<string, PlacementOffer>();
/** Recent /activity polls prove exactly which prime conversations still have a page able to place a tab. */
const placementHomes = new Map<string, number>();
const MAX_PLACEMENT_HOMES = 128;

function notePlacementHome(conversationId: string): void {
  placementHomes.delete(conversationId);
  placementHomes.set(conversationId, Date.now());
  while (placementHomes.size > MAX_PLACEMENT_HOMES) {
    const oldest = placementHomes.keys().next().value as string | undefined;
    if (!oldest) break;
    placementHomes.delete(oldest);
  }
}

function placementHomePolling(conversationId: string): boolean {
  const seenAt = placementHomes.get(conversationId);
  if (seenAt === undefined) return false;
  if (Date.now() - seenAt >= BROWSER_PRESENT_MS) {
    placementHomes.delete(conversationId);
    return false;
  }
  return true;
}

/** Drops one command's offer, or every offer while the bridge itself is resetting. */
function clearPlacementOffer(id?: string): void {
  if (id !== undefined) {
    const offer = placementOffers.get(id);
    if (offer?.timer) clearTimeout(offer.timer);
    placementOffers.delete(id);
    return;
  }
  for (const offer of placementOffers.values()) {
    if (offer.timer) clearTimeout(offer.timer);
  }
  placementOffers.clear();
}

/**
 * Offers a leased fresh chat to the browser that can place it without asking the OS to choose
 * a Chrome instance/window.
 *
 * Compact & Resume keeps its strict in-flight collector: only the page whose capture request
 * created the command may receive that successor. A fresh worker has different evidence: the
 * broker already names its prime, and a recent authenticated /activity poll proves that prime's
 * page is alive now. That memory-only proof deliberately disappears on restart, so a restored
 * worker keeps the old immediate OS-open recovery rather than waiting for a page that may be gone.
 */
function offerPlacement(command: Command): boolean {
  const home = commandHomeConversation(command.spec);
  const worker = command.spec.type === 'worker';
  const backgroundWorker = worker && getConfig().ui.backgroundChats && browserWakeConnected();
  if (worker) {
    if (!backgroundWorker && (!home || !placementHomePolling(home))) return false;
  } else if (!home || home !== placementCollector) {
    return false;
  }

  // Re-entry for one command replaces only that command's stale offer. It can never cancel a
  // sibling worker's fallback, which was the single-global-offer race.
  clearPlacementOffer(command.id);
  const offer: PlacementOffer = {
    id: command.id,
    conversationId: backgroundWorker ? null : home,
    model: worker ? command.spec.model : null,
    reasoningEffort: worker ? command.spec.reasoningEffort : null,
    background: backgroundWorker,
    active: !worker,
    available: true,
    timer: null
  };
  placementOffers.set(command.id, offer);
  offer.timer = setTimeout(() => {
    offer.timer = null;
    if (placementOffers.get(command.id) !== offer) return;
    placementOffers.delete(command.id);
    const stale = commands.find((entry) => entry.id === command.id && entry.owner === null);
    // Resume has no independent redeem retry, so this timer remains its OS fallback. Workers
    // already own exactly one fallback at WORKER_REDEEM_MS; giving this timer a second opener is
    // the duplicate-tab race. Their command deadline clears this offer before reopening once.
    if (stale && !worker) void openFreshChatInBrowser(stale);
  }, BROWSER_PLACEMENT_MS);
  offer.timer.unref?.();
  if (backgroundWorker) wakeBrowserWork();
  logInfo(
    backgroundWorker
      ? `bridge: offering ${specKey(command.spec)} to the browser companion's background window`
      : `bridge: offering ${specKey(command.spec)} to ${home}'s own browser window`
  );
  return true;
}

type BrowserPlacement = {
  id: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  background?: true;
  active?: false;
};

/**
 * The next fresh chat this browser is being asked to place.
 *
 * Handout is one-shot per command, but the command's timer deliberately remains alive until the
 * page redeems or the fallback boundary arrives. Several worker offers may coexist; repeated
 * polls drain them one at a time without one worker destroying another's timer.
 */
function pendingBrowserPlacement(conversationId: string | null): BrowserPlacement | null {
  for (const offer of placementOffers.values()) {
    if (!offer.available || offer.conversationId !== conversationId) continue;
    if (!commands.some((entry) => entry.id === offer.id && entry.owner === null)) {
      clearPlacementOffer(offer.id);
      continue;
    }
    offer.available = false;
    return {
      id: offer.id,
      model: offer.model,
      reasoningEffort: offer.reasoningEffort,
      ...(offer.background ? { background: true as const } : offer.active ? {} : { active: false as const })
    };
  }
  return null;
}
'''
bridge = bridge[:start] + new_placement + bridge[end:]

activity_start = bridge.index("if (route === '/activity') {")
activity_guard = "    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);\n"
guard_at = bridge.index(activity_guard, activity_start)
bridge = bridge[: guard_at + len(activity_guard)] + "    notePlacementHome(id);\n" + bridge[guard_at + len(activity_guard) :]

bridge = replace_once(
    bridge,
    "  if (placementOffer?.id === command.id) clearPlacementOffer();\n",
    "  clearPlacementOffer(command.id);\n",
    'retire placement cleanup'
)

reopen = "async function reopenWorkerChat(command: Command): Promise<void> {\n"
bridge = replace_once(
    bridge,
    reopen,
    reopen + "  // The worker redeem deadline is the single fallback owner. Cancel any still-live\n"
             "  // page-placement timer before the one OS reopen so the two clocks cannot race.\n"
             "  clearPlacementOffer(command.id);\n",
    'worker reopen cleanup'
)

bridge = replace_once(
    bridge,
    "  lastBrowserLaunchAt = 0;\n  clearPlacementOffer();\n  lastSeenAt = null;\n",
    "  lastBrowserLaunchAt = 0;\n  clearPlacementOffer();\n  placementHomes.clear();\n  lastSeenAt = null;\n",
    'bridge reset placement homes'
)

# Direct cancel paths remove the command without retire(), so they must also retire its offer.
bridge = replace_once(
    bridge,
    "  if (queued) {\n    commands = commands.filter((command) => command !== queued);\n    if (queued.timer) clearTimeout(queued.timer);\n",
    "  if (queued) {\n    clearPlacementOffer(queued.id);\n    commands = commands.filter((command) => command !== queued);\n    if (queued.timer) clearTimeout(queued.timer);\n",
    'sync cancel cleanup'
)
bridge = replace_once(
    bridge,
    "  if (queued) {\n    if (queued.timer) clearTimeout(queued.timer);\n    queued.timer = null;\n    try {\n",
    "  if (queued) {\n    clearPlacementOffer(queued.id);\n    if (queued.timer) clearTimeout(queued.timer);\n    queued.timer = null;\n    try {\n",
    'durable cancel cleanup'
)

bridge_path.write_text(bridge, encoding='utf-8')

# -------------------------------------------------------------- extension
ext_path = Path('extension/background.js')
ext = ext_path.read_text(encoding='utf-8')

place_marker = "async function placeSuccessorChat(raw, tabId) {\n"
helper = r'''async function protectPlacedWorkerTab(created) {
  if (!Number.isInteger(created?.id)) return;
  try {
    await chrome.tabs.update(created.id, { autoDiscardable: false });
    discardProtectedTabs[String(created.id)] = true;
    await persistLive();
  } catch {
    // The tab already exists. Discard-policy hardening is best effort after creation; treating
    // this as placement failure would let the app's fallback create a second worker tab.
  }
}

'''
ext = replace_once(ext, place_marker, helper + place_marker, 'worker discard helper')

old_background_protect = r'''    const created = await createChatTab(`https://chatgpt.com/?${query.join('&')}#${marker}`, true);
    if (Number.isInteger(created?.id)) {
      await chrome.tabs.update(created.id, { autoDiscardable: false });
      discardProtectedTabs[String(created.id)] = true;
      await persistLive();
    }
    return;
'''
new_background_protect = r'''    const created = await createChatTab(`https://chatgpt.com/?${query.join('&')}#${marker}`, true);
    await protectPlacedWorkerTab(created);
    return;
'''
ext = replace_once(ext, old_background_protect, new_background_protect, 'managed background protection')

old_same_window = r'''  const create = { url: `https://chatgpt.com/?${query.join('&')}#${marker}`, windowId: home.windowId, active: true };
  // Directly after the chat it continues, so a handoff reads as one piece of work instead of a
  // tab appended to the far end of a long strip.
  if (typeof home.index === 'number') create.index = home.index + 1;
  try {
    await chrome.tabs.create(create);
  } catch {
    // Window teardown or browser policy rejected the create. The app's placement fallback
    // turns that into an ordinary OS open rather than a lost command.
  }
'''
new_same_window = r'''  const create = {
    url: `https://chatgpt.com/?${query.join('&')}#${marker}`,
    windowId: home.windowId,
    // Omitted is the existing Compact & Resume behavior. Only fresh workers carry false.
    active: raw && raw.active === false ? false : true
  };
  // Directly after the chat it continues, so a handoff reads as one piece of work instead of a
  // tab appended to the far end of a long strip.
  if (typeof home.index === 'number') create.index = home.index + 1;
  try {
    const created = await chrome.tabs.create(create);
    if (create.active === false) await protectPlacedWorkerTab(created);
  } catch {
    // Window teardown or browser policy rejected the create. The app's placement fallback
    // turns that into an ordinary OS open rather than a lost command.
  }
'''
ext = replace_once(ext, old_same_window, new_same_window, 'same-window worker placement')
ext_path.write_text(ext, encoding='utf-8')

# -------------------------------------------------------- extension regression
ext_test_path = Path('test/extension.test.ts')
ext_test = ext_test_path.read_text(encoding='utf-8')
ext_sentinel = "opens an inactive worker beside the prime and protects it from auto-discard"
if ext_sentinel not in ext_test:
    marker = "\n  it('leaves a compaction reply that places nothing to the app’s own opener', async () => {\n"
    test = r'''

  it('opens an inactive worker beside the prime and protects it from auto-discard', async () => {
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') {
        return response(200, {
          sessionId: 'prime-session',
          stream: [],
          entries: [],
          nextSince: 0,
          placement: { id: 'cmd-worker', active: false }
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch,
      tabsGet: async () => ({ id: 47, windowId: 9, index: 4 }) as never
    });
    await worker.registerTab(47);
    await worker.send({ type: 'bind', conversationId: CHAT }, 47);

    await worker.send({ type: 'activity', conversationId: CHAT, since: 0 }, 47);

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    const created = worker.tabsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.windowId).toBe(9);
    expect(created.index).toBe(5);
    expect(created.active).toBe(false);
    expect(String(created.url)).toBe('https://chatgpt.com/?clf=cmd-worker#clf=cmd-worker');
    expect(worker.tabsUpdate).toHaveBeenCalledWith(99, { autoDiscardable: false });
    expect(session.data.discardProtectedTabs).toEqual({ '99': true });
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });
'''
    ext_test = replace_once(ext_test, marker, test + marker, 'extension worker placement test insertion')
ext_test_path.write_text(ext_test, encoding='utf-8')
