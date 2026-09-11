# OpenClaw-Compatible MCP Registry Design

## Goal

Let a user register third-party MCP servers and make their selected tools available through Chat On Steroids without weakening the existing Core, Desktop, Steromi, sandbox, or connector-discovery boundaries.

## Decision

Adopt the small, portable parts of OpenClaw's `mcp.servers` model rather than embedding OpenClaw or treating its Gateway as a dependency. The registry owns durable definitions, connection lifecycle, tool discovery, safe namespacing, and policy projection. Chat On Steroids remains the authority for its own built-in tools, permissions, session recording, browser attribution, and tunnel endpoints.

The initial supported transports are `stdio`, `streamable-http`, and `sse`. `http` is accepted only as a legacy UI alias and stored canonically as `streamable-http`.

## Boundaries

### Separate external surface

Third-party tools will be published on a new optional `external` MCP surface, not merged into Core, Desktop, or Steromi. ChatGPT caches a connector's complete schema list; a dedicated connector keeps untrusted third-party schemas and their changing availability out of the stable first-party connectors.

The new connector has a stable identity but registers only the enabled external tools at each endpoint lifetime. Editing a registry entry prompts the user to reconnect the External connector. Existing Core/Desktop exposure-monotonicity rules remain unchanged.

### Registry definitions

The durable config shape is an `mcp.servers` map keyed by a user-chosen stable ID. A definition includes:

- `enabled`: explicit opt-in, default false for newly imported definitions;
- `transport`: `stdio`, `streamable-http`, or `sse`;
- a stdio `command`, bounded `args`, optional `cwd`, and restricted environment map, or a validated endpoint URL;
- an optional bounded description and a per-server tool allowlist;
- no discovered tool schemas, live tokens, OAuth callbacks, or health logs.

Secrets are never persisted in the ordinary config or returned to the renderer. Credential support is deliberately out of scope for this first slice. HTTP endpoints therefore support unauthenticated or already host-authenticated development services only; OAuth and bearer-token onboarding will be a separate design because they introduce account and secret ownership flows.

### Authority and execution

The Electron main/Core process creates external MCP clients. The renderer can only submit validated registry edits, request an explicit probe, view sanitized discovered metadata, enable/disable a server, or remove it. It never receives process handles, raw server output, environment values, credentials, or arbitrary IPC.

A client is lazy: saving a server never starts it. Explicit Probe and External connector discovery may start a client. Each client has bounded initialization, tool-list, call, and shutdown timeouts. Stdio clients are launched without a shell and are disposed as a process tree during disconnect, config replacement, and application shutdown.

### Tool projection

Each discovered server tool becomes a separately registered external tool named:

`<safe-server-name>__<safe-tool-name>`

The safe server name follows OpenClaw's readable normalization: invalid characters become `-`, a leading non-letter gains `mcp-`, and collisions get deterministic suffixes. Tool names use the same safe normalization. The original server and tool names stay only in internal routing metadata.

Tool calls are forwarded only when all of the following are true:

1. The server remains enabled and is in the current external projection.
2. The server tool is explicitly allowlisted (or the server is configured for all discovered tools after an explicit user confirmation).
3. The active connection epoch matches the registered projection.
4. Request and response payloads stay within schema, byte, and timeout limits.

External MCP errors are returned as typed, sanitized tool errors. They cannot expose filesystem roots, command lines, environment values, tokens, raw protocol frames, or arbitrary server-provided instructions as host authority.

### Network policy

Remote definitions require `https:` by default. Loopback `http:` is allowed for local development. Private, link-local, multicast, and metadata-service destinations are denied unless a future, explicit trusted-network setting is designed. Redirects are disabled or independently revalidated. DNS results are checked at connection time to reduce SSRF/rebinding exposure.

### UI

The current Plugins screen is display-only for custom MCPs: it stores data in `localStorage`, pretends every health check succeeds, and never starts a client. It will become a real main-process-backed registry UI:

- add/edit transport-specific fields;
- show persisted enabled/disabled state, actual probe result, discovered tool count, and a reconnect-required marker;
- choose tools after discovery, with none selected by default;
- remove a server only after an explicit confirmation;
- show security guidance for local commands and remote endpoints.

## Components

| Component | Responsibility |
| --- | --- |
| `src/main/mcp/external-registry.ts` | Validate and persist safe registry definitions; generate safe IDs/names. |
| `src/main/mcp/external-client.ts` | Transport-specific connection, discovery, call forwarding, bounded shutdown. |
| `src/main/mcp/external-policy.ts` | URL/SSRF, environment, argument, size, and tool-allowlist checks. |
| `src/main/mcp/tools-external.ts` | Register projected tools onto only the External surface. |
| `src/main/mcp/surfaces.ts` | Declare the optional External connector and its discovery contract. |
| `src/main/core/ui-dispatch.ts` and IPC declarations | Main-process-only registry CRUD/probe operations. |
| `src/renderer/plugins-*` | Replace localStorage demo state with typed IPC-backed UI. |

Exact filenames may be adjusted to the current Core-host boundary after the implementation plan maps it, but responsibilities must stay separated.

## Failure behaviour

- Invalid configuration: reject before persistence and identify the field without echoing a secret.
- Server unavailable: retain the disabled/degraded registry entry; do not break Core/Desktop or other external servers.
- Schema changes: mark the External connector reconnect-required; do not mutate a live cached ChatGPT schema list.
- Child process leak: terminate the owned process tree; log only redacted diagnostic metadata.
- Disabled/revoked tool call: fail closed with `TOOL_DISABLED`/`EXTERNAL_SERVER_DISABLED`.
- Shutdown timeout: force-close the external transport and owned child process, then continue global shutdown.

## Tests and acceptance criteria

1. A fake stdio MCP can be registered, probed, projected with a namespaced tool, called, disabled, and shut down.
2. A fake Streamable HTTP MCP can be registered and used only through its namespaced tool.
3. Tool-name collisions, unsafe server IDs, oversized schemas/results, malformed transport payloads, and stale connection epochs fail safely.
4. Dangerous stdio environment keys, shell interpretation, unapproved tools, non-HTTPS remote endpoints, and SSRF-class destinations are rejected.
5. Built-in Core, Desktop, and Steromi tool lists are unchanged, and no external tool is accepted by them.
6. Renderer tests prove state comes from IPC rather than `localStorage`; health indicators reflect actual probe outcomes.
7. The relevant MCP/unit/type/build gates pass, plus a security-diff scan of the new trust boundary.

## Non-goals

- Executing arbitrary code from a plugin marketplace.
- Importing OpenClaw's full Gateway, agent runtime, or plugin lifecycle.
- Automatic server enablement, automatic execution during save, or automatic tool allowlisting.
- OAuth, token storage, remote credential exchange, or sharing registry entries among operating-system users.

