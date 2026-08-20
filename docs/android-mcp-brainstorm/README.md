# Android MCP Brainstorm

Shared design workspace for the proposed single-app Android MCP connector.

## Product direction

- One Android app / one APK. No companion PC app and no separately installed tunnel binary.
- Primary focus: phone/computer use. The app should let ChatGPT observe and control Android with a very small, high-leverage MCP tool surface.
- Keep the current ChatGPT Local Files connector's strongest design ideas: tiny primitive tool surface, explicit capability gating, bounded outputs, transparent activity history, honest connection health, and model-facing schemas that describe exactly what can really be enforced.
- Re-evaluate every current Core/Desktop tool before porting it. Preserve capability, not Windows-specific implementation.
- Prefer one connector / one tunnel on Android if the final tool surface stays small enough. Avoid the current Windows Core/Desktop split unless Android discovery constraints actually require it.
- Setup must be extremely simple: install app, grant the minimum Android system access, add/connect the OpenAI tunnel/connector, done.
- Code should be lean, strongly layered, and deterministic. Avoid compatibility fallbacks and parallel implementations unless there is a demonstrated hard requirement.
- If Go is required for OpenAI tunnel-client integration, it must be embedded inside the APK behind a tiny native bridge. Kotlin owns product/UI/Android capabilities. No user-visible second binary or runtime installation.
- Full user-visible Activity timeline of MCP tool calls and outcomes. Tools can be enabled/disabled in-app.

## Files

- `worker-tool-surface.md` — audit of current MCP tools and Android mapping.
- `worker-tunnel-setup.md` — audit of current tunnel/setup architecture and single-APK mapping.
- `prime-architecture.md` — integrated target architecture and decisions.

Workers should write only their assigned file unless explicitly coordinating with prime.
