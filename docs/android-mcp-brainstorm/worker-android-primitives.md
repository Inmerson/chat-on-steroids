# Android primitives: lean computer-use architecture

Status: brainstorm/design only. No product code is implied by this document.

This note maps the current Windows `observe` / `computer` design to Android while preserving the reason those tools work well: a tiny model-facing surface, semantic refs when available, screenshot coordinates when semantics fail, hard staleness checks, one serialized control stream, and truthful failure instead of hidden heuristics.

The target is deliberately **one APK, one connector, computer-use first**. Android is not a desktop with different APIs, so the implementation should preserve capability rather than Windows concepts such as HWND focus, pointer movement, arbitrary keyboard chords, or PowerShell helpers.

## 1. Strong recommendation: modern Android only

Set **`minSdk = 34` (Android 14)** for the first real release.

That is an intentional product boundary, not an implementation accident. It gives the app one clean platform contract:

- `AccessibilityService.takeScreenshotOfWindow(...)` exists, so a requested accessibility window can be captured directly instead of inventing a MediaProjection compatibility path.
- `AccessibilityNodeInfo.getUniqueId()` exists, even though it must not be assumed non-null.
- `PackageManager.getLaunchIntentSenderForPackage(...)` exists, so a known package can be launched without depending on package-visibility queries.
- screenshot failures distinguish secure windows (`ERROR_TAKE_SCREENSHOT_SECURE_WINDOW`).
- modern accessibility/window APIs can be used directly without `Build.VERSION.SDK_INT` branches and AndroidX compatibility wrappers everywhere.

If support for Android 10-13 becomes a real user requirement later, add it as a separate deliberate compatibility project. Do not start v1 with `if API >= X -> preferred path -> MediaProjection -> old screenshot path -> ...` ladders. The entire point of this app is reliability under model control; one deterministic path is worth more than nominal device coverage.

## 2. The Android equivalent of Desktop is one AccessibilityService

The **AccessibilityService is the product runtime**, not merely a helper that the Activity calls.

It owns:

- current accessibility windows and active-window root;
- UI-tree snapshots and opaque node refs;
- screenshot acquisition;
- node actions;
- touch gesture dispatch;
- global Android actions;
- the exclusive computer-use lock;
- MCP request dispatch for phone-control primitives;
- the tunnel connection lifecycle.

The ordinary app Activity owns only setup/status/configuration UI, the Activity timeline, SAF root selection, and explicit repair flows. Closing the Activity must not disconnect ChatGPT or disable phone control.

This follows Android's actual lifecycle rather than fighting it. The system starts/binds an enabled accessibility service after the user explicitly enables it in Accessibility settings; the service lifecycle is system-managed. There should be **no second ordinary background Service, no ForegroundService, no WorkManager keepalive, no alarm resurrection path, and no companion process** for the normal runtime.

Suggested process-level shape:

```text
MainActivity / Compose UI
  ├── Setup + health
  ├── permission/capability toggles
  ├── Activity timeline
  └── SAF root picker

AndroidControlService : AccessibilityService
  └── Runtime
      ├── ControlEngine        // one Mutex, observe/action atomicity
      ├── UiSnapshotter        // windows + flattened nodes + refs
      ├── ScreenCapture        // Accessibility screenshot API
      ├── GestureEngine        // dispatchGesture
      ├── AppLauncher          // package launch IntentSender
      ├── McpServer            // one Android connector
      ├── TunnelRuntime        // one embedded tunnel client
      └── ActivityRecorder     // bounded, user-visible call history

StorageRoots
  └── ContentResolver + persisted SAF tree URIs

SecretStore
  └── Android Keystore AES key -> encrypted app-private config
```

If the OpenAI tunnel client truly requires Go, only `TunnelRuntime` crosses a tiny JNI boundary into an embedded `.so`. Kotlin still owns Android lifecycle and all Android capabilities. The native side does not get a second lifecycle, UI, config store, or permission model.

## 3. AccessibilityService configuration

The service should request exactly the capabilities the product actually uses:

- `android:canRetrieveWindowContent="true"`
- `android:canPerformGestures="true"`
- `android:canTakeScreenshot="true"`
- `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`
- `FLAG_REPORT_VIEW_IDS`

