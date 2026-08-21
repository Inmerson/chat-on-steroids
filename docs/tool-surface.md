# The model-facing tool surface

Settled design, 2026-08-17. Discussion is closed; this file is the decision record and the
implementation brief.

**Status: implemented in 1.7.1**, except §5 (skills), which is deliberately not in this
release — see the note at the top of that section. Measured on the shipped surface, the
worst-case `tools/list` is **core 12,506 bytes over six tools** and **desktop 7,915 bytes
over two**, down from the 45 tools / 60,484 bytes recorded in §1. `test/mcp.test.ts`
holds those numbers as budgets.

The rule this document exists to enforce: *a new capability becomes a skill or a workflow
over the existing primitives, not a new permanently exposed tool.*

---

## 1. Why

Measured on the real server with every capability enabled (`tools/list`, all features on):

**45 tools · 60,484 bytes · ~15,100 tokens**, plus ~1,200 for the server instructions.

| family | tools | ~tokens |
| --- | --- | --- |
| file mutation (`create_file` … `delete_directory`) | 11 | 3,100 |
| read / search | 7 | 2,200 |
| exec / process | 8 | 3,600 |
| desktop (`computer` alone is 4,963 bytes) | 7 | 3,000 |
| agents | 6 | 1,500 |
| session | 3 | 1,000 |
| clipboard / url | 3 | 600 |

`agent_key` is injected into **all 45 schemas** by `withAgentKey`, roughly 300 bytes each —
about 13 KB, north of 20% of the whole surface, for a field that means nothing unless
multi-agent mode is on. (It is gone entirely in what shipped, along with `withAgentKey`;
see the `agents` section below for what replaced it.)

Three reasons to cut it, in order of actual weight:

1. **Selection reliability.** Eleven mutation tools are eleven chances to pick the wrong
   one, and every wrong pick costs a retry worth far more than the schema it saved.
2. **The prefix survives compaction.** After `save_handoff` opens a fresh chat, the new
   conversation starts ~16k tokens down before a word of the brief is read. That is a
   permanent floor on every session, and it is the one cost compaction cannot reclaim.
3. **Byte count**, a distant third: ~15,100 → ~1,900 tokens is real but it is ~3% of a
   context ceiling we have now measured at roughly 400k of our own units.

Do not argue this work on point 3 alone. It was the original framing and it is the weakest.

> **Amended 2026-08-17 (see §6).** Points 2 and 3 assume the whole surface sits in every
> conversation's prefix. On gpt-5.4+ it does not: the client holds a one-line app summary and
> pulls schema subsets on demand, so the measured 15,100 tokens is a ceiling paid only by
> older models, not a floor paid by everyone. **Point 3 is dead** and point 2 shrinks to the
> summary line. Point 1 survives intact and is now doing nearly all the work — with a new
> sibling, *retrieval recall*: a tool that a plain-language query fails to surface is a tool
> the model does not have. The numbers above stay as the honest worst case, which is what the
> eager-loading path still costs.

## 2. Evidence that shaped the schemas

Three findings from source, all load-bearing:

- **The transport is stateless.** `server.ts` uses `createMcpHandler(factory)`, whose
  default legacy posture is *"each legacy request is answered by a fresh instance from the
  same factory … constructed with only `sessionIdGenerator: undefined`"*, with GET/DELETE
  answered `405`. `test/mcp.test.ts` records that ChatGPT sends 2025-era requests today.
  So `mcpCtx.sessionId` is `undefined` on every ChatGPT tool call and there is no
  per-conversation handle to bind identity to. This is structural, not unverified.
- **Some hosts collapse root-level unions.** Recorded at `tools.ts:1771`: *"Keep this flat
  rather than a top-level discriminated union: some MCP hosts collapse union schemas to an
  unhelpful generic object and hide every action field."* Therefore every action-style tool
  below is a **flat schema with an `action`/`what` enum and optional fields**, never
  `z.discriminatedUnion` at the root. `computer` is the sole exception and is allowed only
  because its union is nested inside an array, which is the batching feature itself.
- **We pay for Codex shape and get none of the familiarity.** Our exec fields are spelled
  `'yield-time_ms'` — a hyphen where Codex has `yield_time_ms`.

Codex's own surface (`codex-rs/core/src/tools/handlers/`) confirms the direction: `shell`,
`unified_exec` (= `exec_command` + `write_stdin`, kept as **two** tools with different
defaults), `apply_patch` with a `.lark` grammar, `view_image`, `plan`, `tool_search`,
`multi_agents_v2`, `get_context_remaining`, `new_context`. `ToolSpec` carries a per-tool
`defer_loading` flag — a **client-side** feature of their harness, which an MCP server
cannot request. Codex has no `read` tool at all; it reads files through the shell. Our
divergence there is deliberate (§4).

## 3. The surface

Split across **two connectors** (§6.4). Membership is fixed per surface; capabilities decide
only whether a given tool is registered at all.

| surface | configuration | tools |
| --- | --- | --- |
| Core | normal coding | `read`, `apply_patch`, `exec_command`, `write_stdin` — **4** |
| Core | \+ session recording (default on) | `session` — **5** |
| Core | \+ multi-agent (default off) | `agents` — **6 max** |
| Core | read-only, command capability **off** | `find` replaces the exec pair — still **≤6** |
| Desktop | computer use | `observe`, `computer` — **2** |

