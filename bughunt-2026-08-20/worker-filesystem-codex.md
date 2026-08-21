# Filesystem / Codex Tool Bug Hunt — 2026-08-20

Scope: current dirty tree in `C:\Users\totec\chatgpt-local-files`; audit only, no production fixes.

## Chronological tool-call error log

- 11:52 local — `exec_command` repo-wide `rg` probe returned exit code 1 after useful matches because I included both `test` and nonexistent `tests` paths and suppressed stderr. **Classification: my misuse**, not a connector/runtime finding.
- 11:54 local — `read` of virtual `/totec/chatgpt-local-files/src/../package.json` returned `Path traversal ("..") is not allowed`. **Classification: expected behavior** and the control half of Finding F1.
- 11:55 local — `agents action=message to="prime"` failed with `WORKER_IDENTITY_LOST` even though this conversation was opened as the replacement worker in an active run. **Classification: connector bug** (agent/request-correlation identity failure). It prevented the required early prime notification; I will retry once after further tool activity and preserve the finding locally regardless.
- 12:00 local — second `agents action=message to="prime"` retry again failed with the same `WORKER_IDENTITY_LOST` after multiple intervening Core calls. **Classification: connector bug**, persistent rather than a one-tick correlation delay. I will not spam retries; the final worker report remains the durable handoff.
- 12:03 local — `read` included guessed `src/main/codex/unified-exec-output.ts`, which does not exist; the other requested source files read normally. **Classification: my misuse** (bad filename guess), not a connector bug.
- 12:05 local — `npx vitest run bughunt-2026-08-20/repro-view-image-gap.test.ts` exited 1 with `No test files found` because repo Vitest config includes only `test/**/*.test.ts`. **Classification: my misuse** (test placed outside configured include), not a connector bug. I kept malformed-image proof away from the live MCP image-content path on purpose.
- 12:06 local — combined `exec_command` that copied the scratch repro under `test/`, ran Vitest, then removed it was blocked with `couldn't determine the safety status of the request`. **Classification: expected platform/tool safety behavior**, not evidence about this connector's filesystem implementation. I switched to a standalone in-process repro instead of trying to evade the block.
- 12:10 local — `read` requested line ranges for two source files in one call and correctly returned `INVALID_ARGUMENT: start_line/end_line apply to one file`. **Classification: my misuse**; the tool enforced its documented range constraint.
- 12:14 local — `rg` ownership search exited 1 because I passed the literal Windows-incompatible argument `test/**/*.test.ts`; useful matches from the explicit files still returned. **Classification: my misuse** (shell glob spelling), not a connector bug.

## Findings

### F1 — MEDIUM — native Windows normalization erases `..`, bypassing the sandbox's explicit traversal-rejection invariant

**Refs:** `src/main/sandbox.ts:77-83, 218-230, 244-268`; regression coverage `test/sandbox.test.ts:100-126, 364-395`.

**Reproduction against the currently installed live Core tool:**

1. `read({ paths: ["C:\\Users\\totec\\chatgpt-local-files\\src\\..\\package.json"], start_line: 1, end_line: 8 })` succeeds and canonicalizes to `/totec/chatgpt-local-files/package.json`.
2. The equivalent virtual spelling `read({ paths: ["/totec/chatgpt-local-files/src/../package.json"], ... })` is refused with `Path traversal ("..") is not allowed`.

**Observed vs expected:** native input is first passed through `path.resolve()` at `sandbox.ts:220`, which removes `..` before the path is converted to virtual form and before `splitVirtualPath()` / `checkSegment()` can enforce the unconditional traversal rule. Virtual input reaches `checkSegment()` intact and is refused. The code comments and tests explicitly state that `..` is rejected even when it would remain inside the root, but native paths do not obey that invariant.

**Likely root cause:** `normaliseNativePath()` performs lexical canonicalization (`path.resolve`) too early. This does not by itself demonstrate an escape outside the approved root because the normalized result is still checked for root containment and then canonicalized through `realpath`; it is nevertheless a security-boundary inconsistency and violates the stated requirement that native acceptance feed into the exact same traversal/canonical containment checks.