Do **not** request touch exploration, motion interception, key filtering, accessibility overlays, or an accessibility button merely because the APIs exist. They add behavior the product does not need and can interfere with the user's device.

At install/setup level, the important user action is therefore one special system grant: **enable this AccessibilityService**. `INTERNET` is a normal manifest permission with no runtime dialog. Storage access should be SAF grants, not a broad storage runtime permission. No overlay permission is required.

The service must describe itself honestly. This is a remote/model-driven control capability, not a screen reader. Do not set `isAccessibilityTool=true` unless the product actually becomes an accessibility tool under Google's definition.

## 4. Keep the model surface fixed and tiny

The clean Android **control** surface is still two tools:

- `observe` = look without touching;
- `computer` = change phone state.

Because user-selected SAF storage is part of the proposed app scope, the strongest fixed v1 surface is **exactly three tools: `observe`, `computer`, `read`**. `read` is the one file primitive and resolves only inside user-granted SAF roots. Do not port `exec_command`, `write_stdin`, desktop filesystem mutation, or agents into v1.

Advertise those schemas from app start regardless of live toggles or whether a SAF root currently exists. A disabled capability returns `TOOL_DISABLED`; `read` with no configured roots returns a compact setup-needed result. This is simpler than desktop's monotonic exposure machinery because the Android tool list never changes during the app run.

Do **not** add separate MCP tools for screenshot, tap, app launching, UI tree, clipboard, or global actions. Those are operations or workflows over the same control primitives.

Unlike Windows, Android does not need a separate Desktop connector boundary. Phone control is the point of this app, setup simplicity matters more than isolating two schemas from a coding connector, and the target should be one tunnel / one connector unless later measurements show a real discovery problem.

Keep `read` on this same connector. Three small, orthogonal schemas do not justify making the user configure another tunnel/connector. Split only if later no-query measurements prove a real discovery boundary is needed.

## 5. `observe`: Android contract

Recommended shape:

```text
observe(
  what?:        active | windows | window | ui          // default active
  window?:      int                                     // AccessibilityWindowInfo.id
  match?:       string
  screenshot?:  boolean                                 // default true for active/window
  max_width?:   int                                     // default 1080, cap 1440
  max_nodes?:   int                                     // default 60, cap 100
)
```

### `active`

The default call returns:

- active package name;
- active accessibility window id/type/title when available;
- a screenshot of the **default display** as the user actually sees it;
- a bounded flattened list of meaningful UI nodes with refs;
- a monotonically increasing `frameId` for coordinate actions.

Default-display capture matters on Android because the IME, permission sheets, system dialogs, notification shade, and other windows can be visually relevant even when they are not descendants of the app's active root.

### `windows`

Return the current `AccessibilityWindowInfo` set, bounded and compact: id, type, package/title when available, bounds, active/focused state, and layer. This is Android's useful analogue of `list_windows`; it is mainly for dialogs, IME/system surfaces, split-screen, and diagnosing why the visible screen does not match the expected app root.

### `window`

Return one accessibility window's metadata + nodes. With `screenshot=true`, use **`takeScreenshotOfWindow(windowId, ...)` directly**. No MediaProjection fallback. If Android reports secure content, return a specific readable failure and still return any accessibility-tree metadata that the platform legitimately exposes.

### `ui`

Return nodes only, optionally filtered by `match`. `match` searches the already-exposed fields: text, content description, role, view id, and package. Do not implement fuzzy OCR or image matching behind this operation.

## 6. UI-tree representation: flattened, semantic, bounded

Never return the raw recursive `AccessibilityNodeInfo` tree. It is huge, repetitive, and unstable.

Depth-first traverse the requested window and keep only nodes that carry model-relevant signal: visible text/content description, a useful role/state, or one of the supported actions. Flatten to at most 60 by default / 100 hard max.

Suggested result line:

```text
n42_7  button  "Send"  view=com.foo:id/send  bounds=901,2034 101x78  image_center=951,2073  actions=click
```

Useful fields only:

- opaque `ref`;
- normalized role (`button`, `input`, `text`, `checkbox`, `switch`, `image`, `list`, `item`, `tab`, `other`);
- text and/or content description, truncated;
- `viewIdResourceName` when present;
- package/window id;
- bounds in screen coordinates;
- center mapped into the returned screenshot when fully inside its frame;
- concise states such as checked/selected/enabled/focused/editable/scrollable;
- only supported actions relevant to this tool surface.