Six on Core and two on Desktop is the ceiling, and merging unrelated concepts to reach a
rounder number is worse than leaving it. `find` is not a seventh Core tool: it is registered
only when `caps.command` is false — exactly when `exec_command` and `write_stdin` are absent —
decided when the capability snapshot is built at app start, never mid-conversation.

Everything else — git, PowerShell idiom, launching apps, killing trees, browser work,
repo debugging, release steps — is a **skill over these primitives** (§5).

### `read`

One concept: read what is at these paths. No action discriminator. A directory and an
image are resources at a path, not separate operations, so three result shapes from one
flat input is correct and accepted.

```
read(
  paths:        string[]  (1..20)   virtual root-relative or approved absolute;
                                    a directory lists it, a glob expands server-side
  start_line?:  int                 only meaningful when paths has exactly one entry
  end_line?:    int
  max_bytes?:   int                 per-file cap
)
```

- Directories list **immediately, one level**. Recursive discovery is a glob, and both
  directory expansion and glob expansion carry hard entry caps so one call cannot explode
  the context. State the cap in the result when it bites.
- Images return image content. `view_image` disappears into this.
- Binary returns base64 **only when explicitly safe and bounded**; otherwise return
  metadata plus the reason rather than dumping bytes.
- The per-path header (size, mtime, encoding, line count, truncation) is what `file_info`
  used to be, so `file_info` disappears too.

Replaces: `read_file`, `read_files`, `list_directory`, `file_info`, `view_image`,
`list_roots` (roots move into the server instructions as context).

### `apply_patch`

The only text mutation primitive. Codex's V4A envelope verbatim — `*** Begin Patch`,
`*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:`, `@@` context —
because it carries more model training mass than any alternative. Our backend keeps what
makes it better: multi-file, atomic preflight and rollback, CRLF tolerance, NUL/control-byte
rejection in text edits.

Replaces: `create_file`, `create_directory`, `edit_file`, `edit_files`, `write_file`,
`append_file`, `write_binary_file`, `move_path`, `delete_file`, `delete_directory`.

Two of those did not survive the fold, and the permission checkboxes were corrected to
match rather than left advertising them (1.7.1):

- **`delete_directory` → gone.** The V4A envelope has no way to express removing a
  directory, and inventing a directive for it would be a private extension to the one
  format chosen *because* it is not private. The `deleteFolder` permission was removed;
  deleting a folder now goes through `exec_command`, which is a permission the user grants
  deliberately.
- **`create_directory` → only as a side effect.** Adding a file creates its parent folders.
  An intentionally empty folder also needs `exec_command`. The "Create files and folders"
  checkbox is now "Create files" and says so.

Permissions stay independent where they were independent: a `*** Update File` carrying only
a `*** Move to:` is a move and requires Move, not Edit; one that also carries hunks requires
both.

Binary writes are the one genuine gap; they become a documented `apply_patch` extension or
a skill-documented exec path, decided at implementation time. Do not re-add a tool for it
without arguing the case here first.

### `exec_command`

```
exec_command(
  cmd:            string                     shell string, not argv
  cwd?:           string
  shell?:         'powershell' | 'cmd'
  env?:           record<string,string>
  tty?:           boolean                    default false
  cols?, rows?:   int                        initial console size when tty
  yield_time_ms?: int                        default 10000    ← renamed from 'yield-time_ms'
  max_lines?:     int                        default 80
)
```

Returns a `session_id` **only while the process is still running**. All current server
behaviour is kept and none of it costs schema: fixed UTF-8 `InputEncoding`, absolute
executable discovery, `$LASTEXITCODE` propagation, non-zero exit reported in the output
rather than raised as a tool error.

Replaces: `run_powershell`, `run_command`, `launch_app`, `inspect_repo`, `open_url`
(all skill territory over this primitive). Clipboard read/write did **not** fold in here:
they are desktop operations and live on `computer`, which is what lets a user grant the
clipboard without granting command execution.

One tool means one permission. `powershell` and `command` were one tool each; keeping both
checkboxes against a single tool that defaults to PowerShell made "Run PowerShell" grant
nothing and "Run executable" silently grant PowerShell anyway. They are now the single
`command` permission ("Run commands"), and `config.ts` folds a PowerShell-only grant into
it on load.

### `write_stdin`

```
write_stdin(
  session_id:     string
  chars?:         string             default '' = poll only
  yield_time_ms?: int                default 250 after input, 5000 when polling
  cursor?:        string             opaque; delta-only output
  max_lines?:     int
  close?:         boolean            close stdin
  signal?:        'int' | 'kill'     Ctrl-C / force-terminate the tree
)
```

`signal` is the whole reason `process` can die: an opaque `session_id` gives the model no
pid to `taskkill`, and Ctrl-C only reaches a `tty=true` session. `int` sends `\x03` on a
tty and closes stdin on a pipe; `kill` force-terminates the tree.

`resize` leaves the model-facing surface entirely. Default the console to 120×30, take
`cols`/`rows` at start, and let the windows-shell skill say "restart with `cols=200` if a
TUI wraps badly".

Replaces: `process`, `process_status`. **The backend `process-manager.ts` is untouched and
stays internal.**