**Missing tests:** native `..` inside-root, native `..` outside-and-back-inside, native `..` with `allowMissing`, and parity assertions that native and virtual spellings receive the same traversal refusal.

### F2 — HIGH correctness / MEDIUM security-boundary relevance — intercepted `cd missing && apply_patch` executes anyway and creates the missing workdir

**Refs:** `src/main/mcp/tools-core.ts:1139-1151` (adapter resolves extracted `args.workdir` with `allowMissing: true`), `src/main/codex/apply-patch/index.ts:216-224,356-371` (Add File retries ENOENT by recursively creating parents), existing false-confidence coverage `test/mcp.test.ts:1856-1875` (tests only an existing `cd nested`).

**Safe live reproduction:** from repo workdir, first verified `bughunt-2026-08-20\\proof-intercept-missing` did not exist. Then called `exec_command` with:

```text
cd bughunt-2026-08-20/proof-intercept-missing && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: landed.txt
+intercept-missing-proof
*** End Patch
PATCH
```

The command returned `Exit code: 0` / `Success... A landed.txt`. A follow-up `Test-Path` showed the formerly missing directory and `landed.txt` now exist with the requested content.

**Observed vs expected:** the explicit shell sequencing says “change into this directory, and only if that succeeds run apply_patch”. Since the directory was absent, ordinary shell execution must stop at `cd` and not mutate anything. The interception path instead treats the missing directory as a valid future patch base, and the Add File runtime creates it recursively.

**Likely root cause:** connector glue at `tools-core.ts:1146` uses `resolveIn(... allowMissing: true)` for the extracted `cd` target and never stats it as an existing directory before executing the intercepted patch. This is independent of sandbox escape: the eventual path remains under the approved root, but the adapter executes a mutation that the submitted command would never have reached. The ported verifier itself does not require an Add File cwd to exist, and its write path intentionally creates missing parents.

**Missing tests:** intercepted `cd` to nonexistent path, `cd` to a regular file, `cd` through an escaping reparse point, and a control proving interception preserves the shell's `cd &&` gate before any mutation. Current test coverage only proves rebasing happens exactly once when the directory already exists.

### F3 — HIGH reliability — `view_image` still accepts deeply invalid WebP/JPEG/GIF payloads without a real decoder, so a successful MCP image block can still kill the ChatGPT message stream

**Refs:** `src/main/codex/view-image.ts:10-23,102-213,327-384`; current tests `test/codex-view-image-parity.test.ts:185-230`. The implementation itself explicitly documents at lines 14-19 that JPEG/GIF/WebP use structural/payload heuristics rather than Codex's real `image::load_from_memory` decode, and that undecodable successful image content can break the message stream.

**Safe reproduction (no malformed image was sent through MCP):** `bughunt-2026-08-20/repro-view-image-gap.test.ts` constructs a 30-byte RIFF/WebP with a ten-byte VP8 payload containing only the minimum plausible key-frame marker/dimensions and invokes `viewImage()` directly under `vite-node`. Current result was `{"accepted":true,"mimeType":"image/webp","bytes":30}`. The gate checks a VP8 key-frame marker and nonzero dimensions, not the compressed VP8 bitstream.

**Observed vs expected:** current public Codex fully decodes image bytes before returning them; this port only fully validates PNG. A framed file can therefore be accepted as `image/webp` even though no decoder has proved it has pixels. The source comments record this exact class as turn-fatal when bad image bytes reach ChatGPT.

**Likely root cause:** avoiding a decoder dependency while reproducing `image::load_from_memory`; `hasImagePayload()` is necessarily only a heuristic for WebP/JPEG/GIF.

**Missing tests:** fixtures with valid container framing and plausible headers but invalid entropy/LZW/VP8 payloads. Existing WebP "garbage" coverage only exercises obviously malformed headers and therefore gives false confidence about decode parity.