Password nodes and nodes marked accessibility-data-sensitive on modern Android must not have their text echoed into tool output or the Activity recorder. Report a redaction marker and metadata only.

Custom Canvas/SurfaceView/game UIs may expose almost no useful nodes. That is expected. The screenshot/gesture path is the parallel primitive, not a failure requiring OCR, Shizuku, ADB, root, or vendor automation fallbacks.

## 7. Node refs: opaque, short-lived, and deliberately strict

Do not hand the model Android object identities, `hashCode()`, raw `uniqueId`, or a serialized node.

Each tree observation starts a **new ref generation**, drops the previous generation, and mints refs such as `n42_7` only for nodes actually returned to the model. The registry stores the **actual `AccessibilityNodeInfo` handle from that observation**, plus a conservative identity snapshot:

```text
NodeHandle {
  node: AccessibilityNodeInfo
  generation
  windowId
  packageName
  uniqueId?          // validation only, nullable
  viewId?
  className
  normalizedLabel?
  bounds
}
```

At action time:

1. require the ref to belong to the current observation generation;
2. call `refresh()` on that **same node handle**;
3. if `refresh()` returns false, return `STALE_REF`;
4. require window id and package to be unchanged;
5. require captured identity fields to remain compatible: non-null `uniqueId` must match, and view id/class/bounds plus an available normalized label must not indicate that a recycled view now represents another target;
6. only then call the requested `performAction()` on that exact refreshed node.

This is intentionally stricter than re-resolving a child path or selector against a new tree. Tree indexes can shift when a sibling appears, RecyclerView cells can be reused for different items, and labels/view IDs are not unique enough to serve as runtime identities. Holding the source node and refreshing it gives Android one chance to prove that exact source still exists. If it cannot, the model observes again.

There is **no selector engine and no fallback resolver**: no child-path replay, no search by view id, no label match, no nearest bounds, no fallback tap. The stored fields above validate one handle; they never locate a replacement handle.

`AccessibilityNodeInfo.getUniqueId()` is useful validation when present but is nullable, so it must never become an alternate resolution path. With a hard result cap of 100 nodes, the registry needs at most that current generation, not a 1,000-ref historical cache. Clear it on the next tree observation and whenever the accessibility service reconnects.

## 8. Screenshot frames and coordinates

Preserve the strongest invariant from the Windows implementation: screenshot coordinates belong to one named frame.

Each screenshot creates:

```text
Frame {
  id
  displayId/windowId
  sourceWidth/sourceHeight
  returnedWidth/returnedHeight
  scaleX/scaleY
  orientation
}
```

Downscale before encoding. Default `max_width=1080`, hard cap around 1440. PNG is a good v1 choice for text/UI fidelity and deterministic output; there is no need for a codec matrix.

Every coordinate action in `computer` must include the `frameId` it came from. **Make this required for coordinate actions**, not merely recommended. Reject if:

- a newer screenshot replaced the current frame;
- display metrics/orientation changed;
- the frame belongs to another display/window context than the operation expects.

Return `STALE_FRAME`, not a best-effort tap.

Physical gesture coordinates are derived by scaling the returned image coordinates back into the screenshot's source display coordinate space. `GestureDescription` itself uses screen pixels, so there is no Windows-style DPI helper process.

`observe` snapshotting and `computer` action/capture must share one process-wide `Mutex`. The mutex covers the **whole acquisition or whole action batch**, not just individual API calls. A second ChatGPT conversation must never be able to replace the active frame between action and verification capture.

## 9. `computer`: touch-native action vocabulary

Do not mechanically port mouse/keyboard actions that Android cannot honestly provide.

Recommended action variants:

```text
click_ref(ref)
long_click_ref(ref)
set_value(ref, text)
scroll_ref(ref, direction=forward|backward)
ime_enter_ref(ref)

tap(x, y)
double_tap(x, y)
gesture(path[1..32], duration_ms)   // one point = hold; 2+ = swipe/drag

global(action=back|home|recents|notifications|quick_settings)
wait(ms)
```

