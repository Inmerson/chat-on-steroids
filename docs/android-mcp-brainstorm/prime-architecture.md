# Android MCP Connector — Target Architecture

Status: design/brainstorm only. Product code has not been modified.

This is the integrated conclusion after reading the current ChatGPT Local Files MCP surface, tool implementations, dispatcher, desktop-control engine, tunnel lifecycle, server, configuration, secrets, diagnostics and the workers' audits. The target deliberately preserves the current connector's *design invariants* rather than porting its Windows implementation.

## 1. Product boundary

The product is an **Android phone-control connector for ChatGPT**, not “ChatGPT Local Files on Android”. Computer/phone use is the headline capability.

V1 is intentionally:

- one signed APK;
- one Android app;
- one ChatGPT connector;
- one Secure MCP Tunnel id;
- one Android AccessibilityService as the phone-control/system lifecycle boundary;
- exactly **two model-facing tools: `observe` and `computer`**;
- one in-app Activity timeline containing every MCP tool call and outcome;
- no companion desktop app, browser extension, separately installed tunnel binary, cloudflared, manual reverse proxy, ADB, Shizuku, root, overlay permission, MediaProjection fallback, custom launcher or provider-specific automations.

Direct file access is a deliberate post-core capability. If real use proves it worthwhile, add a third `read` primitive backed by SAF. Do not make file architecture a prerequisite for shipping excellent phone control.

Target **Android 14 / API 34 minimum** for the first serious build. That gives one modern Accessibility API contract including window screenshots and avoids a compatibility ladder through old screenshot/input behavior. Older Android support should be a later explicit project, not scattered `SDK_INT` branches in v1.

## 2. Why the Windows tools reduce to two

The current connector reduced an older 45-tool surface to primitives because overlapping procedure tools hurt tool selection and retrieval reliability. Android should push that logic harder.

| Current tool | Why it exists on Windows | Android decision |
| --- | --- | --- |
| `observe` | One perception primitive: screenshot + windows + UI refs + wait | **KEEP**, core tool |
| `computer` | One batched interaction primitive | **KEEP**, core tool |
| `read` | Files/directories/images under approved roots | **DEFER to v1.1**, then SAF-backed |
| `find` | Search when arbitrary shell is unavailable | **DEFER with files**, only add after demonstrated need |
| `apply_patch` | Atomic code/text mutation across files | **DELETE from phone-control v1**; wrong primary abstraction for phone files |
| `exec_command` | Full Windows user shell | **DELETE**; normal Android app cannot honestly provide equivalent device shell |
| `write_stdin` | Continuation of real command sessions | **DELETE with exec** |
| `session` | Recover browser-recorded ChatGPT session history | **DELETE model-facing v1**; keep local Activity only |
| `agents` | Browser-extension-bound multi-chat swarm | **DELETE/defer**; no honest Android worker-chat identity/launcher primitive |

There is no Core/Desktop surface split. On Windows desktop automation is optional relative to coding and its schema is heavy, so a second discovery boundary earns its cost. Here phone control is the product. Splitting two tools across multiple connectors would only multiply setup and tunnel ids.

## 3. Runtime shape

```text
                    ChatGPT
                       │
              OpenAI Secure MCP Tunnel
                       │ outbound only
                       ▼
┌──────────────────── ONE ANDROID APK ────────────────────┐
│                                                         │
│  Go AAR: `tunnelbridge`                                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │ official openai/tunnel-client                    │  │
│  │ official MCP Go SDK                              │  │
│  │ one MCP server: observe + computer               │  │
│  │ in-memory MCP transport pair                     │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │ tiny generated Java binding   │
│                         ▼                               │
│  Kotlin `ToolHost`                                      │
│       │                                                 │
│       ▼                                                 │
│  `ToolDispatcher` ── policy gate ── activity recorder   │
│       │                                                 │
│       ▼                                                 │
│  `AndroidControlService : AccessibilityService`         │
│       ├── ObserveEngine                                 │
│       ├── ComputerEngine                                │
│       ├── RefStore                                     │
│       ├── FrameStore                                   │
│       ├── AccessibilityInput                            │
│       └── one Control Mutex                            │
│                                                         │
│  Compose Activity                                       │
│       ├── Home / Setup                                  │
│       ├── Tools                                         │
│       └── Activity                                      │
│                                                         │
│  SettingsStore   CredentialStore   ActivityStore        │
└─────────────────────────────────────────────────────────┘
```

