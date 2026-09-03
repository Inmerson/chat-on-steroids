# Control Center Browser Lease Telemetry Design

## Goal

Give Control Center an exact, read-only view of the extension-owned Agent System browser-tab budget: hard budget, currently leased tabs, and queued agent-tab requests. Never infer usage from ordinary ChatGPT tabs or from Core command queues.

## Constraints

- The five-tab budget remains `5` and is enforced only by `extension/agent-tab-lifecycle.js`.
- Unmarked user ChatGPT tabs are never counted as agent usage.
- The browser bridge remains observation/control-plane metadata only; this change adds no filesystem, command, permission, or browser-control capability.
- Telemetry is RAM-only on the app side. Browser-session persistence remains owned by `chrome.storage.session`.
- Control Center must fail closed: missing, malformed, incompatible, or stale telemetry renders as unavailable rather than guessed usage.
- The extension and app bridge protocol move together because the authenticated request metadata shape changes.

## Chosen architecture

Use authenticated bridge request headers rather than a new telemetry POST route.

`agent-tab-lifecycle.js` already owns the authoritative `leases` and `queue` values. Every durable lifecycle persistence writes a normalized browser-session snapshot under `agentTabLeaseTelemetry`:

```text
{
  budget: 5,
  used: <number of marker-proven leases>,
  queued: <number of queued agent commands>,
  observedAt: <Date.now()>
}
```

`background.js` loads that snapshot from `chrome.storage.session`, follows future storage changes, and attaches the bounded integer values to every existing authenticated `call()` request:

```text
x-agent-tab-budget: 5
x-agent-tabs-used: <0..5>
x-agent-tabs-queued: <0..400>
x-agent-tabs-observed-at: <finite integer timestamp>
```

The app's `bridge.ts` parses these headers only after origin, bearer auth, protocol compatibility, and rate-limit checks have succeeded. A valid snapshot updates one RAM-only record with an app-side `receivedAt` timestamp. Invalid or partial telemetry is ignored rather than replacing the last good record.

Control Center reads that bridge-owned record. It reports telemetry as available only when the bridge currently considers the browser present and the snapshot was received within the existing browser-presence window. Otherwise it preserves the current unavailable shape.

## Why headers instead of a new route

1. No extra request stream or retry policy is introduced.
2. Browser presence already depends on regular authenticated bridge traffic, so telemetry freshness naturally follows the same evidence boundary.
3. App restart recovery is automatic: `background.js` reloads the browser-session snapshot and the next normal authenticated request republishes it.
4. The telemetry cannot recursively trigger itself because it rides on calls that already exist.

## Alternatives rejected

### Dedicated `POST /browser/agent-tabs`

Clearer as an isolated endpoint, but it creates another request source, retry path, rate-limit consumer, and service-worker wake pattern for four small integers. It adds complexity without improving authority.

### App reads Chrome storage directly

Rejected. The app has no authority or supported API to read another process's extension storage, and doing so would bypass the authenticated bridge boundary.

### Infer from broker commands or open ChatGPT tabs

Rejected. Command queue state is not tab lease state, and ordinary user ChatGPT tabs must never count against the Agent System lease budget.

## Data validation

The app accepts a telemetry header set only when all fields are valid together:

- `budget === 5`
- `used` integer in `[0, 5]`
- `queued` integer in `[0, 400]`
- `observedAt` finite positive integer not implausibly far in the future

The app records its own `receivedAt = Date.now()` after successful parsing. Control Center freshness is based on `receivedAt`, not on trusting the extension clock.

## Control Center wire shape

`ControlCenterBrowserStatus.status` expands from only `'unavailable'` to:

```text
'available' | 'unavailable'
```

When available:

```text
{
  budget: 5,
  used: number,
  queued: number,
  status: 'available',
  note: null
}
```

When unavailable, the current `used: null`, `queued: null`, explanatory note behavior remains.

## Testing

- `test/agent-tab-budget.test.ts`: lifecycle persistence publishes exact lease/queue telemetry and never counts an unmarked user tab.
- `test/extension.test.ts`: background loads telemetry, tracks storage updates, and sends the headers only from validated snapshot fields.
- `test/bridge.test.ts`: authenticated requests update telemetry; unauthenticated, malformed, partial, or impossible headers do not.
- `test/control-center.test.ts`: fresh bridge telemetry projects to `available`; absent/stale telemetry remains unavailable.
- Existing renderer summary tests verify `used / budget` formatting without introducing control authority.

## Protocol version

Because authenticated bridge request metadata changes, bump `BRIDGE_PROTOCOL` from `8` to `9` in both app and extension declarations/tests. App and extension remain strict about protocol equality.