Batch 1..20 actions, as on Windows. Keep `captureAfter` so a coherent action+verification screenshot can happen under the same mutex.

### Semantic ref actions

These call exactly the matching action exposed by the freshly resolved node:

- `click_ref` -> `ACTION_CLICK`
- `long_click_ref` -> `ACTION_LONG_CLICK`
- `set_value` -> `ACTION_SET_TEXT`
- `scroll_ref` -> `ACTION_SCROLL_FORWARD` / `ACTION_SCROLL_BACKWARD`
- `ime_enter_ref` -> `AccessibilityAction.ACTION_IME_ENTER`

If the node does not expose the requested action or `performAction()` returns false, fail that action. **Do not silently convert failed `ACTION_CLICK` into a center-screen tap.** Android's own docs show gesture tapping as a possible accessibility fallback, but this product should make that fallback explicit: the model already has `image_center` and can choose a coordinate `tap` in its next action.

This keeps the audit trail honest and prevents semantic actions from turning into unexpected physical touches.

### Coordinate actions

`tap`, `double_tap`, and `gesture` use `dispatchGesture()` only. A one-point gesture with duration is the explicit long-press primitive; a multi-point path is swipe/drag. Do not add `move`, because there is no pointer state worth exposing on a touchscreen.

### Global actions

Use `performGlobalAction()` and only expose the small set that is broadly useful for phone navigation. `getSystemActions()` can be checked before execution and an unavailable action should fail cleanly.

Do not expose lock-screen, power-dialog, animation-scale, accessibility-shortcut, or other system actions in v1 just because constants exist.

### No fake `keypress`

AccessibilityService cannot honestly reproduce arbitrary desktop key chords. Omit `keypress` rather than creating a partial mapping that works for Enter/Back and lies for Ctrl shortcuts. Text entry is `set_value`; editor submission is `ime_enter_ref`; system navigation is `global`; inaccessible soft keyboards remain visible UI that can be tapped if absolutely necessary.

## 10. Launching apps

Do **not** expose `launch_app(package)` in v1 and do not add `observe(what=apps)` merely to feed it.

The apparently cleaner package-Intent path has a bad property for this product: Android background-activity-launch rules can make a service-originated launch dependent on OS state. A primitive that sometimes launches directly and sometimes needs a second mechanism violates the no-fallback design.

Treat app launch as a **workflow over ordinary computer use** instead:

```text
computer(global=home)
observe()                    // launcher screenshot + semantic nodes
computer(click_ref=<app>)    // or explicit launcher UI gestures/search
```

If the launcher exposes an "all apps" control or search field, it is just another ref. If the model needs to swipe up to the app drawer, that is the existing explicit gesture primitive. The Android launcher itself handles the eventual foreground app start, so the connector does not need package visibility, `QUERY_ALL_PACKAGES`, an intent catalog, an overlay permission, or a BAL workaround.

This is not a hidden compatibility fallback. It is one visible, inspectable control path using the same primitives as every other phone interaction.

## 11. Clipboard: deliberately asymmetric on Android

The Windows surface's `read_clipboard` cannot be ported honestly.

Since Android 10, reading the global clipboard is restricted unless the caller is the **currently focused app or the default IME**. A background AccessibilityService therefore cannot promise `ClipboardManager.getPrimaryClip()` will return the user's clipboard. There is no ordinary permission that restores the old semantics.

Design decision for v1: **do not expose `read_clipboard` at all.**

Clipboard writing is technically available through `setPrimaryClip()`, but it is not needed for the clean primary text path (`ACTION_SET_TEXT`) and modern Android intentionally makes clipboard operations user-visible. Leave `write_clipboard` out of v1 too unless a real app compatibility case proves it necessary.

Most importantly, do not turn the app into a custom IME purely to recover clipboard read or text injection. That would add a second special user setup step, a second sensitive capability, and a second lifecycle for one workaround.

## 12. Storage: SAF roots, not filesystem cosplay

If/when the Android connector exposes files, the Android equivalent of approved filesystem roots is the **Storage Access Framework**.

Setup UI:

1. user taps `Add folder`;
2. launch `ACTION_OPEN_DOCUMENT_TREE`;
3. user selects a tree in the system picker;
4. call `takePersistableUriPermission()` with the granted read/write flags;
5. save the tree URI plus a user-facing root label in app-private config.