### F4 — HIGH security — canonical containment is TOCTOU: swapping a validated directory to a junction lets later pathname-based I/O escape the approved root

**Refs:** `src/main/sandbox.ts:277-300` canonicalizes/checks once and returns a string `real` path; `src/main/mcp/tools-core.ts:1394-1460` (`read`) resolves then later stats/opens that pathname; the same resolve-then-use pattern exists at `tools-core.ts:322` (`view_image`), `380` (`find`), exec via `kernel.ts:524-552` then process spawn, and patch verification/execution at `tools-core.ts:1157-1177` plus `codex/apply-patch/index.ts:216-295`.

**Deterministic safe reproduction:** `bughunt-2026-08-20/repro-reparse-toctou.ts` creates a custom approved root and a sibling "outside" directory, both physically under this repo. It resolves `/workspace/gate/secret.txt` while `gate` is a normal directory, renames `gate`, replaces it with a junction to the sibling outside directory, then calls the same Codex read backend on the previously returned `resolved.real`. Output:

```text
{"resolved":"/workspace/gate/secret.txt","staleReal":"...\\approved\\gate\\secret.txt","read":"outside"}
```

No path in the repro leaves `C:\\Users\\totec\\chatgpt-local-files`; "outside" is only outside the custom sandbox root.

**Observed vs expected:** initial `realpath` containment correctly rejects a reparse point that already escapes. It does not bind later I/O to the object that was validated. Any writable ancestor can be renamed/replaced between the check and the later stat/open/spawn/write, and Windows resolves the stale string through the new junction. That turns an approved-root pathname into an outside-root operation after validation.

**Root cause:** check/use are separate pathname operations. Canonicalization defeats static junctions but cannot defeat concurrent namespace mutation. `apply_patch` has an especially large validation→mutation window because every hunk is resolved/verified before execution; `exec_command` similarly resolves/stats cwd before spawning by string path.

**Missing tests:** adversarial reparse swaps between resolution and file open for read/view_image, between cwd validation and process spawn, between find scope validation and traversal, and between patch verification and write/move/delete. Current reparse tests only cover links already present before `resolvePath()` and therefore do not exercise the race.

### F5 — MEDIUM information disclosure — uncommon canonicalization errors leak the real Windows sandbox path verbatim

**Refs:** `src/main/sandbox.ts:147-164` rethrows `realpath()` errors other than `ENOENT`/`ENOTDIR`; `src/main/mcp/kernel.ts:119-129` promises model-facing errors "without ever exposing real paths" but only rewrites a small errno allowlist and otherwise returns `err.message`; callers include read (`tools-core.ts:283`), view_image/find through `guard`, exec cwd through `guard`, and patch resolution (`tools-core.ts:1148,1159`).

**Safe reproduction:** `bughunt-2026-08-20/repro-error-path-leak.ts` creates a self-referential junction under a custom approved directory inside this repo, calls `resolvePath()`, then feeds the thrown error through the exact `friendlyError()` used by tools. Result:

```text
{"code":"ELOOP","raw":"ELOOP: too many symbolic links encountered, realpath 'C:\\Users\\totec\\chatgpt-local-files\\...\\approved\\loop\\file.txt'","friendly":"ELOOP: too many symbolic links encountered, realpath 'C:\\Users\\totec\\chatgpt-local-files\\...\\approved\\loop\\file.txt'"}
```

**Observed vs expected:** an ordinary static escaping junction returns the safe generic sandbox refusal, but a reparse loop produces `ELOOP`; because that errno is not sanitized, the model receives the host path that virtual paths are specifically meant to hide.

**Likely root cause:** `friendlyError()` sanitizes common operational errors by errno but treats unknown filesystem errors as safe generic exceptions. `realpath()` embeds its path in several such error classes (`ELOOP` is a concrete proof; `EINVAL`/`ENAMETOOLONG` are adjacent risks).

**Missing tests:** model-visible error assertions for ELOOP/reparse cycles and other non-allowlisted fs errno values across read/view_image/find/exec workdir/apply_patch. Tests should assert no approved-root native prefix occurs in any failure text.

