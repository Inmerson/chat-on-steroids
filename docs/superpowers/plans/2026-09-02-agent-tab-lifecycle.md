# Agent System 3.0 — Ephemeral Agent Tab Lifecycle Plan

**Goal:** Close only system-owned worker bootstrap/revival tabs after the existing command ACK has become durable, while never closing ordinary/user-owned ChatGPT tabs.

**Design slice:** This is intentionally independent from the future Manager/DAG allocator. It consumes the existing worker command marker (`?clf=` / `#clf=`) and the existing durable `commandAckOutbox` written by `background.js`. It does not change provider retry/rate-limit behavior and it does not make worker identity depend on the tab.

## Safety invariants

- A tab is auto-managed only when it proves it was opened for one exact command marker.
- Unknown/unmarked ChatGPT tabs are user-owned by default and are never closed.
- Resume/Prime tabs are not auto-closed by this worker-tab slice.
- A worker tab is eligible to close only after a `status: sent` ACK carrying an agent id is present in the browser-owned durable `commandAckOutbox`.
- The durable lease is marked `handoffDurable` before attempting to close the browser tab.
- Closing failures use bounded retries only; the durable lease remains recoverable if all retries fail.
- Browser/service-worker restart may resume closure of a `handoffDurable` lease, but may not infer ownership for an unknown tab.
- No extra `tabs` permission is required: Chrome's Tabs API is available to extension service workers; host permissions already cover ChatGPT tab URL visibility.

## Files

- Create: `extension/background-entry.js`
- Create: `extension/agent-tab-lifecycle.js`
- Create: `extension/agent-tab-content.js`
- Modify: `extension/manifest.json`
- Create: `test/agent-tab-lifecycle.test.ts`

## Task 1 — RED: system-owned worker tab closes only after durable ACK

Write a service-worker harness that evaluates `extension/agent-tab-lifecycle.js` against fake `chrome.runtime`, `chrome.storage`, and `chrome.tabs` APIs.

Required cases:

1. marker-matched tab registers; durable `commandAckOutbox` change with `{ id, status:'sent', agent:'worker-1' }` closes exactly that tab;
2. unmarked/mismatched tab does not register and is never closed;
3. `status:'failed'` does not close;
4. a resume ACK with no agent id does not close;
5. if `chrome.tabs.remove` fails, lease remains `handoffDurable`; a fresh service-worker instance recovers and closes it with bounded retry.

Run `npm test -- --run test/agent-tab-lifecycle.test.ts` and verify RED because the lifecycle module does not exist.

## Task 2 — GREEN: background lifecycle module

Implement `agent-tab-lifecycle.js` as an isolated IIFE/service-worker module.

Persistent session key: `agentTabLeases`.

Lease shape:

```js
{
  commandId,
  tabId,
  registeredAt,
  handoffDurable
}
```

Register only `agent_tab_register` messages whose `sender.tab.id` exists and whose ChatGPT sender URL contains the same `clf` marker. Persist the lease in `chrome.storage.session`.

Listen to `chrome.storage.onChanged` for `local.commandAckOutbox`. For matching `status:'sent'` + non-empty `agent`, mark the matching lease durable and persist before calling `chrome.tabs.remove(tabId)`.

Retry closure at most three times in one worker lifetime. If all attempts fail, leave the durable lease persisted. On module startup, retry closure for already-durable leases. Remove leases when their tab is gone.

## Task 3 — Content registration + background entry

`agent-tab-content.js` runs before the main recorder. It parses only its own page marker and sends `{type:'agent_tab_register', id}`. With no marker it does nothing.

`background-entry.js` loads the lifecycle module and existing `background.js` as sibling modules. Update the manifest background service worker to `background-entry.js` and add `agent-tab-content.js` before `content.js` in the ChatGPT content-script list.

The lifecycle background module also reinjects `agent-tab-content.js` into matching ChatGPT tabs on extension install/update so an extension reload does not permanently miss a marked tab.

## Verification

Run:

- `npm test -- --run test/agent-tab-lifecycle.test.ts`
- `npm test -- --run test/content-script.test.ts test/bridge.test.ts`
- `npm run typecheck`
- full `npm run verify:ci` through GitHub Actions on Windows/macOS/Linux.

Do not merge the draft PR in this slice.