The model sees virtual roots such as `/Phone/Documents`, never `content://...` URIs. All path operations resolve through `DocumentsContract` / `ContentResolver` underneath the granted tree.

Important constraints are part of the contract, not edge-case fallbacks:

- the grant covers only the selected tree;
- providers differ in supported mutation operations;
- a moved/deleted document can invalidate a persisted URI;
- Android 11+ prevents tree grants for storage roots, `Download`, `Android/data`, and `Android/obb` in the relevant picker flows;
- remote document providers may have unknown sizes/latency.

Never request legacy `READ_EXTERNAL_STORAGE`/`WRITE_EXTERNAL_STORAGE` or `MANAGE_EXTERNAL_STORAGE` for the normal design. If the user wants access to another area, they add another SAF root.

Keep SAF entirely outside the AccessibilityService control engine. It shares config/recorder/MCP runtime but not node refs or the computer mutex.

## 13. Background lifecycle and tunnel ownership

The accessibility service is already a long-lived, system-bound service whose lifecycle starts when the user enables it. Use that instead of constructing a parallel keepalive system. **Accessibility enablement is therefore a mandatory setup prerequisite for the connector**, which is appropriate for a computer-use-first product.

### On `onServiceConnected()`

- build the capability snapshot;
- clear old frames/refs;
- start one structured coroutine scope;
- start local MCP handling;
- start/connect the embedded tunnel;
- expose health as `Connecting -> Connected` or a concrete error.

### During service life

- one tunnel connection manager;
- one reconnect algorithm (bounded exponential backoff + jitter) for ordinary network loss;
- no alternative transport chosen after failure;
- network callbacks can trigger immediate retry eligibility, but they do not create another tunnel implementation.

### On service disconnect/destroy

- cancel the service scope;
- close tunnel/socket/native handles;
- fail in-flight MCP control calls with a clear `ACCESSIBILITY_DISCONNECTED`;
- clear frame/ref registries.

`onInterrupt()` is an accessibility feedback callback, not a reason to tear down the connector.

Do not add a separate ForegroundService for the tunnel. Stress-testing that alternative makes it worse, not safer: it creates a second service lifecycle and ownership handoff, adds a permanent notification plus modern foreground-service start/type restrictions, and still does not make Accessibility node/gesture capability exist while the AccessibilityService is disconnected. It also does not solve background Activity launch policy, which is why direct package launching was removed above.

Keep network work off the AccessibilityService main thread in one structured coroutine scope, but let the service own it. If the process/service is reclaimed, the socket dies with it and a later service connection reconstructs the runtime from persisted config and reconnects the **same** tunnel implementation. That is an expected reconnect, not a reason for a second keepalive mechanism.

If a future product requirement says the SAF `read` tool must stay remotely reachable while Accessibility is deliberately disabled, that is a real architecture change and should be designed explicitly. Do not smuggle that requirement in as an FGS fallback in v1.

Likewise, do not add `BOOT_COMPLETED` + alarm + WorkManager resurrection paths preemptively. An enabled AccessibilityService is system-managed across boot. If a vendor-specific lifecycle bug later appears, measure it first and fix the exact problem rather than shipping five competing owners of one tunnel.

The Activity should always render the real state: accessibility enabled/bound, tunnel id configured, tunnel connected, last error, last successful call. Never show "connected" merely because a token exists.

## 14. Secrets and Android Keystore

Android Keystore stores cryptographic keys, not arbitrary config blobs. Use it accordingly.

Recommended design:

- generate one AES-256-GCM key under an app-specific alias in `AndroidKeyStore`;
- `setUserAuthenticationRequired(false)` because the unattended service must reconnect after the Activity is gone and after ordinary process recreation;
- encrypt tunnel token / tunnel id credentials and any future bearer secrets into app-private DataStore/preferences/database records;
- keep non-secret UI settings unencrypted;
- never place secrets in logs, Activity timeline rows, crash strings, MCP results, or JNI command-line arguments;
- pass native tunnel secrets in memory through a narrow JNI call if Go is embedded.