### F6 — HIGH reliability / output-contract violation — `read`'s image path bypasses its 512 KiB whole-call and per-file byte caps

**Refs:** `src/main/mcp/tools-core.ts:192-215` advertises `MAX_READ_BYTES` as the whole-call cap and `max_bytes` as a per-file cap; `fsops.ts:15-19` defines `MAX_READ_BYTES = 512 KiB` versus `MAX_IMAGE_BYTES = 8 MiB`; `tools-core.ts:257-276` tracks a 512 KiB `remaining` budget, but `readOne()`'s image branch at `1434-1446` calls `viewImage()` without `options.maxBytes` and returns the entire image up to 8 MiB. The returned MCP image block base64-expands those bytes by roughly 4/3.

**Observed vs expected:** text and directory results honor the `remaining` budget. A single image can return up to 8 MiB of raw image data (~10.7 MiB base64) from `read`, despite the model-visible contract saying output is capped at 512 KiB for the whole call and even if the caller explicitly passed a smaller `max_bytes`.

**Root cause:** the read-image convenience path delegates to the standalone Codex `view_image` loader, whose 8 MiB transport ceiling is appropriate for that explicit tool, but never clamps/declines against `read`'s separate output budget before constructing the image content block. Subtracting `image.bytes` from `remaining` happens only after the oversized payload has already been created.

**Missing tests:** `read` of a valid image just above 512 KiB, `read(... max_bytes: small)` of an image, and an assertion on encoded MCP response size. Existing read cap tests are text-centric and do not cover content blocks.

### F7 — HIGH cross-chat integrity/privacy — exec-session ownership deliberately fails open whenever request correlation is unresolved

**Refs:** `src/main/codex/ownership.ts:10-14,33-58`; `src/main/mcp/tools-core.ts:561-564,600-608,705-724`; existing test `test/mcp.test.ts:2066-2157` explicitly asserts that an unproven caller can write to another chat's known session (`2130-2138`).

**Observed behavior:** `execOwnershipDenied()` returns false if the asking conversation is unknown, and also returns false if the session owner was never recorded. `session status` filters the global process manager with that same predicate, so an unresolved caller is shown every live process ID/command. It can then call `write_stdin` against those IDs. If the original `exec_command` itself ran while identity was unresolved, `noteExecOwner(..., null)` stores nothing, meaning even a later *proven different conversation* is allowed because there is no owner to disagree with.

**Why this is material now:** this worker twice received live `WORKER_IDENTITY_LOST` from the agents surface, proving request/conversation attribution failures are not hypothetical in the current connector. The exec ownership code comments acknowledge correlation is not always resolved. Random process IDs do not protect the fail-open case because an unresolved `session status` enumerates them.

**Expected:** a conversation that cannot be proven to own a terminal should not be able to enumerate, write to, or interrupt it. Codex avoids this class structurally by using a separate process manager per conversation (`ownership.ts:4-8`).

**Likely root cause:** one global manager was adapted with a one-sided "deny only when both identities are known and different" policy to preserve usability during correlation lag. That choice converts identity failure into authorization bypass rather than a temporary inability to interact.

**Missing tests / false confidence:** current test treats `unproven -> write succeeds` as desired behavior and does not test `session status` for an unknown caller or a session created with no owner followed by access from a proven stranger. A secure regression should cover both and fail closed (or bind unresolved sessions to an unforgeable transport/run identity until conversation correlation arrives).

### F8 — HIGH wrong-target mutation/execution — failed workspace identity silently falls back to the first approved root for omitted exec cwd and relative apply_patch

**Refs:** `src/main/mcp/kernel.ts:366-380` waits for identity only while a swarm is active, then continues even if the wait resolves null; `kernel.ts:438-457` marks omitted exec workdir and every apply_patch identity-sensitive; `kernel.ts:539-551` resolves omitted exec workdir as `currentWorkspace() ?? first root`; `src/main/mcp/tools-core.ts:474-479` independently picks `currentWorkspace()?.virtual ?? first root` as apply_patch base. `resolveIn()` itself is safer for a relative path with no workspace and would refuse it (`kernel.ts:487-520`), but these two callers manufacture a first-root base before that refusal can happen.

