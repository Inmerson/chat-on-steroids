# Tunnel / Setup Audit

Persisted by prime from worker-2's completed read-only audit. No product code was changed.

## Current connector

`src/main/connection.ts` owns lifecycle. Connect/disconnect are serialized, the MCP endpoint starts before the tunnel, a generation counter invalidates late callbacks from an old connection, and shutdown happens in reverse order. That ownership pattern is worth preserving.

`src/main/mcp/server.ts` currently serves one loopback HTTP listener with secret token-qualified paths and one real MCP handler per surface. It enforces loopback Host/Origin checks, a bounded request body and RFC 9728 protected-resource metadata. Self-test and tunnel probes are deliberately not counted as evidence that ChatGPT reached the app.

The Core/Desktop split is a real discovery boundary. On OpenAI Secure Tunnel it also costs one tunnel id per surface because ChatGPT addresses a tunnel id and normalizes connector traffic to the main channel.

The TypeScript tunnel code is a supervisor, not the tunnel protocol. `src/main/tunnel/index.ts` starts the bundled Go `tunnel-client.exe`, passes API key + local MCP URL out of argv, reads readiness/metrics/status, distinguishes internet loss from a dead client, and restarts a dead process with backoff. `locate.ts`, PATH/common-directory probing, Windows process-tree termination, cloudflared and manual transport are desktop/fallback complexity rather than product capability.

Current secrets use Electron `safeStorage`/DPAPI. The renderer can set/clear the API key and see only whether one exists. Android should keep that one-way property using Android Keystore-backed encryption in app-private storage. Tunnel ID is not secret; API key is.

The Chrome extension bridge is unrelated to MCP connectivity. It exists for page/session observation and multi-agent browser automation. Do not port it into the Android control connector.

## Android conclusion

One APK, one connector, one supported publication path: OpenAI Secure MCP Tunnel. Delete cloudflared/manual, binary discovery/picking, external executable installation, browser-extension pairing, tray behavior and multiple surface/tunnel lifecycle.

The current Windows loopback-server architecture is a good reference for security and lifecycle, but upstream now exposes an embeddable Go tunnel client that accepts an in-memory MCP transport. Therefore the preferred Android design is stronger than a literal port: package a tiny Go bridge in the APK and connect its Go MCP server directly to `tunnelclient.New(...)` through `mcp.NewInMemoryTransports()`. No localhost listener, no secret URL, no child process and no tunnel health HTTP listener are needed in the normal Android runtime.

Kotlin owns Android lifecycle, policy, Accessibility APIs, UI, storage and Activity history. Go owns only the MCP wire contract and OpenAI tunnel runtime. The cross-language API should remain tiny and string/byte-oriented.

Setup should expose only the things the user genuinely has to do: enable Phone Control, enter/store the tunnel credentials, connect, then add/select the one connector in ChatGPT. Keep exact connector name/description and end-to-end last-call proof. Do not expose provider selectors or implementation details.