Do not hard-require StrongBox. Android Keystore can be hardware-backed when the device supports it, and the app can report the observed security level diagnostically. Requiring StrongBox and then catching `StrongBoxUnavailableException` to generate a second kind of key is exactly the sort of device compatibility branch this design is trying to avoid.

The threat model should assume that a fully compromised running app process can ask Keystore to use its key. Keystore protects extraction of key material; it is not a sandbox around a compromised app process.

On uninstall/reinstall, the app key is gone. Encrypted config that can no longer decrypt is invalid and setup must be performed again. Do not build cloud escrow for local connector secrets.

## 15. Permissions/capability toggles

Android's system-level Accessibility enablement is coarse, but the app should still retain the current connector's **in-app capability gating** for transparency and least surprise.

Useful app toggles:

- See screen + UI tree
- Control phone
- File roots individually enabled/disabled if SAF is added

The service remains enabled at Android level, but MCP handlers check current app capability state before every operation and return `TOOL_DISABLED` when the user has switched something off.

The MCP schemas themselves are fixed: `observe`, `computer`, and `read` stay advertised for the whole app run. Toggling capability never registers/unregisters tools and never requires connector refresh. That deletes the desktop monotonic-exposure bookkeeping entirely while preserving the important user-visible behavior: a cached tool call gets a clear refusal rather than an unknown-tool transport failure.

## 16. Concurrency and action integrity

Assume multiple ChatGPT conversations/agents can call the same phone simultaneously.

Use one `ControlEngine` mutex for:

- screenshot + node acquisition that must describe the same UI moment;
- every `computer` batch;
- `computer` + `captureAfter` as one indivisible operation.

Do not queue forever. Give queued calls a bounded deadline and return `CONTROL_BUSY` if contention is pathological.

Each action result should state exactly what ran. Stop the batch at the first failed action and report its 1-based index/type/error. Do not continue with later destructive steps after an earlier target failed.

An AccessibilityEvent should invalidate assumptions, not automatically cancel work. The ref resolver/frame checks determine whether a specific later action is still safe.

## 17. Error vocabulary worth standardizing early

Keep errors compact and model-actionable:

```text
ACCESSIBILITY_DISABLED
ACCESSIBILITY_DISCONNECTED
NO_ACTIVE_WINDOW
WINDOW_NOT_FOUND
STALE_REF
UNSUPPORTED_NODE_ACTION
STALE_FRAME
SCREENSHOT_SECURE_WINDOW
SCREENSHOT_RATE_LIMITED
GESTURE_REJECTED
GLOBAL_ACTION_UNAVAILABLE
TOOL_DISABLED
CONTROL_BUSY
```

Avoid generic `SecurityException`/`IllegalStateException` text escaping from the Android layer. Translate known platform failures at the boundary and keep the raw exception in local diagnostics only.

## 18. What **not** to build

For the one-APK clean design, explicitly reject:

- ADB-over-network / wireless debugging automation;
- Shizuku;
- root/su automation;
- UIAutomator test harnesses running beside the app;
- MediaProjection as a screenshot fallback;
- OCR as a hidden fallback for absent accessibility nodes;
- accessibility overlays to fake foreground status;
- a custom IME for clipboard/key injection;
- a permanent ForegroundService merely to keep the tunnel alive;
- vendor-specific accessibility implementations;
- per-app automation adapters;
- multiple tunnel transports selected at runtime;
- a second MCP connector solely for phone control vs app launch.

Those may each solve a narrow edge case, but together they turn a two-primitive control app into an automation framework with conflicting lifecycles and impossible-to-debug behavior.

## 19. Hard risks / limitations

### Google Play policy is a real distribution risk

This is the largest non-code issue. Current Google Play Accessibility API policy allows broad use only under conditions, requires declaration/disclosure/consent for non-accessibility-tool uses, and explicitly says the Accessibility API cannot be requested for an app that **autonomously initiates, plans, and executes actions or decisions**. A ChatGPT-driven phone-control product sits uncomfortably close to that prohibition.

Therefore **do not architect around Play Store approval being guaranteed**. A signed direct APK/private distribution path is compatible with the one-APK product and may be the realistic initial channel. If Play distribution is a hard requirement, resolve policy/product scope before implementation; code cleanliness cannot solve a policy rejection.