**Observed/expected:** the exec tool spec says omitted `workdir` means the turn cwd. If exact request-id attribution never arrives, there is no proven turn cwd. Current code substitutes the first approved root and runs anyway. Relative apply_patch hunks do the same and Add File semantics can create new files there. In a broad approved root (for example a user profile containing several projects), an identity outage becomes a wrong-project command or mutation instead of a retryable refusal.

**Why this is not theoretical:** both early `agents message` calls in this worker failed `WORKER_IDENTITY_LOST`, so the current active swarm is demonstrably capable of exhausting/failing identity attribution. The dispatcher comments themselves cite a prior live worker identity delay of ~8 seconds (`kernel.ts:375-377`).

**Likely root cause:** pre-workspace legacy fallback behavior was retained for convenience, while the surrounding workspace code evolved to treat ambiguity as something that should "cost a retry rather than reaching the wrong file" (`kernel.ts:496-500`). Exec/apply_patch are now exceptions to that safety claim.

**Missing tests:** swarm-active request whose request-id never correlates, omitted exec workdir after another chat has learned a different project, and relative Add File patch under unresolved identity. The expected regression should be refusal/no mutation, not first-root fallback. Also test absolute/native patch hunks separately so a self-contained absolute patch does not unnecessarily pay the identity wait.

### F9 — HIGH reliability / schema-return mismatch — exec/write_stdin structured output bypasses the default/policy truncation applied to model-visible text

**Refs:** `src/main/codex/unified-exec.ts:505-553`; `src/main/codex/unified-exec-constants.ts:14-15,59-62`; MCP handlers return both forms at `src/main/mcp/tools-core.ts:574-577,626-629`. `execCommandResponseText()` calls `modelOutputMaxTokens()` and therefore applies the default/policy cap. `execCommandStructuredOutput()` instead returns the entire retained `rawOutput` whenever `maxOutputTokens` is undefined, and when it is supplied calls `truncatedOutput(output, output.maxOutputTokens)` directly rather than the policy-capped value.

**Safe direct repro:** `bughunt-2026-08-20/repro-exec-structured-cap.ts` constructs a 240,000-character `ExecCommandToolOutput` with the normal 10,000-token truncation policy and no explicit max. Running it under `vite-node` produced:

```text
{"rawChars":240000,"modelTextChars":40208,"structuredDefaultChars":240000,"structuredExplicitHugeChars":240000,"modelTextWarnsTruncated":true,"structuredDefaultWarnsTruncated":false}
```

**Observed vs expected:** the same tool result serializes one ~40k-character truncated representation in `content` and a 240k-character untruncated representation in `structuredContent.output`. This defeats the advertised default output budget on the MCP wire, duplicates much more data than the model-facing text path intended, and applies equally to `write_stdin`. The collection layer can retain up to 1 MiB, so the practical bypass is substantially larger than this proof fixture.

**Likely root cause:** the port copied Codex's code-mode structured form but the MCP adapter simultaneously emits both text and structured forms. The structured helper treats `undefined` as "do not truncate" instead of "use the default", and explicit values are not passed through `modelOutputMaxTokens()`.

**Missing tests / false confidence:** existing MCP tests assert schema keys and tiny output only (`test/mcp.test.ts:1908-1975`), not parity between `content` and `structuredContent` under default, explicit-small, explicit-huge, 1 MiB collection-cap, or write_stdin cases.

### F10 — HIGH transport reliability — standalone `view_image` serializes the same base64 image twice, so its nominal 8 MiB image ceiling can produce >21 MiB of base64 payload