The major simplification versus the desktop connector is **no local HTTP MCP endpoint at all**. OpenAI's current Go library explicitly supports an in-memory MCP transport. The Go runtime therefore needs no bound port, secret URL, Host/Origin validation layer, health HTTP server or child-process supervisor on Android.

## 4. Native boundary

Do not port OpenAI's tunnel protocol to Kotlin. Do not ship a second executable either.

Build a tiny Go package into an Android AAR using `gomobile bind`. Pin the Go toolchain, `openai/tunnel-client`, MCP Go SDK and x/mobile revisions in the build. The generated AAR is an implementation detail bundled into the APK.

Cross-language API should be deliberately boring:

```text
interface ToolHost {
    handle(tool: String, argsJson: String): String
}

TunnelRuntime.start(tunnelId, apiKey, ToolHost)
TunnelRuntime.stop()
TunnelRuntime.isReady()
```

`handle()` is invoked on a non-main native callback thread. Kotlin parses one of two tiny DTO contracts and synchronously waits for the corresponding coroutine operation to complete. The return string is a serialized MCP-style tool result containing bounded text and optional base64 PNG.

Do not expose Android classes, coroutine types, MCP SDK classes, maps of arbitrary objects or configuration objects across the native boundary. Strings + primitive state make the boundary testable and keep Go replaceable.

### Build gate before product implementation

The first technical spike must prove exactly this path on a real Android device:

1. `gomobile bind` can compile the pinned upstream tunnel-client dependency for arm64 Android.
2. Go MCP server + `NewInMemoryTransports()` + embedded tunnel client reach Ready.
3. ChatGPT can list and call one dummy tool through the real Secure Tunnel.
4. A Go interface callback into Kotlin returns a result to that MCP call.
5. Start → Stop → Start in one Android process works cleanly.

If this spike fails, stop and revisit the boundary. Do **not** pre-build a localhost/proxy/stdio fallback beside it “just in case”.

## 5. Android lifecycle

`AndroidControlService : AccessibilityService` is the runtime owner because the user enabling Phone Control is already what gives the app its useful system capability. Android manages this service's lifecycle and binds it only after the user explicitly enables it.

`onServiceConnected()`:

- create one service `CoroutineScope`;
- clear stale refs/frames;
- build/load app policy;
- start the embedded Go MCP+tunnel runtime if credentials exist and auto-connect is on;
- publish typed `StateFlow<ConnectorState>` for Compose.

`onDestroy()` / service disconnect:

- mark control unavailable first;
- cancel service coroutine scope;
- stop Go runtime once;
- fail in-flight phone-control work as `ACCESSIBILITY_DISCONNECTED`;
- clear refs and frames.

No second ForegroundService, WorkManager keepalive, BOOT_COMPLETED resurrection graph or alarm. Android's accessibility service is system-managed. If a vendor later demonstrates a reproducible lifecycle defect, fix that measured defect rather than starting with several competing lifecycle owners.

The embedded tunnel client already owns ordinary control-plane retry behavior. Kotlin should not parse log strings and implement a second retry algorithm around it. Ready means the upstream client has completed a real control-plane poll; terminal runtime failure becomes a visible Error state.

## 6. Accessibility service declaration

Request only what the product uses:

```text
canRetrieveWindowContent = true
canPerformGestures       = true
canTakeScreenshot        = true
FLAG_RETRIEVE_INTERACTIVE_WINDOWS
FLAG_REPORT_VIEW_IDS
FLAG_INPUT_METHOD_EDITOR
```

`FLAG_INPUT_METHOD_EDITOR` is useful because API 33+ gives an accessibility service an `AccessibilityInputConnection`, letting `computer.type` commit text to the currently focused editor without clipboard hacks or a separately installed/default IME.

Do not request touch-exploration mode, key filtering, overlay capability, motion interception or an accessibility button in v1.

`INTERNET` is a normal manifest permission and produces no runtime dialog. The only central user-facing system enablement for phone control is Accessibility access.

## 7. Fixed model-facing surface

The Go MCP server always advertises the same two schemas for the life of the app:

```text
observe
computer
```

This is cleaner than the desktop connector's monotonic-exposure machinery. With two tools there is no benefit in dynamically hiding schemas. The app toggles are **live policy gates**:

- `Observe phone` OFF → `observe` returns `TOOL_DISABLED` immediately.
- `Control phone` OFF → `computer` returns `TOOL_DISABLED` immediately.

No reconnect is necessary merely to disable or re-enable a tool. ChatGPT never holds a stale `tools/list` because the list never changes.