### Accessibility trees are incomplete by design

Apps using custom rendering, games, some WebViews, SurfaceView-embedded hierarchies, DRM/video surfaces, and poorly accessible controls can expose little or misleading structure. The screenshot + explicit gesture path is the honest answer. Expect `controls: none useful` to be a normal result.

### Secure windows are intentionally uncapturable

Android 14 exposes a specific secure-window screenshot failure. Return it. Do not route around `FLAG_SECURE` with MediaProjection/root/vendor APIs.

### App launch is subject to background-launch policy

Launching an Activity directly from a background service is an increasingly restricted Android operation. That is why v1 has **no direct app-launch primitive**. Navigate to the launcher with the normal global Home action and open the app through visible launcher UI. Do not accumulate exemptions, overlays, launcher roles, or alternate Intent paths to force a background launch.

### Clipboard read is not a background primitive anymore

Do not advertise a capability the platform intentionally withholds.

### OEM process management can still be ugly

AccessibilityService is the correct Android lifecycle owner, but some vendors are aggressive. Start with the platform contract, record disconnect/rebind evidence, and only then decide whether any vendor-specific mitigation is justified. No speculative battery-optimization onboarding in v1.

## 20. First implementation slice

The narrowest useful vertical slice is:

1. one Activity showing Accessibility enabled/bound state;
2. one AccessibilityService with retrieve-window/gesture/screenshot capabilities;
3. `observe()` -> default-display PNG + active package/window + 60 flattened nodes + refs + frameId;
4. `computer()` -> `click_ref`, `set_value`, `tap`, `gesture`, `global(back/home)`, `wait`, `captureAfter`;
5. one process-wide mutex + strict `STALE_REF` / `STALE_FRAME`;
6. one embedded MCP/tunnel runtime bound to service lifetime;
7. one Activity timeline recording each call/outcome;
8. Keystore-encrypted tunnel secret.

Then add, in order of demonstrated value: windows/window capture, `scroll_ref`, `ime_enter_ref`, remaining global actions, and SAF-backed `read`. Validate app launching as an end-to-end **workflow** (`home -> observe launcher -> click_ref/gesture`) rather than adding a launch primitive. This ordering grows one architecture rather than introducing temporary substitutes.

## Bottom line

The lean Android equivalent is **one modern-Android AccessibilityService acting as the phone-control kernel**. `observe` produces a screenshot plus bounded semantic refs backed by exact refreshable node handles; `computer` consumes those refs or frame-bound touch coordinates under one serialized lock. A single SAF-backed `read` is the only third v1 tool if files ship. Everything Android can do cleanly fits behind that fixed surface. Everything it cannot do cleanly should fail explicitly rather than triggering a compatibility ladder.

That keeps the property the Windows redesign got right: the model has very few primitives, each primitive means exactly one thing, and the implementation never quietly changes control mechanisms underneath the model.

### Platform facts checked 2026-08-19

- Android AccessibilityService lifecycle is system-managed and begins only after the user explicitly enables the service.
- `dispatchGesture()` is available to services declaring `canPerformGestures`; gesture coordinates are screen pixels.
- `takeScreenshot()` is API 30; `takeScreenshotOfWindow()` and the secure-window screenshot error are API 34.
- `performGlobalAction()` supports system navigation such as Back/Home/Recents; availability can be queried with `getSystemActions()`.
- `AccessibilityNodeInfo.performAction()` is the service-side semantic action primitive; `ACTION_SET_TEXT` replaces node text and places the cursor at the end; `ACTION_IME_ENTER` exists for editor submission.
- `AccessibilityNodeInfo.getUniqueId()` is API 33 and may return null.
- Android 10+ restricts clipboard reads to the focused app or default IME.
- `ACTION_OPEN_DOCUMENT_TREE` grants a user-selected directory tree and `takePersistableUriPermission()` preserves the URI grant across reboots, subject to provider/document lifetime.
- Android Keystore key material is non-exportable; hardware-backed security is device-dependent and StrongBox is intentionally not required here.
- direct package Activity launches remain subject to Android background-activity-launch rules, which is why v1 deliberately launches apps through visible launcher UI instead.
- Google Play's current Accessibility API policy is a product/distribution constraint, not merely a manifest declaration issue.