**Refs:** `src/main/mcp/tools-core.ts:168-177,322-329`; `src/main/codex/view-image.ts:21-23,46-47,377-383`; current MCP test `test/mcp.test.ts:834-857` explicitly expects both representations. The handler returns the bytes once as MCP `content: [{type:"image", data:<base64>}]` and again inside `structuredContent.image_url = data:application/octet-stream;base64,<same base64>`.

**Observed from code path:** `MAX_VIEW_IMAGE_BYTES` is 8 MiB. Base64 of an 8 MiB file is 11,184,812 characters. Returning the same base64 in both content and structured content therefore places at least 22,369,624 base64 characters (~21.33 MiB) on the result before JSON/content metadata. The module comment says the 8 MiB ceiling exists specifically because a huge base64 content block could take the connector down, but the MCP adaptation doubles that representation.

**Expected:** one canonical binary/image representation on the wire, or a substantially lower raw-byte ceiling that accounts for every serialized copy. If the output schema requires `image_url`, the adapter needs a design that does not simultaneously duplicate the complete image in a second field or must budget for both.

**Likely root cause:** Codex's structured `image_url` result and MCP's native image content were both preserved during transport adaptation. Each is defensible alone; emitting both turns an 8 MiB raw ceiling into >21 MiB of encoded payload.

**Missing tests / false confidence:** current test only proves both fields exist for a 1x1 PNG. There is no response-size assertion near the image limit, no transport/body stress test for the doubled representation, and no check that the chosen ceiling is based on encoded wire size rather than source bytes.

## Existing regression-suite result

Ran the current filesystem/Codex/MCP slices without changing production code:

```text
npx vitest run test/sandbox.test.ts test/workspace.test.ts test/codex-runtime-parity.test.ts test/codex-apply-patch-parity.test.ts test/codex-view-image-parity.test.ts test/mcp.test.ts --reporter=dot

Test Files  6 passed (6)
Tests       230 passed | 1 skipped (231)
Duration    28.07s
```

This is important false-confidence evidence: all ten findings above coexist with a fully green targeted regression suite. The suite is strong on static symlink containment, ordinary virtual traversal, normal native-path happy cases, small command output, existing-directory patch interception, and shallow malformed-image fixtures; it does not exercise the adversarial races, native traversal parity, unresolved-identity authorization, missing intercepted cwd, image/read wire budgets, or duplicate/uncapped structured serialization described above.

## Surface coverage / things that held up

- Audited every current model-facing Core path input: `read.paths`, `view_image.path`, `find.path`, `apply_patch` hunk paths plus intercepted shell `cd`, and `exec_command.workdir`. `write_stdin` has no filesystem path but its session ownership/output behavior was audited because it is the continuation half of exec.
- Static existing symlink/junction escape detection in `resolvePath()` is materially good: canonical existing ancestors are checked against the canonical approved root, and the read glob walker uses `followDirectorySymlinks: false`.
- `find` does not appear to follow static directory symlinks in either backend: the manual walk ignores symlink Dirents and the ripgrep path does not pass `--follow`/`-L`.
- Ordinary virtual `..` is rejected before normalization, including relative workspace paths. The regression is specifically the native-Windows pre-normalization path in F1.
- `exec_command`/`write_stdin` targeted runtime tests cover exit-code preservation, output draining, UTF-8 PowerShell output, termination races and Windows Ctrl-C process-tree behavior; no additional concrete PTY/runtime failure was reproduced in this pass.

## Severity-ranked summary