#### Recovery of live sessions

Rejected: appending a live-session roster to every exec/write result. It is repetitive
prefix noise that accumulates in history forever.

Settled order instead:

1. `exec_command` returns its own `session_id` when the process is live.
2. `write_stdin` keeps it alive and polls it.
3. **`save_handoff` / `resume_session` persist and restore a bounded list of live process
   ids plus command labels** whenever session support is enabled.

Step 3 needs no new plumbing: `process-manager.ts` already exports
`listManagedProcesses(): ManagedProcessStatus[]` with `id`, `pid`, `command`, `running` and
`startedAt`, and imports nothing from Electron — only `node:child_process` and `./exec.js`
— so the session/handoff layer can read it directly with no cycle and no test fallout. Cap
the persisted list (10 entries, command label truncated) and store it on the handoff.

A `live_sessions` field on tool results is added **only** if a concrete recovery path
outside session/compaction turns out to need discovery, and even then only when non-empty.
Never as unconditional boilerplate.

### `observe`

```
observe(
  what?:       'active' | 'windows' | 'window' | 'ui'   default 'active'
  window?:     int      HWND, for 'window' | 'ui'
  match?:      string   filter for 'windows' | 'ui'
  wait_for?:   string   return once a window matching this appears
  timeout_ms?: int      with wait_for
  screenshot?: boolean  default true for 'active' and 'window'
)
```

**Contract, stated in the description and enforced in code: `observe` never requires
foreground and never returns `FOCUS_FAILED`.** Screenshotting or reading UIA for a known
HWND is something Windows permits without activation. Only `computer` may demand focus.
This is the structural fix for the live bug where `get_window_state(window=328264)` refused
because Chrome was foreground, and then `computer([{type:'focus'}])` — the recovery
primitive — refused for the same reason, while ALT+TAB worked instantly.

A default `observe()` returns active window + screenshot + UI refs, which is the call the
model should make first and most often.

Replaces: `screenshot`, `list_windows`, `get_active_window`, `get_window_state`, `find_ui`,
`wait_for_window`.

### `computer`

Shape unchanged — the nested action array stays, because batching heterogeneous desktop
actions **is** the feature.

```
computer(
  actions:       Action[] (1..20)   click_ref | set_value | click | double_click | move |
                                    drag | scroll | type | keypress | focus | wait
  captureAfter?: boolean
  frame?:        string             staleness token; STALE_FRAME on mismatch
)
```

The 4,963 bytes are almost all per-variant prose. Cut each variant to a phrase and move
coordinate discipline, frame staleness, ref lifetimes and the focus rules into the
desktop-ui skill.

> **Shipped at 5,631 bytes, not the ~1,800 targeted here.** The prose was cut as planned,
> but the estimate was made before the union absorbed the clipboard and grew to fourteen
> variants, and what remains is JSON Schema structure rather than prose: each variant
> spells out its own arguments. Collapsing the union would buy the bytes back at the cost
> of the two things it is there for — an explicit action set and small validation errors —
> so it stays, with a per-tool budget in `test/mcp.test.ts` to catch drift.

`focus` is the one action allowed to fail for lack
of foreground, and its failure must name the sampled foreground window and the sampling
timestamp rather than returning a bare code.

### `session` (only when session recording is on)

Flat enum: `resume` | `history` | `save_handoff` | `status`. `status` carries the remaining-
context estimate — our answer to Codex's `get_context_remaining` — and must state that the
unit is ours, not ChatGPT's private counter.

### `agents` (only when multi-agent is on)

Flat enum: `spawn` | `join` | `message` | `status` | `finish`.

> **Superseded.** This section originally kept `agent_key` as one isolated field, on the
> grounds that §2 shows nothing to bind identity to. What shipped drops it entirely. The
> binding is the ChatGPT **conversation**, established by the app rather than asserted by the
> model, and it is available for both roles: the prime is bound from the conversation that
> spawned, and a worker is bound when the extension reports which chat it opened for the
> slot — which happens before that chat has said anything. Page evidence, scoped to the
> individual call, turned out to be a stronger answer than a field the model has to carry,
> and it needs nothing of ChatGPT's transport.

What shipped:

- **no key field on any tool**, in any mode. Identity is never something a model presents;
- `join_agent` becomes `agents(action='join')`, and `join` is **recovery only** — the manual
  way back when the extension's report never arrived. It takes a one-time `join_key` the
  user gets from the app window, spent on use, and the ordinary run never uses it;
- `agent_inbox` is deleted, since messages already piggyback on ordinary tool results;
- a worker's chat is opened with **its task as the first message**. There is no join step in
  the normal lifecycle at all;
- a control call whose conversation cannot be proven is refused as `WORKER_IDENTITY_LOST`
  rather than falling back to anything. Ordinary file and command calls that cannot be
  placed are *not* refused — they simply get no agent — so unrelated chats keep working.

### Validation errors

Compact, everywhere: offending field path, the bad value, the constraint it broke, and a
corrected example. Never a dump of the whole schema — that harness bug is already recorded
in the maintainer's local tool-call audit, and the new surface must not reintroduce it.

## 4. What we deliberately do not copy from Codex