MCP annotations:

- `observe`: readOnly=true, destructive=false, idempotent=true.
- `computer`: readOnly=false, destructive=true, idempotent=false.

## 8. `observe` exact contract

V1 should be smaller than the Windows schema:

```text
observe(
  what?:        active | windows | window | ui   // default active
  window?:      int                              // required for window
  match?:       string                           // ui/windows filter
  screenshot?:  boolean                          // default true for active/window
  max_width?:   int                              // default 1080, max 1440
  max_elements?: int                             // default 60, max 100
)
```

No `apps` mode in v1. App launching from a background service is subject to Android Background Activity Launch restrictions, so an app catalog would invite a direct-launch action the OS may legitimately block. Phone navigation already has one universal route: Home → observe → click the launcher UI.

### Default `observe()` result

One call returns a coherent snapshot under the control mutex:

```text
package: com.example.app
window: 42  application  "Settings"  active focused
frame: f118  1080x2400

r118_1  button  "Network & internet"  bounds=44,320,1036,438  actions=click
r118_2  switch  "Wi‑Fi" checked       bounds=...             actions=click
r118_3  input   "Search settings"     bounds=...             actions=click,set_text
...
```

plus the screenshot as MCP image content when requested.

`active` captures the **default display as the user sees it**, not only one app root, because dialogs, keyboard, system sheets and notification UI can matter.

`window` may use API 34 `takeScreenshotOfWindow(windowId)` for a requested accessibility window.

`windows` returns a compact bounded set of interactive windows: id, type, title/package where available, bounds/layer, active/focused.

`ui` returns nodes only and may filter exposed semantic fields by `match`. No OCR/image matching is hidden under `ui`.

### Node flattening

Do not serialize the raw recursive Android tree. Traverse it deterministically and emit only visible nodes with useful semantics: label/text/content description, useful role/state or a supported action. Bound both the traversal and returned set.

Fields kept per element:

- opaque ref;
- normalized role;
- redacted/truncated text/content description;
- optional view id;
- package + accessibility window id;
- bounds;
- screenshot-relative center when meaningful;
- selected/checked/enabled/focused/editable/scrollable state;
- only the actions the Android node actually exposes and our `computer` surface supports.

Password/sensitive nodes never return their value. Activity history also never stores it.

## 9. Refs: stricter than Windows

Android does not give us a UIA-equivalent runtime key that is always stable. Do not compensate with fuzzy matching.

V1 ref registry should keep the actual `AccessibilityNodeInfo` object from the **latest observation generation only**:

```text
RefEntry {
    generation
    windowId
    packageName
    node: AccessibilityNodeInfo
}
```

At `click_ref` / `set_value` / `scroll_ref` time:

1. ref must belong to the current generation;
2. package/window must still match the expected context;
3. call `node.refresh()`;
4. `refresh()==false` means `STALE_REF`;
5. requested Android accessibility action must still be present;
6. call that exact `performAction` once;
7. false means `UNSUPPORTED_NODE_ACTION`/`ACTION_REJECTED`.

Then stop. **Never** re-find by text, nearest bounds, view id or “similar node”. Never silently turn a failed semantic click into a coordinate tap. The next explicit `observe` creates a new generation and refs.

This is both less code and safer than maintaining locator/fingerprint fallback ladders. `AccessibilityNodeInfo.refresh()` exists specifically to tell us when the represented view is obsolete.

## 10. Frames and coordinate safety

Every screenshot creates one `Frame`:

```text
id
display/window source
source width/height
returned width/height
scaleX/scaleY
orientation
```

Any coordinate-based `computer` action **must include the frame id** it came from. This is mandatory on Android v1, not advisory.

Reject with `STALE_FRAME` when a newer screenshot is active, orientation/dimensions changed or the frame belongs to a different capture context. Never best-effort tap old coordinates.

Downscale once before PNG encoding. One codec, one scaling path. No JPEG/WebP codec selection UI.

## 11. `computer` exact contract

One batched mutation tool, 1..20 actions. V1 action vocabulary:

```text
click_ref(ref)
long_click_ref(ref)
set_value(ref, text)
scroll_ref(ref, direction=forward|backward)

tap(x, y, frame_id)
double_tap(x, y, frame_id)
gesture(points[1..32], duration_ms, frame_id)

type(text)
global(action=back|home|recents|notifications|quick_settings)
wait(ms)
```

Top-level:

```text
computer(actions[1..20], capture_after?: boolean, capture_max_width?: int)
```

No Windows `move`, `drag` as separate concept, `focus(window)`, arbitrary `keypress`, clipboard read/write or direct `launch_app`.

`gesture` is the single explicit coordinate path primitive. One point + duration is a hold/long press; 2+ points express swipe/drag. `double_tap` remains because it is a common atomic touch gesture and clearer than timing two separate taps.

### Semantic actions

- `click_ref` → node `ACTION_CLICK`
- `long_click_ref` → `ACTION_LONG_CLICK`
- `set_value` → `ACTION_SET_TEXT`
- `scroll_ref` → `ACTION_SCROLL_FORWARD/BACKWARD`

Each executes only if the refreshed node advertises/supports it. No fallback.

### Typing

`type(text)` writes only to the currently focused editor through the AccessibilityService InputMethod API (`getCurrentInputConnection().commitText`). If there is no current input connection, fail `NO_TEXT_INPUT`. Do not use the clipboard or simulated key chords as fallback.

`set_value(ref,text)` remains preferred for a known editable ref because it targets a concrete node.

### Global actions

Before calling `performGlobalAction`, check `getSystemActions()` and reject an unavailable action. Keep the exposed set small. No power dialog, lock-screen, animation scaling or accessibility shortcut.

### Batch semantics

The entire batch holds the one Control mutex. Execute sequentially. Stop at the first failure and return:

```text
completed: 0..N-1
failed_action: N
type: click_ref
error: STALE_REF
```

Never continue later destructive actions after an earlier precondition failed.

If `capture_after=true`, capture happens before releasing the same mutex and returns the new frame + image. This preserves the Windows connector's strongest action/verification invariant.

## 12. Concurrency

One process-wide `Mutex` protects phone state operations that depend on one another:

- observe screenshot + UI acquisition;
- every complete computer batch;
- batch + capture_after.

Do not put tunnel networking, Activity DB or future SAF file reads behind this mutex.

Calls wait only up to a fixed control-queue deadline. Excess contention returns `CONTROL_BUSY`. This prevents two ChatGPT conversations from interleaving phone actions while also preventing an abandoned call from blocking control indefinitely.

## 13. Error vocabulary

Standardize these before implementation so UI, Activity and MCP return the same concepts:

```text
TOOL_DISABLED
ACCESSIBILITY_DISABLED
ACCESSIBILITY_DISCONNECTED
NO_ACTIVE_WINDOW
WINDOW_NOT_FOUND
STALE_REF
UNSUPPORTED_NODE_ACTION
ACTION_REJECTED
STALE_FRAME
SCREENSHOT_SECURE_WINDOW
SCREENSHOT_RATE_LIMITED
GESTURE_REJECTED
GLOBAL_ACTION_UNAVAILABLE
NO_TEXT_INPUT
CONTROL_BUSY
INTERNAL_ERROR
```

Known Android exceptions are mapped once at the engine boundary. Raw stack traces remain local diagnostics, never model-facing results.

Secure-window screenshot failure is final. No MediaProjection/root workaround.

## 14. Tool dispatch + policy

One `ToolDispatcher` is the Kotlin equivalent of the useful part of current `mcp/kernel.ts`:

```text
handle(tool, args)
  -> validate/parse DTO
  -> read live PolicyStore
  -> reject if tool disabled
  -> record startedAt
  -> execute tool
  -> bound/sanitize result
  -> record Activity row
  -> return result
```

There is no session/caller/agent/workspace attribution machinery in v1. A tool call is recorded as a tool call, nothing more. Do not guess which ChatGPT conversation made it unless the transport later supplies a stable identity directly.

## 15. App-side Activity timeline

Activity recording is always on because transparency is part of the product, not a debugging option.

Use a tiny Room table:

```text
ToolCallEntity
  id
  startedAt
  durationMs
  tool
  summary
  outcome     OK | REJECTED | ERROR
  argsJson    sanitized + bounded
  resultText  sanitized + bounded
```

Do **not** store screenshot/base64 payloads by default. Store image metadata only (`frameId`, dimensions, bytes). Do not store password/sensitive-node values or the tunnel API key.

Keep a fixed retention policy rather than a settings maze, e.g. latest 1,000 calls / 14 days, whichever is smaller. A detailed row can show exact bounded args/result.

This replaces the need for a model-facing `session` tool in v1.

## 16. Settings and secrets

Keep configuration tiny.

DataStore values:

```text
tunnelId
autoConnect
observeEnabled
computerEnabled
setupCompleted
```

No provider kind, binary path, desktop tunnel id, readOnly master switch, theme engine, compaction, agent config, bridge config or compatibility flags.

Secrets:

- generate one AES-256-GCM key in Android Keystore;
- user authentication not required, because the system service must reconnect unattended;
- encrypt API key in app-private storage;
- UI can replace/clear key and see `hasApiKey`, never read plaintext back;
- no plaintext fallback and no StrongBox requirement/fallback branch.

## 17. Installation and setup UX

Distribution target for the autonomous version is **one signed APK**.

First-run flow should be one linear screen, not a settings dashboard:

```text
1. Enable Phone Control
   [Open Accessibility settings]

2. Connect to ChatGPT
   Tunnel ID  [paste]
   API key    [paste]
   [Connect]

3. Add connector in ChatGPT
   Name: ChatGPT Phone
   Description: [copy]
   [Open ChatGPT connector settings]

4. Test
   "Ask ChatGPT: What's on my phone screen?"
```

When installed outside Google Play, Android 13+ may require the user to open App Info → menu → **Allow restricted settings** before Android lets them enable Accessibility. The app cannot bypass this. Detect the disabled state and show the exact repair instruction only when necessary.

Once configured, `autoConnect=true` means the tunnel starts whenever the enabled AccessibilityService is connected. Closing the UI changes nothing.

Home screen after setup:

```text
Connected
Last tool call: 12s ago

Phone control      enabled
Observe            ON
Computer           ON

Recent activity …
```

Tools screen contains only the two tool cards/toggles and concise action capability details. Activity screen is the chronological ledger.

## 18. Connection state

Keep state honest and smaller than desktop:

```text
AccessibilityOff
MissingCredentials
Starting
Ready(readyAt, lastToolCallAt?)
Error(message)
Stopped
```

Do not recreate the Windows `/readyz` + `/metrics` + `/api/status` parser in Kotlin. The embedded library deliberately disables its health/admin listener and exposes readiness directly. `Ready` is first proven control-plane success; `lastToolCallAt` is the end-to-end product proof.

OS network state may be shown as secondary diagnostics, but it must not be presented as proof that OpenAI is reachable.

## 19. Package layout: feature-first, not framework-first

One Gradle Android app module plus one Go source/build directory. Do not create a module per layer.

```text
phone-mcp/
  app/
    src/main/java/.../
      PhoneApp.kt
      AppGraph.kt

      connector/
        ConnectorRuntime.kt
        ConnectorState.kt
        ToolHost.kt
        ToolDispatcher.kt
        ToolResult.kt

      control/
        AndroidControlService.kt
        ObserveTool.kt
        ComputerTool.kt
        UiSnapshotter.kt
        ScreenCapture.kt
        GestureEngine.kt
        AccessibilityInput.kt
        RefStore.kt
        FrameStore.kt

      data/
        SettingsStore.kt
        CredentialStore.kt
        ActivityDao.kt
        ActivityDatabase.kt

      ui/
        MainActivity.kt
        HomeScreen.kt
        SetupScreen.kt
        ToolsScreen.kt
        ActivityScreen.kt

    src/main/res/xml/accessibility_service_config.xml

  tunnel-go/
    go.mod
    runtime.go
    tools.go
    bridge.go

  build.gradle.kts
  settings.gradle.kts
```

No Hilt/Koin. `PhoneApp` owns a small manual `AppGraph`; the Activity and AccessibilityService obtain the same stores/runtime from it. Interfaces exist only at real seams worth faking in tests, primarily the native tunnel bridge and Android control facade.

Use coroutines + StateFlow + one Mutex. No Rx, generic event bus or repository/use-case class for every function.

## 20. What we intentionally refuse to support in v1

This is part of the architecture, not a backlog accident:

- Android < 14 compatibility branches;
- cloudflared/manual tunnel;
- external tunnel executable;
- local MCP HTTP listener;
- Chrome extension/bridge;
- agent swarms;
- ChatGPT session scraping/compaction;
- shell/terminal/ADB/Shizuku/root;
- direct clipboard read/write;
- MediaProjection screenshot fallback;
- OCR/image matching hidden behind UI refs;
- direct app launch/background-activity exemptions;
- per-app adapters;
- broad storage permission;
- file mutation;
- overlays;
- vendor-specific battery/Accessibility hacks;
- aliases for removed/old tool names.

When Android refuses or lacks an operation, the tool returns a precise failure. The architecture does not silently switch mechanisms.