1. **F4 — HIGH security:** resolve/canonicalize then reopen by pathname leaves a Windows junction/reparse TOCTOU that can redirect validated reads, searches, cwd spawns, image loads or patch mutations outside an approved root after validation. Deterministically reproduced against the actual sandbox + Codex read backend with a safe custom root.
2. **F7 — HIGH cross-chat integrity/privacy:** terminal ownership fails open on unresolved correlation; unknown callers can enumerate global live session IDs/commands and write to sessions, and sessions opened while identity is unknown remain effectively ownerless. Existing tests currently codify part of the bypass as desired behavior.
3. **F8 — HIGH wrong-target mutation/execution:** when workspace identity never resolves, omitted exec cwd and relative apply_patch silently fall back to the first approved root instead of refusing, so an attribution outage can run/mutate the wrong project.
4. **F2 — HIGH correctness:** intercepted `cd missing && apply_patch` ignores the shell's failed-`cd` gate and creates the missing cwd. Live reproduced, then proof artifact cleaned.
5. **F3 — HIGH reliability/parity:** JPEG/GIF/WebP `view_image` still lacks Codex's real decode gate; a plausible-but-invalid VP8 payload is accepted, retaining a known message-stream-killing class.
6. **F6 — HIGH output-contract:** `read` image results bypass the advertised 512 KiB whole-call/per-file cap and can return the standalone 8 MiB image allowance instead.
7. **F9 — HIGH output/schema:** exec/write_stdin text output is policy-truncated while `structuredContent.output` can carry the full retained buffer; direct 240k-character repro showed ~40k text vs 240k structured output.
8. **F10 — HIGH transport reliability:** standalone view_image duplicates full base64 into both MCP image content and structured `image_url`; an 8 MiB source can create >21 MiB of base64 before JSON overhead.
9. **F1 — MEDIUM sandbox-invariant mismatch:** native `path.resolve()` removes `..` before segment validation, so native and virtual spellings of the same traversing path get different security decisions.
10. **F5 — MEDIUM information disclosure:** ELOOP and adjacent unhandled filesystem errors fall through `friendlyError()` with raw `C:\\...` host paths despite the explicit no-real-path contract.

## Unresolved gaps / next adversarial tests

- I proved the reparse TOCTOU through `resolvePath()` + the real Codex read backend, but deliberately did not race each live MCP tool against a path outside the user's approved repo. High-value follow-ups are deterministic test seams between validation and use for `view_image`, `find`, `exec` spawn, and every patch mutation kind (add/update/delete/move).
- Extended Windows namespace spellings (`\\?\\C:\\...`, `\\?\\UNC\\...`), DOS 8.3 aliases, volume mount points and case/normalization aliases deserve explicit acceptance/refusal tests. The current native-path detector only recognizes drive-letter absolute paths and ordinary UNC syntax; I did not claim a bypass without a safe reproducible case.
- `allowMissing` should be stressed with junction creation/replacement in missing ancestors between deepest-existing-parent validation and write. F4 proves the general namespace-race primitive, but individual create/move semantics may expose larger windows.
- I did not send intentionally malformed JPEG/GIF/WebP through the live MCP `image` content path because the source and prior regression comments identify that as capable of killing the chat turn. The direct loader repro is sufficient to prove acceptance without risking the active run.
- I did not return a near-8-MiB valid image through live `read`/`view_image`; F6/F10 are deterministic from the byte constants and serialization code, and a live stress payload would add transport risk without improving root-cause confidence.
- Recorded `session history` accepts an explicit `session_id` without checking caller conversation ownership. The tool description also says it can work with "previous sessions", so whether cross-chat history access is a bug or an intentional same-user feature needs a product-level access-policy decision; I did not misclassify it as a finding.
- The current worker identity path itself remains unhealthy in this conversation: both required early prime-message attempts failed `WORKER_IDENTITY_LOST`. That failure is logged above and materially strengthens F7/F8, but deeper extension/correlation root cause belongs to the dedicated transcript/MCP workers rather than this filesystem/Codex scope.

## Reproduction artifacts retained for prime

- `bughunt-2026-08-20/repro-view-image-gap.test.ts` — direct invalid-WebP acceptance proof; deletes its temporary image.
- `bughunt-2026-08-20/repro-reparse-toctou.ts` — deterministic custom-root junction swap proof; deletes its temporary tree.
- `bughunt-2026-08-20/repro-error-path-leak.ts` — ELOOP/native-path disclosure proof; deletes its temporary tree.
- `bughunt-2026-08-20/repro-exec-structured-cap.ts` — structured-output truncation bypass proof; no filesystem mutation.

No production source fix was made by this worker.