- **Reading through the shell.** Codex has a sandbox, a real terminal renderer and Unix
  quoting. We have PowerShell quoting, a small practical result budget, permissioned
  virtual roots, and images. `cat` through exec cannot enforce a root boundary, cannot
  return an image, and mangles UTF-8.
- **`code_mode` (tools-as-code).** Presumes a trusted sandbox and many cheap calls; ours
  are permissioned, audited, user-visible actions.
- **`sandbox_permissions` / `justification` / `request_permissions`.** Our permission model
  lives in the desktop app where a human can see it. Moving approval into the schema
  weakens it and taxes every call.
- **`update_plan`.** ChatGPT renders its own plan; a plan tool would write synthetic rows
  into a recorder whose whole value is being the record of what actually ran.
- **`defer_loading` / `tool_search`.** Client-side features of their harness. We are a
  server inside someone else's client (§6).

## 5. Skills

> **Not in 1.7.1. Deliberately deferred, with one piece landed early.**
>
> The 1.7.1 release is the surface reduction: 45 tools become 6 + 2. Skills are the other
> half of the design — how *new* capability arrives without new tools — and they are a new
> subsystem (a virtual read namespace, a bounded instruction catalog, and a file format
> that becomes a compatibility surface the moment a third-party skill exists). Shipping a
> half-implementation inside a release whose gate is "the tool surface is now small and
> stable" would put an unfinished contract in front of users at exactly the moment the
> contract matters most. Nothing in the reduction depends on it.
>
> The one piece that *is* in 1.7.1 is the name reservation, because it is the only part
> that cannot be added later: `RESERVED_ROOT_NAMES` in `src/main/sandbox.ts` refuses
> `skills` as a root name and `config.ts` renames a saved root that claims it. Once a user
> has an approved folder called `skills`, `/skills/<name>/SKILL.md` is ambiguous forever.

No `load_skill` tool. Skills are served as a **reserved read-only virtual namespace** that
`read` can reach and that cannot be confused with a user root — `/skills/<name>/SKILL.md`,
with the name reserved so a real root may not claim it.

Progressive disclosure, exactly Codex's layering:

1. **Catalog** — in the server instructions: name + one compact trigger line, nothing else.
   Bounded; ~40 tokens each, so thirty skills cost less than today's `computer` schema.
2. **`SKILL.md`** — loaded only when triggered, by an ordinary `read`.
3. **`references/`, `scripts/`** — loaded later still, by ordinary relative `read`s from
   within the skill.

Skills are data: shippable, user-editable, hot-reloadable, with no effect on the tool
surface and no interaction with the cached-snapshot problem.

Initial set: `desktop-ui` (computer use), `browser`, `git`, `windows-shell`,
`file-workflows`, `multi-agent`, `sessions` (compaction/handoff), `testing`, `release`,
`binary-files`, `repo-debugging`.

A skill may hide instructions and resources. A skill may never hide a tool schema. That line
is not ours — it is how OpenAI's own docs divide the two (§6.1), and it is the same line the
§7.2 invariant draws from the server's side.

Because of that line, a skill whose procedure needs tools from a surface other than the one
serving it must **name that connector in its catalog entry** — `desktop-ui` says it needs
"ChatGPT Local Files Desktop", `file-workflows` says "ChatGPT Local Files Core" — and its
`SKILL.md` must open with the same statement. A skill cannot mount a connector, and we
cannot assume a third-party skill could either, so the only honest failure mode is the model
telling the user which connector to connect. A skill that silently assumes a tool it cannot
see turns a setup step into an unexplained refusal.

`load_skill` becomes justifiable only if §6 ever resolves in favour of dynamic exposure,
since its second job would be unlocking deferred tool groups. §6 is closed against that, so:
not before, and probably not at all.

## 6. Deferred exposure — REOPENED 2026-08-17 on empirical evidence

> **The "assume no" conclusion below was wrong and is kept only so the reversal is legible.**
> It read: *Codex's `defer_loading` + `tool_search` is a harness feature we cannot request as
> a server; our only lever would be `notifications/tools/list_changed`… the stable eight-tool
> facade is the design, not a fallback.* The reasoning — that a server cannot grant itself
> deferral — still holds. The conclusion drawn from it did not: **the client already does it
> for us.**

What was actually observed in ChatGPT, by hand, on 2026-08-17: at turn start only one-line
app summaries were present (Gmail: description + 21 functions; our own connector:
description + 44 functions), no individual schemas. Calling ChatGPT's meta-discovery
`api_tool.list_resources(paths=["Gmail"], query="label")` injected **9** matching Gmail
schemas — not all 21 — after which `Gmail.list_labels` was structurally callable. The same
behaviour had been happening to our connector all along: schema subsets arriving in response
to queries like `file`, `computer`, `window`, never the full 44 up front.

The mechanism is documented, on the API side, in OpenAI's **Tool search** guide:

- *"dynamically search for and load tools into the model's context as needed"* — with a
  hosted mode where the API searches deferred tools and returns the matching subset.
- What the model holds before discovery: *"the model sees only the namespace or server name
  and description at the beginning, without showing details of the individual functions."*