## 21. File capability after core phone control

If direct files prove valuable, add **one** fixed `read` tool and nothing else initially.

Use `ACTION_OPEN_DOCUMENT_TREE` and persistable URI grants. The user explicitly grants one folder tree at a time. Model-facing paths remain virtual (`/documents/foo.jpg`); `content://` URIs never leave the app.

`read(paths...)` handles only:

- one-level directory listing;
- bounded UTF-8/text reads;
- supported images returned as MCP image content;
- metadata/explanation for unsupported binaries.

No broad storage permission, filesystem path pretending, recursive index, content search or mutation in the first file slice. If users actually ask to “clean up my phone”, computer-use can drive the system file manager before we add a destructive direct-storage API.

## 22. Tests that are architecture gates

Native/tunnel:

- real Android arm64 AAR build;
- real Secure Tunnel initialize/list/call;
- callback into Kotlin;
- start/stop/restart lifecycle;
- API key absent from logs/argv/files.

MCP:

- tools/list is exactly `observe`,`computer` in every policy state;
- disabled handler returns `TOOL_DISABLED`, schema does not change;
- annotations correct;
- bounded output and validation errors never dump schema/stack traces.

Observe:

- screenshot + nodes describe one locked acquisition;
- 60 default / 100 max node bound;
- password/sensitive values redacted;
- window screenshot secure failure is explicit;
- new observe invalidates old refs/frame as specified.

Refs/frames:

- obsolete node `refresh=false` -> `STALE_REF`;
- semantic action false does not trigger coordinate gesture;
- stale/missing frame refuses every coordinate action;
- orientation/frame mismatch refuses.

Computer:

- batch strict order;
- first failure stops remaining actions;
- capture_after stays under same mutex;
- type without accessibility input connection -> `NO_TEXT_INPUT`;
- unsupported global action -> explicit rejection.

Lifecycle:

- accessibility bind starts runtime once;
- repeated bind callback cannot create two tunnels;
- teardown closes one runtime and fails in-flight control cleanly;
- Activity open/close does not own connection.

Activity/security:

- every call produces exactly one row;
- secrets/screenshots/password values absent from rows;
- retention bounded;
- Keystore decrypt failure never falls back to plaintext.

## 23. Distribution reality

Google Play's current Accessibility policy explicitly prohibits using Accessibility APIs for an app that autonomously initiates, plans and executes actions/decisions unless it is a genuine qualifying accessibility tool. A ChatGPT phone-control agent squarely risks that rule.

Therefore the technically honest v1 distribution target is direct/private **signed APK installation**, still satisfying “one app, done”. Play Store compatibility is a product-policy problem and should not contaminate the control architecture with weaker APIs or deceptive declarations.

The one unavoidable setup cost of a sideloaded Accessibility app is Android's own restricted-settings protection on modern versions. We should explain it cleanly rather than trying to bypass it.

## 24. Implementation order

**Spike 0 — transport proof.** Embedded Go AAR + in-memory MCP + real OpenAI tunnel + Kotlin callback. Nothing else until this passes.

**Slice 1 — observation.** Accessibility service, exact service config, `observe()` screenshot/tree/ref/frame, policy toggle, Activity row.

**Slice 2 — semantic control.** click_ref, set_value, scroll_ref, strict stale refs, batch/mutex, capture_after.

**Slice 3 — touch/input/navigation.** frame-required tap/double_tap/gesture, accessibility input `type`, global back/home/recents/notifications/quick settings.

**Slice 4 — product shell.** Keystore secrets, DataStore, setup/Home/Tools/Activity UI, auto-connect from service lifecycle, APK signing/release.

**Slice 5 — real-device torture.** Settings, Chrome, WhatsApp, Spotify, Maps, system permission sheets, keyboard open/closed, dialogs, WebViews, canvas-heavy apps, orientation changes, secure windows, network loss, process/service recreation.

Only after that decide from real usage whether SAF `read` deserves tool #3.

## Final architecture rule

**One capability path for each thing.** Semantic UI action either succeeds on its ref or fails. Coordinate action either matches its frame or fails. Screenshot uses Accessibility or fails. Tunnel uses the embedded OpenAI client or fails. Text uses node set-text / Accessibility input according to the explicit action or fails. There is no invisible “try five other ways”.

That is the Android version of the best thing the current connector learned during the 45→6+2 redesign: a small set of honest primitives beats a large set of clever procedures and compatibility fallbacks.