- Deferral is a per-server flag: *"If you are using tool search, you can defer loading the
  functions exposed by an MCP server until the model decides it needs them"* (`defer_loading:
  true` → *"individual function definitions are loaded only when needed"*).
- Discovered tools **persist**: the model *"will be able to call any of these tools in future
  turns."* Monotonic, like our own exposure design.
- Injected at the end of the context *"to allow the model's cache to be preserved."*
- **Model-gated**: *"Only gpt-5.4 and later models support tool_search."*
- Sizing guidance, which bears directly on §6.1: *"aim to keep each namespace to fewer than 10
  functions"*, and *"Make namespace descriptions clear and descriptive of the use case,
  because the model relies on this description to decide when to load."*

Two divergences between that guide and the live ChatGPT harness are worth recording: the
guide says the model does not see function counts, and the observation clearly showed them
("21 functions", "44 functions"); and the ChatGPT harness names its meta-tool
`api_tool.list_resources(paths=…, query=…)` rather than the API's `tool_search`. So the guide
is good evidence of **mechanism** and bad evidence of **exact product behaviour**. Where they
disagree, the observation wins.

### 6.0 What this does and does not change

**Unchanged — the invariant (§7.2).** Client-side deferral is not a hidden callable surface.
The server advertises every tool honestly in `tools/list`; the client chooses which schemas
to hydrate into the model's context. The forbidden thing is the opposite — a server answering
calls for a name it never advertised. This case was called out in advance when the invariant
was written, and it needs no amendment.

**Unchanged — the tool-design work in §3.** Orthogonality, Codex-shaped naming, flat enum
schemas and compact validation errors are all arguments about *ergonomics and selection*, not
about bytes. None of them depend on how schemas reach the model.

**Dead — the byte argument.** §1's headline number (45 tools / 60,484 bytes / ~15,100 tokens
of permanent, non-reclaimable prefix) is simply not what a gpt-5.4+ conversation pays. It pays
one summary line. §1 must be rewritten before implementation; leaving it as the stated
motivation would be arguing from a cost that is not being incurred.

**Weakened but alive — deduplication.** Most of the 45 are not specialised, they are
overlapping (`read_file` / `read_text` / `open_file` and friends). Retrieval makes redundancy
*worse*, not better: the model is no longer choosing among tools it can see, it is choosing
among whatever a keyword query dredged up, and near-synonyms poison that ranking. Collapsing
duplicates stays right for exactly the reason it was already reframed around — selection
reliability.

**New and important — retrieval recall is now a correctness property.** Tool names and
descriptions have become retrieval documents. If a query for `file` fails to surface
`apply_patch`, the model cannot edit, and the failure looks like a missing capability rather
than a bad search. This is a design constraint we have never had, and it argues for a small
number of distinctly-named tools whose descriptions carry the vocabulary a user would
actually type.

**New and important — graceful degradation is mandatory.** Tool search is gpt-5.4+. The model
is the user's choice, per conversation, and some of them will be on something older or on
whatever ChatGPT falls back to under load. Those conversations get the **whole surface,
eagerly**. So the total surface still cannot balloon back toward 45: the deferred case sets
the ambition, the eager case sets the ceiling. Nothing may be added on the assumption that
nobody ever pays for it up front.

**The real risk.** `api_tool.list_resources` appears in no ChatGPT product documentation. It
is one account, in developer mode, on one date, on one model tier. It can be changed or
A/B'd off without a release note. An architecture that *requires* deferral to be usable would
ship a 60k-token prefix to every user the morning it reverts. An architecture where deferral
is upside — small core that would be fine eagerly, extended set that is a win when deferred
and a bounded cost when not — survives the reversion. Design for the second.

### 6.1 SUPERSEDED — one app was the right call only while deferral looked reliable

> **Overtaken 2026-08-17 by the no-query measurement. The live topology is §6.4: two
> surfaces, 6 + 2.** This section is kept only because the reasoning shows which premise
> broke.
>
> **Its packaging claims are historical and non-authoritative.** They describe how the
> OpenAI plugin/app docs read in August 2026 — a plugin holding one MCP server, apps
> picked per conversation — and this product does not ship a plugin. What 1.7.1 actually
> relies on is narrower and is stated in §6.4 and §6.5: two custom connectors, each its
> own tunnel id on the OpenAI path, each with its own token-qualified local path. Do not
> re-derive a decision from anything below this line.

Decided by the user, 2026-08-17, after a review of the OpenAI plugin/app/skill docs as they
stood that month. **One CLF plugin containing one CLF app and many skills.** Skills may hide
instructions and resources; they may never hide tool schemas. Splitting the surface across
several apps or several plugins is rejected for the default experience.

> **Amended the same day.** The escape clause in the original wording — *"unless some future
> ChatGPT client offers real deferred tool discovery"* — has fired. That client is the current
> one. The reasons below that turn on **packaging** and **per-conversation app selection**
> still stand and still carry the decision. The reason that turned on *"there is no
> deferral"* does not. See the sizing guidance quoted above (*"fewer than 10 functions"* per
> namespace, with the namespace description as the routing signal) — a genuine argument on
> the other side, and the one that won once §6.4's measurement landed.

Four quotes from those docs carry the decision, and they are recorded here because the pages
will move:

- The plugin container is singular. *"A plugin can contain: Skills that give the model
  instructions and resources for repeatable workflows. **An** MCP server that exposes tools
  and connects to external systems. Both skills and an MCP server…"* There is no documented
  multi-server plugin, so a "capability module per app" packaging does not exist to be used.
- Skills disclose prose, in exactly those words. *"The model first sees skill metadata,
  including the name and description. It loads the complete instructions when the user's
  request matches the skill or the user invokes it directly."* The boundary is drawn
  explicitly too: *"the MCP server provides data, authentication, authorization, and actions;
  the skill provides reusable instructions, examples, templates, and other resources."* No
  dependency edge from a skill to a tool group, and a skill is documented as working with no
  MCP server at all — which only makes sense if it never carries callable surface.
- A changed tool list is a manual, out-of-conversation event. *"Deploy or restart the MCP
  server. Open the connection at ChatGPT Plugins. Select **Refresh**. Confirm that the
  advertised metadata changed. **Start a new conversation** and rerun the affected tests."*
  This is the caching posture stated as product behaviour, and it independently confirms the
  §7 migration path.
- Apps are chosen per conversation, by hand, up front. *"Choose Developer mode from the Plus
  menu and select the apps for the conversation."*

That last one is why a user-selected multi-plugin split is rejected even though it is the one
option that would genuinely shrink exposure. The selection happens before the first message,
which is precisely when nobody yet knows what the chat will turn into. Our sessions routinely
open on "read this file" and end on "run the build and drive the desktop"; a user who picked
a files-only module at message one has no recovery inside that conversation, only settings →
toggle → refresh → new chat. We would be trading a small fixed prefix for a workflow cliff,
and multiplying pairing, token and tunnel setup by the number of modules — for a surface that
is eight tools in total.

The cheaper version of that idea already exists and needs no architecture: connector settings
let a user *"toggle tools on or off and refresh apps"*, so anyone who wants `computer` or
`agents` out of their context can mute them on the single app. The monotonic exposure kept in
§7.2 is what makes doing that mid-conversation safe.

The two legitimate levers on exposure, then, are exactly these: capability-conditional
registration decided when the snapshot is built (§7.2), and the user's own per-tool toggles.

### 6.2 The old canary — retired, half-answered

Half A asked whether the per-conversation snapshot is authoritative, by registering a name
that is callable but absent from `tools/list`. **Do not run it.** It tested the wrong axis:
the question was never whether the *client* can acquire schemas late — it plainly can — but
whether the *server* may conceal them, and §7.2 forbids that by choice rather than by
capability. Running it could only tempt us into the shim we already rejected.

Half B asked whether the client re-lists mid-chat after `notifications/tools/list_changed`.
Still unanswered and now much less interesting: the client acquires schemas by pulling on its
own initiative, so we do not need a push channel to get late disclosure. Keep it parked. Note
the prerequisite that made it expensive is unchanged — a server-initiated notification needs
a delivery channel, and the handler runs with `sessionIdGenerator: undefined` and 405s GET
(§2).

### 6.3 What must be measured before the surface is fixed

E1 below has been **run and answered** — see §6.4. E2 and E3 remain worth doing and neither
gates the work.

**E1 — RESOLVED 2026-08-17. Deferral is real but it is not a bound.**
The question was whether small apps load eagerly. The measurement that actually mattered
turned out to be a different one, taken against our own connector:
`api_tool.list_resources(paths=["TobisComputer"])` **with no `query` returns the entire
server tool surface immediately.** A `query` narrows it; the absence of one does not cap it.

So deferral is a *latency and typical-case* win, not a worst-case guarantee. Nothing obliges
the harness to ask a narrow question, and one broad or absent query pulls everything the
server advertises. A 40-tool server is therefore still a 40-tool exposure risk, just an
intermittent one — which is the worst kind, because it tests fine and fails under load.

The consequence is §6.4: **the only real bound on a no-query pull is the size of the server
being pulled**, and a separate server is the one boundary a query cannot cross.

**E2 — are server `instructions` always loaded, or deferred with the schemas?**
This decides whether we have a steering channel at all. If the MCP `instructions` string
arrives with the summary, it is the one piece of always-present text we control, and it must
carry the skills catalog (§5) *and* the vocabulary that makes discovery queries land — it
becomes a routing table, not prose. If instructions are deferred too, we have no reliable
first-turn channel and the tool descriptions must do all the work alone. Test by putting a
distinctive sentinel phrase in `instructions` and asking, in a fresh chat, before any tool
call, whether the model can see it.

**E3 — recall: does a plain-language query surface the tool that is actually needed?**
Retrieval recall is now a correctness property, so measure it rather than hope. With the full
candidate surface registered, run a fixed list of ~20 real user phrasings ("fix the typo in
config.ts", "what's on my screen", "why did the build fail") and record, per phrase, whether
the tool a competent agent would need appears in the injected subset. Any phrasing that fails
is a naming or description bug, and it is cheaper to find it here than in a user's session.
Re-run after every rename.

One further measurement, once compaction lands: **does the hydrated tool set survive a native
compact and a resume into a fresh chat?** A resumed conversation that has lost its schemas
pays the discovery turn again, which is tolerable, but a resumed conversation that has lost
them *silently mid-task* is not. Worth knowing before the handoff prompt is finalised.

### 6.4 LIVE TOPOLOGY — two surfaces, 6 + 2

**Decided by the user, 2026-08-17, on the no-query result in §6.3.** This supersedes §6.1.

| surface | connector name | tools | max no-query size |
| --- | --- | --- | --- |
| Core | `ChatGPT Local Files Core` | `read`, `apply_patch`, `exec_command`, `write_stdin`, `session`, `agents` | **6** |
| Desktop | `ChatGPT Local Files Desktop` | `observe`, `computer` | **2** |

`find` does not make Core seven. It is registered **only** when command execution is off,
which is exactly when `exec_command` and `write_stdin` are absent, so the two states are
5 and 6 — never both.

**Why two and not four.** An earlier draft gave `agents` and `session` surfaces of their own.
Rejected by the user, and the reasoning is worth keeping because it is the general rule:

> Split only where there is a meaningful capability/discovery boundary. We are not trying to
> maximise the number of MCP servers. A one-tool connector generally does not earn one.

Every surface costs the user a connector to create, name, describe and keep connected — and
on the OpenAI tunnel a whole extra tunnel id (§6.5). Against that, splitting off a single
already-collapsed flat tool saves one schema from a no-query pull. That trade is plainly bad.

**Why `session` in particular stays on Core** — a concrete technical reason, not symmetry.
`session` carries `save_handoff`, and the app drives that call itself: native compaction
interrupts the live turn and asks *that conversation* to write its brief. If the tool sat on
an optional surface the user had not connected, the app's headline feature would fail at the
one moment it is needed, inside a conversation the user cannot repair without starting over.
A feature the app invokes on the user's behalf cannot depend on an optional connector.

**Why `agents` stays on Core.** It is one flat tool, registered only while multi-agent mode is
on, and that is off by default. A user who never enables it pays nothing for it. Enabling it
takes Core from 5 to 6.

**Why Desktop earns its boundary.** It is gated on `screen`/`control`, which are separate
permissions most users leave off; its two schemas are the heaviest we publish, since `computer`
alone carries eleven action variants; and the large majority of coding sessions never touch the
desktop. Folding it into Core would put that weight into every no-query discovery of the
coding surface, to serve a capability most conversations do not want.

**The invariant is unchanged and is now enforced across servers as well as within one.** Each
surface is a *real* discovery boundary: a no-query `tools/list` against Core must not reveal a
single Desktop schema, and neither server may accept a call for a name it does not advertise.
No cross-surface aliasing, no shared catch-all handler. §9 asserts both directions.

### 6.5 Transport consequence — resolved from the tunnel client, not guessed

Two surfaces means two MCP endpoints. What that costs depends entirely on the connection kind,
and the three answers are very different:

- **cloudflared / manual — free.** One HTTP listener already serves every surface on its own
  token-qualified path, and `cloudflared --url <origin>` publishes the whole origin. One
  tunnel process, one hostname, two connector URLs. Nothing extra to run.
- **OpenAI Secure MCP Tunnel — one tunnel id per surface.** `tunnel-client` genuinely supports
  multiplexing: `--mcp.server-url="channel=main,url=…"` can be repeated, `MCP_SERVER_URL`
  takes newline-separated entries, and the client *"routes commands by channel"*. But the
  ChatGPT end cannot address a channel. Connector setup is *"Select an available tunnel when
  ChatGPT lists it, or paste a valid `tunnel_id`"* — there is no channel field, no URL suffix,
  no header — and connector traffic with an empty channel is *"normalized to `main`"*. So
  extra channels are reachable by Codex and the API and **not** by a ChatGPT connector.

  Therefore: one tunnel id per surface, one `tunnel-client` child per id (the flag
  `--control-plane.tunnel-id` is singular). Not what we would have chosen, but it is what the
  product supports, and the setup UI is built around it rather than pretending otherwise.

The multiplexing finding is recorded rather than used, so nobody re-derives it and assumes we
missed a free lunch. If ChatGPT ever exposes channel selection, one tunnel serves both
surfaces with no change to anything above the tunnel layer.

**Never collapse the surfaces back into one `tools/list` merely to reuse a tunnel.** That
trades the only real bound we have for a saving the user does not feel.

## 7. Migration — a clean break, no legacy surface

**Decided by the user, 2026-08-17: delete the legacy model-facing surface completely.** No
aliases, no dual registration, no one-release grace period, no monotonic legacy exposure.
When the redesign lands, the old 40+ names are gone from both `tools/list` and `tools/call`.
Old conversations break; a connector refresh and a new chat are the supported path.

An earlier draft of this file proposed a shim: `createMcpHandler(factory)` builds a fresh
server per request, and `tools/list` and `tools/call` are different requests, so the legacy
names could have been registered on calls only and hidden from listings. That is
technically sound and is **rejected on purpose** — see §7.1. It is recorded here only so
nobody rediscovers it and mistakes it for an oversight.

What is deleted:

- every registration for the 37 removed names, and every schema, description and
  `describe()` string attached to them;
- the `exposedCaps` / `exposedSessionTools` / `exposedAgentTools` machinery **insofar as it
  exists to keep removed tools alive**. The monotonic rule itself survives for the *new*
  surface, because it solves a different problem (§7.2);
- the `agent_key` injection across unrelated schemas, and `withAgentKey` itself;
- the `TOOL_DISABLED` copy that tells a model to "start a new ChatGPT conversation after
  permission changes if the current conversation still has the old tool list" — reworded,
  not deleted, since it still applies to capability changes.

Backend primitives — `fsops`, `exec`, `process-manager`, `computer`, `agents`, the session
store — are reused unchanged. Nothing in this section is about deleting behaviour; it is
about deleting *names the model can see*.

### 7.1 Why no shim, given one was available

The shim buys continuity for conversations that are, by construction, already stale: they
hold a cached snapshot of a surface we have decided is wrong. Keeping it would mean two
model-facing contracts alive at once, two sets of recorder labels to keep honest, and a
retirement date that would slip. The clean break is also the honest one — a tool that is
gone should be gone, and a loopback server quietly answering names it does not advertise is
a thing we would have to explain forever.

### 7.2 What survives, and why it is not the same thing

Monotonic capability exposure for the **new** surface stays. It exists because permissions
are toggled *mid-conversation* from the desktop app, and removing a tool from under a live
snapshot is what produced the opaque transport-level `UNKNOWN`/TaskGroup failures recorded
in `server.ts`. That is a different problem from surface versioning, and the fix is
unchanged: once a capability has been exposed in this app run, its tool stays registered and
its handler returns a clear `TOOL_DISABLED` refusal while the capability is off.

Capability-conditional registration — `find` appearing only when command execution is off —
is likewise not hiding. The decision is made when the snapshot is built at app start, and
whatever is registered is both listed and callable. That is the invariant, stated once:

> **No hidden callable surface, ever.** Anything callable is listed; anything listed is
> callable. This kills the legacy shim, and it equally kills any future "skill unlocks a
> deferred tool group" design that would smuggle tools past `tools/list`.

That invariant is also the answer to the hidden-tools-vs-skills question (§5, §6): new
capability arrives as a **skill** — data, read on demand, invisible to the tool surface —
never as a tool that exists but is not advertised. If ChatGPT ever ships genuine
client-side deferral, that is the client listing a tool it chose not to load, which does not
violate this rule; a server lying about its own surface does.

### 7.3 Release consequences

- The connector must be refreshed and new chats started. The existing toast in
  `main.ts` already says this; it should fire on first launch after the upgrade, not only
  after a settings change.
- Release notes must call this a **breaking connector change** in the first line. Whether
  that justifies a 1.8.0 version number is a product decision; the user has asked for the
  work to land in the 1.7.1 cycle and nothing technical forces a major bump.
- An in-flight old chat calling a removed name will fail with the SDK's unknown-tool error.
  We do not control how ChatGPT renders that, and our own notes say some clients surface it
  as an opaque transport failure rather than a readable message. That is accepted. Confirm
  during live smoke what the user actually sees; if it is unreadable enough to look like an
  app crash, the fix is a clearer upgrade notice in the desktop app, **not** resurrecting
  the names.
- `toolSurfaceVersion` is still worth an internal constant: it dates recordings and gives
  the diagnostics view something honest to report.

## 8. Recorder and attribution

Attribution is not a reason to keep 45 names, but it is a reason to sequence the work.

**Do the recorder change first, while both surfaces still exist**, so it can be diffed
against real recordings: derive the displayed operation label from structured call metadata
rather than from the raw tool name — `read 3 files`, `exec_command: npm test`,
`observe window`, `agents.spawn`. Existing 1.7.x recordings must keep rendering exactly as
they do now.

**T-91 and the live recorder gate are untouched by this work and remain the gate.** Do not
start the surface change while that is open.

## 9. Tests required

- **Per-surface `tools/list` membership**, asserted exactly, not just counted: Core is
  4 / 5 / 6 across the configurations in §3, Desktop is always 2, and `find` is present only
  when the command capability is off.
- **No cross-surface leakage**, both directions: no Desktop name appears in Core's
  `tools/list` or is accepted by Core's `tools/call`, and vice versa. This is the assertion
  that keeps §6.4's discovery boundary real rather than cosmetic.
- **Worst-case no-query size per surface**, asserted as a number with every capability on, so
  a future tool added to Core fails a test instead of quietly widening the exposure the split
  exists to bound.
- Surface metadata is complete and consistent: every registered name is listed in that
  surface's `tools` array in `surfaces.ts`, and every name in that array is registered under
  some capability configuration.
- `read`: multiple paths, directory listing, glob expansion, a range on a single path, an
  image, a binary refusal with reason, and the expansion caps actually biting.
- `apply_patch`: multi-file atomicity and rollback, CRLF, NUL/control-byte rejection.
- `exec_command` / `write_stdin`: `yield_time_ms` spelled correctly; live `session_id`
  returned only while running; `signal: 'int'` on a tty and on a pipe; `signal: 'kill'`
  terminating a tree.
- `observe`: **never returns `FOCUS_FAILED`**, including for a non-foreground HWND — the
  regression for the live bug. `computer(focus)` failure names the sampled foreground
  window and timestamp.
- Clean break: every removed name is absent from `tools/list` **and** rejected by
  `tools/call`. Assert the whole removed set explicitly, so a stray re-registration during
  the port fails the suite rather than shipping.
- Handoff carries a bounded live-process list; resume restores it.
- no key field in any schema, in either mode; `join_key` present only on `agents`, and only
  as the recovery action's own argument.
- Validation errors are compact: field, value, constraint, corrected example — and no
  schema dump.
- Recorder labels for the new tools, plus unchanged rendering of existing 1.7.x recordings.
