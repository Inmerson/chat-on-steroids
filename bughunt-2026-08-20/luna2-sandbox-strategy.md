# Windows reparse/junction TOCTOU strategy for 1.8.6

**Date:** 2026-08-20  
**Scope:** read-only forensic/design work; no production code, tests, AppData, config, or git state changed.  
**Evidence:** current dirty tree, `00-2026-08-20-1220-CONSOLIDATED-BUGHUNT.md`, and `repro-reparse-toctou.ts`.

## Decision summary

`resolvePath()` is a good canonical/lexical check for the namespace at one instant. It is not an authorization of a later pathname operation. The saved repro resolves `/workspace/gate/secret.txt` to the approved tree, replaces `gate` with a junction to the sibling `outside` tree, and then calls the real read backend with the returned string. The result is `read: "outside\n"`. The model still receives the approved virtual spelling, so this is both a boundary failure and misleading evidence.

The practical 1.8.6 decision should be explicit:

1. Keep the current `realpath` and lexical checks. They reject static escaping links, traversal, native-path tricks, and malformed names and are still valuable.
2. Do not describe them, extra `realpath()` calls, `lstat()` checks, or a normal Node `FileHandle` as closing the concurrent reparse race.
3. Until a handle-relative Windows implementation exists, refuse the high-impact path-based operations on Windows in a strict security profile: `apply_patch` (create/edit/move/delete) and `exec_command` (including its cwd). A compatibility profile may keep them only if the product explicitly says that same-user concurrent namespace mutation is outside its threat model.
4. `read`, `view_image`, and `find` are not automatically safe merely because they are read-only. If the approved-root promise includes confidentiality against a concurrent same-user process, strict mode must refuse those path-based operations too. If usability requires keeping them, label them best effort and treat post-open identity checks as detection, not proof.
5. Full closure for file and directory operations requires a small native Windows layer that anchors traversal and mutation to directory/file handles. `child_process.spawn()` and `node-pty` accept a cwd pathname, not a directory handle; strict mode should continue to deny command execution unless a native launcher proves the required cwd semantics.

This is a security/availability tradeoff, not a claim that the current code is already fixed.

## Threat model

The approved-root boundary is intended to protect against a model-supplied path reaching an unapproved local or mapped-drive location. For this finding, the adversary can change directory entries while a Local Files operation is in flight. That can be:

- the same logged-in user through another process (editor, Git, sync client, script, antivirus/filter interaction, or a separately running tool);
- a model-launched command when `exec_command` is enabled; and
- any process that can rename a checked directory and create a junction/reparse point in its place.

The race does not require a pre-existing malicious link. The attacker waits until validation has returned a path string, renames an ancestor, and installs a junction to an unapproved sibling. A missing parent is an equivalent attack surface: `allowMissing` authorizes a future creation, but the later recursive `mkdir`/open can follow a newly inserted reparse point.

The threat model does not treat the approved folder as immutable. It also does not assume that the model's shell command is sandboxed: `exec_command` is arbitrary code execution as the logged-in user. Its approved cwd is only a starting-directory policy; command text can intentionally open, read, write, delete, or execute anywhere that Windows permits. A secure cwd therefore improves target selection but cannot turn `exec_command` into an OS sandbox.

Static links are a separate, better-covered case. `realpathDeepest()` plus containment rejects an existing link whose canonical destination is outside the root. F1 is the namespace swap after that check and before a later path lookup.

## Current evidence and resolve-then-use map

The authorization object from `src/main/sandbox.ts:252-315` contains only strings (`real`, `virtual`, and `root`). It performs:

1. canonical root lookup;
2. lexical containment of the candidate;
3. `realpathDeepest()` for the deepest existing ancestor;
4. canonical containment of that existing part; and
5. an optional missing-tail check.

Every consumer then hands `resolved.real` to ordinary pathname APIs. The current comments in `sandbox.ts` say canonicalization defeats junctions, but that statement is true only for a static tree at check time.

| Surface | Validation | Later use | Actual guarantee today |
| --- | --- | --- | --- |
| `read` text/file metadata | `resolveIn()` then `statInfo()` | `getMetadata`, `readFileStream`, and repeated path opens in `read-backend.ts`/`filesystem.ts` | Static containment; a file handle protects bytes after its path open, but the initial open and metadata/open sequence can be redirected. |
| `read` directory/glob | `resolveIn()` then directory stat | `readdir`, child `stat`, and bounded walk over joined strings | Static scope only. An ancestor can be replaced before enumeration or a child lookup. |
| `view_image` | `resolveIn()` | `getMetadata()` then `readFile()` by path; decode occurs after the read | Decode and byte limits do not protect the path boundary. A swap before `readFile()` can return an outside image. |
| `find` / content search | `resolveIn()` then scope `stat` | ripgrep receives a string cwd; fallback recursion and file streams receive joined strings | Static scope only. Ripgrep is an external process with no approved-root handle. |
| `apply_patch` update | every hunk is resolved into a string table | verify reads by path, then execution reads/writes by the same strings | Validation-to-write race; an outside target can be edited. |
| `apply_patch` create | `allowMissing` validates deepest existing ancestor | pathname write, then recursive parent creation and a second pathname write | Missing parents and a swapped ancestor can redirect creation outside. |
| `apply_patch` move | source/destination strings are checked | writes destination, then removes source; both are path based | Outside destination write and/or outside source deletion are possible; this is not a handle-relative atomic rename. |
| `apply_patch` delete | metadata/read/`ensureNotDirectory` checks | `lstat` then `unlink`/remove by path | A replaced ancestor or target name can direct deletion elsewhere. |
| `exec_command` cwd | `resolveCwd()` and `fs.stat()` | cwd string passed to `child_process.spawn` or `node-pty` | The child launcher resolves the cwd again. A swap can start it outside the approved object. Command text remains unrestricted regardless. |

The principal call sites are:

- `src/main/mcp/tools-core.ts:375-436` (find), `:1151-1237` and `:1297-1325` (patch), `:1427-1518` (read), and `:315-328` (view_image);
- `src/main/codex/read-backend.ts:142-161,240-325` and `src/main/codex/filesystem.ts:143-208,225-292`;
- `src/main/search.ts:141-170,293-326,436-490`;
- `src/main/mcp/kernel.ts:523-573`, followed by `src/main/codex/unified-exec.ts:277-330,629-641`; and
- `src/main/codex/apply-patch/index.ts:212-370,459-497`.

## Exploit impact by tool

### `read`

For a regular text file, `readOne()` first resolves the path, then calls `statInfo()`. `statInfo()` follows link metadata and scans the file through a path-opened stream. `readTextFile()` then obtains metadata again and opens another path stream. Those are useful bounded reads, but they are not one object-scoped operation. A directory listing similarly enumerates by path and then stats joined child paths.

Impact is confidentiality: bytes, size, timestamps, line counts, or directory names from outside the approved root can be returned under a virtual path inside it. The existing Codex-style `readFileStream()` handle means an ancestor swap after that particular open does not change the already-open file object. It does not secure the path lookup that obtained the handle, nor the preceding/following path-based metadata operations.

### `view_image`

The standalone path is `resolveIn()` -> `viewImage()` -> `getMetadata()` -> `readFile()`. `readFile()` opens a pathname and then reads through the returned handle. A junction swap before that open can make the full outside image enter the MCP response. Sharp/libvips validation, structural checks, decoded-pixel caps, and base64 budgeting happen after the bytes have been selected and therefore do not repair containment.

### `find`

The ripgrep path starts a child with `cwd: realTarget` and asks it to search `.`. The fallback path recursively calls `readdir`, builds child strings, stats/sniffs files, and streams them. A checked directory can be swapped before either search starts or during fallback traversal. Impact is outside filename/content disclosure and misleading virtual result paths. The search result cap limits volume, not which namespace is searched.

### `apply_patch`: create, edit, move, delete

The patch adapter deliberately resolves all hunk spellings up front, then passes a synchronous string resolver into verification and execution. That closes lexical traversal mistakes but creates no object capability.

- **Create/add:** `allowMissing` returns a string for a non-existent tail. `writeFileWithMissingParentRetry()` first writes by path, and on `ENOENT` creates parents recursively by path before trying again. A replaced parent can redirect both `mkdir` and `writeFile`.
- **Edit/update:** verification reads and matches the old content by path. Execution later writes the computed content by path. Replacing the target or an ancestor between those phases can edit an outside file; a same-name outside file can also satisfy a later open.
- **Move:** the current patch runtime writes the destination contents and then removes the source. It is not a single NTFS rename of an already-validated object. The destination parent and source ancestor can race independently, yielding an outside write, outside delete, partial move, or ambiguous delta.
- **Delete:** metadata/read and `ensureNotDirectory()` are advisory checks. `remove()` performs a later `lstat` and `unlink`/`rmdir`/`rm` by pathname. A race can make the final operation address a different object. The post-failure comparison in the patch runtime is evidence bookkeeping, not a security rollback.

The user-visible consequence is integrity loss, potentially outside the intended project, and for deletes/moves possibly destructive loss. A later failure does not imply that earlier hunks were side-effect free.

### `exec_command` cwd

`resolveCwd()` canonicalizes and stats a directory, but the resulting string is passed to `spawn()`/`node-pty`, which asks Windows to resolve the cwd again. A replacement can make the child start in an unapproved directory. That can change relative build outputs, script imports, config discovery, or destructive command targets.

This finding is narrower than claiming that the shell is contained. Even with a perfect cwd handle, `exec_command` can use absolute paths, change directory, create reparse points, or launch another process outside the root. Read-only mode already removes this entire surface when effective command capability is off; a strict reparse profile should keep it off until secure process semantics exist.

## Viable immediate mitigation for 1.8.6

### Recommended policy split

Add a main-process security decision (it need not be model-visible as a new tool) with two explicitly named profiles:

**Strict approved-root profile, Windows without the native helper**

- refuse `apply_patch`, including every create/edit/move/delete hunk;
- refuse `exec_command` and `write_stdin` for commands whose session could have been started by an unsecured cwd;
- if the product promises confidentiality against a concurrent same-user process, also refuse `read`, `view_image`, and `find` because read-only does not remove the race;
- keep the existing static checks and return a generic virtual-path refusal such as “Windows handle-secure filesystem support is unavailable; no operation was performed”; and
- never silently fall back to the first approved root or a guessed path when strict identity/security preconditions are absent.

**Best-effort compatibility profile**

- may retain current path-based reads and search for trusted local workspaces;
- may retain mutations only if the product documents that concurrent namespace mutation by a same-user process is outside the threat model; and
- must say “best effort” in the settings/help surface and forensic logs rather than implying that `realpath` is a capability.

For a security-sensitive release, strict should be the default whenever the helper cannot be loaded. A compatibility opt-in preserves ordinary usability for users who accept the weaker assumption. If product requirements cannot tolerate disabling reads, the weaker profile must be an explicit risk acceptance, not an undocumented fallback.

### Low-risk defenses that are worth shipping, but are not closure

These reduce accidental races and improve detection while the native layer is developed:

1. Keep all lexical and canonical checks at the one sandbox boundary; do not add caller-specific path bypasses.
2. Reject any reparse-point component found during validation in strict compatibility checks. This removes static links and many accidental cases, but an attacker can still swap a normal component after the scan, so do not call this TOCTOU protection.
3. For reads, open once and consume/stat the same file handle where the current API permits. Optionally compare handle file identity and a post-operation canonical check; on mismatch discard the result and return a generic retryable error. A malicious process can still win after the check, so this is detection only.
4. Revalidate root and parent identities around operations and record a security event when they change. Never use that event to claim that a write was undone; mutations need refusal before use or native handle-relative commit.
5. Sanitize all filesystem errors, including `ELOOP`, `EINVAL`, and `ENAMETOOLONG`, so a race cannot disclose a native Windows path. The current `friendlyError()` work is useful defense in depth.
6. Keep read-only mode as the safe default and make command capability a separate explicit permission. Do not treat a model-generated `cd`, PowerShell `-LiteralPath`, a watcher, a retry, or an in-process mutex as an authorization primitive.

### Measures that should not be presented as fixes

An additional `realpath()` immediately before `readFile()`/`writeFile()` still has a gap. `lstat`/`stat` only observes a name. `FILE_FLAG_OPEN_REPARSE_POINT` on one final component does not make ancestor traversal handle-relative. A normal Node `FileHandle` protects the object after open but cannot prove that the initial path open stayed under the approved root. Serializing this app's own operations does not stop another process. Retrying after `ELOOP` or an identity mismatch gives an attacker more attempts. Normal Node `fs.open()` also does not expose the Windows share-mode policy needed to lock every ancestor against rename/delete.

## Longer-term native design

### Native boundary and object model

Introduce a main-process-only `SecureFs` implementation. The public TypeScript object should carry model-visible virtual metadata and an opaque native capability, not an unrestricted `real` string. Keep handles short-lived and close them in `finally`; do not expose raw Windows `HANDLE` values to the renderer, browser page, model, or generic IPC.

A small C++/Rust N-API addon is the natural in-process option. A separately bundled helper executable using a private pipe is also viable and isolates native crashes, at the cost of an RPC protocol and lifecycle. Either way, the helper must expose narrow operations, not arbitrary Win32 calls.

### Secure traversal

1. Open each approved root as a directory handle (`CreateFileW` with directory/back-up semantics) and retain the root object for the operation.
2. Traverse each child component relative to the already-open parent handle. `NtCreateFile` supports an `OBJECT_ATTRIBUTES.RootDirectory` handle and a relative name; this is the important primitive that a concatenated `CreateFileW` path does not provide.
3. In the first implementation, reject reparse-point components rather than trying to support every reparse tag. Open/inspect components with `FILE_OPEN_REPARSE_POINT`/reparse attributes as appropriate, and fail closed for tags, volumes, filesystem types, or share semantics that are not explicitly supported. Allowing internal junctions is possible only after the helper can prove the target object remains within the root by handle, not by a later string.
4. Return a final file or directory handle. Reads, metadata, hashes, image bytes, and line scans must use that handle. Directory enumeration must use a directory-handle API such as `GetFileInformationByHandleEx` with a directory-info class (or an equivalent native query), then open children relative to that handle; do not turn names back into absolute strings for security-sensitive operations.

The official Windows documentation describes `FILE_FLAG_OPEN_REPARSE_POINT` as preventing normal reparse processing for an opened object, but that flag alone is not recursive containment. The security property comes from anchored component-by-component traversal plus a clear reparse policy.

### Mutations and patch transactions

The native layer should provide:

- create/open of a child relative to a validated parent handle, with `CREATE_NEW`/non-follow behavior for adds;
- writes through an already-open target handle or a same-directory temporary handle;
- delete/disposition through the target handle, so deleting a link deletes the link rather than following it;
- rename/replace using `SetFileInformationByHandle(FileRenameInfo)` with a destination `RootDirectory` handle, not `fs.rename()` on two strings; and
- bounded, handle-relative directory creation for missing parents.

`apply_patch` must become one secure operation: preflight expected content through handles, stage all complete replacements under validated parent handles, commit only with handle-relative operations, and abort before any later hunk if a capability cannot be acquired. A best-effort rollback after a path race is not equivalent to a transaction. If a multi-file atomic commit cannot be guaranteed, report partial progress honestly and keep all subsequent paths handle-anchored.

The first secure version should reject recursive directory deletion and reparse-containing trees unless a handle-relative walker has explicit coverage. File create/edit/move/delete can be enabled separately once each operation has a native regression suite.

### Search and image handling

`view_image` can reuse the secure final file handle and pass bytes to the existing decoder. `read` can reuse the same handle for metadata and content, avoiding its current repeated path opens. `find` cannot remain on the ripgrep path if strict containment is required: ripgrep only accepts path/cwd arguments here. Implement a bounded native handle walker/content scanner for strict mode, and keep ripgrep only as an opt-in best-effort optimization.

### Exec cwd policy

`child_process.spawn` and `node-pty` expose only a cwd pathname. A native launcher would need a separately specified and tested policy, for example:

- open and hold the approved directory object while creating the child, with share/rename behavior deliberately chosen;
- use a native `CreateProcess` path/initialization sequence and verify the child's effective directory before releasing any protection; and
- make the result explicit that this establishes a starting directory only, not a sandbox for command text.

If this cannot be proven across the supported Windows filesystems and process modes, keep `exec_command` disabled in strict mode. Do not pass a directory handle through Node's `cwd` option and assume it is supported; it is not.

### Native API caveats

`NtCreateFile` with `RootDirectory` is the strongest documented handle-relative primitive, but user-mode use through `ntdll` is a compatibility commitment. The helper needs Windows-version/filesystem integration tests and a fail-closed startup probe. Win32 handle-based information, enumeration, rename, and disposition APIs are preferable where they cover the operation. A helper that uses only absolute `CreateFileW` plus more `realpath()` calls does not close the finding.

## Required regression and integration tests

All race tests must use a disposable tree under the test workspace, never a configured user root, and clean in `finally`. They must run on Windows/NTFS; Linux tests can cover API shape and strict fallback only.

### Deterministic swap tests

Use a fault-injection barrier immediately after validation and immediately before each path use. The adversarial worker renames `approved/gate`, creates a junction `approved/gate -> outside`, and leaves an outside sentinel. Assert either no outside bytes/mutation or a strict generic refusal.

- **Read text:** swap after `resolvePath`, after metadata, and before stream open. Assert no outside content is returned; a secure handle path may return the original inside bytes.
- **View image/binary/hash:** swap before the final open and during decode preparation. Assert no outside bytes enter the response and no native path appears in the error.
- **Directory/read glob/find:** swap before scope open, between enumeration and child open, and during recursive traversal. Assert no outside names/content and no ripgrep process starts in strict mode.
- **Create:** swap an existing parent before `CREATE_NEW`/parent creation; assert the outside sentinel is absent and the operation fails or writes only inside.
- **Edit/update:** swap the target ancestor after expected-content verification and before commit; assert the outside file is unchanged.
- **Move:** swap destination and source ancestors independently; assert no outside destination is created and no outside source is deleted.
- **Delete:** swap after `ensureNotDirectory`/preflight and before disposition; assert no outside file is deleted.
- **Exec cwd:** swap after cwd validation and before spawn. Strict mode must refuse, or a native launcher must prove the child starts in the originally opened object. The test must not infer safety from a printed path alone.

### Static and lifecycle coverage

Retain existing tests for `..`, native path parity, escaping links, internal links (if still supported), reparse loops, missing parents, and virtual-only errors. Add stress loops that repeatedly rename/junction-swap an ancestor while each operation runs, because a one-shot barrier proves the seam while stress catches an unmodelled path use. Add helper tests for handle closure, helper crash/restart, unsupported filesystem, antivirus/share denial, and no fallback to legacy path I/O after a native error.

The acceptance criterion is not merely “the test did not leak in one run”: for strict mode, every unsupported or ambiguous operation must refuse. For native mode, the race matrix must show either the originally opened object or a refusal, never outside bytes or mutation.

## Packaging and release implications

The current package targets Windows x64 NSIS, runs `asInvoker`, keeps only one native dependency (`node-pty`), uses `npmRebuild: false`, unpacks `node-pty` from asar, and ships real extra resources for the tunnel, extension, and ripgrep. A secure filesystem layer changes those assumptions.

### N-API addon

- Build a Windows x64 N-API prebuild in a Windows CI job against the supported toolchain; do not require end users to have Visual Studio.
- Treat the `.node` binary like `node-pty`: ensure it is unpacked from asar and loaded from the packaged path, with an explicit Electron smoke test.
- Decide signing and update policy for the new native binary. A missing, wrong-architecture, unsigned, or incompatible binary must select strict refusal, not silently restore path-based mutations.
- Add installer/unpacked-directory tests that exercise real handle operations after `dist:dir` and the NSIS install, not only Vitest against source.

### Standalone helper executable

- Ship it as a real `extraResources` file (for example under `resources/sandbox`) rather than inside asar; use a private inherited pipe, not a listening port.
- Version the RPC protocol and perform a startup capability/filesystem probe. If the helper exits or reports unsupported semantics, close the affected tools and surface a retryable refusal.
- Sign and verify the helper as appropriate for the Windows distribution. Do not let the model choose its executable path or arguments.
- Test helper shutdown while operations are in flight; close every native handle in the helper before restart.

Either design adds a Windows-only build/test gate. Packaging the helper is not the same as proving it: release validation must include NTFS junction swaps, mapped-drive behavior if mapped drives remain allowed, x64 architecture, and an installed-build smoke test.

## Explicit residual risk

### Current 1.8.5/1.8.6 path-based implementation

The static sandbox is not a complete containment guarantee. Under the stated threat model, `read`/`view_image`/`find` may disclose outside data; patch create/edit/move/delete may affect outside names; and exec cwd may be redirected before spawn. The current tests establish static junction rejection, not the check-to-use swap. A clean targeted test suite therefore cannot be used as proof of closure.

### After a handle-relative file layer

Residual risks remain even with correct traversal:

- rejecting all reparse points changes behavior for users who intentionally approved trees containing junctions/symlinks;
- NTFS, ReFS, FAT, mapped drives/SMB, sync/filter drivers, and antivirus share semantics may differ; unsupported filesystems must fail closed;
- another same-user process can modify bytes through an already-open handle, so content consistency/last-writer policy still needs explicit checks;
- a privileged process or kernel/file-system filter can defeat user-mode assumptions;
- native helper bugs, crashes, code-signing failures, and handle leaks can reduce availability; fallback must be refusal, not legacy mutation;
- closing a handle ends the object-scoped guarantee, so later model-visible paths must not be treated as capabilities; and
- `exec_command` remains arbitrary user-level code execution. No cwd design prevents a command from intentionally reaching outside the approved root.

The honest release claim after the native work is therefore narrower: “strict file operations are anchored to validated Windows objects and reject unsupported reparse/filesystem cases.” It is not “the model cannot access anything outside an approved folder” while unrestricted `exec_command` remains enabled.

## References

- [Microsoft: `NtCreateFile` and `RootDirectory` relative names](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile)
- [Microsoft: `CreateFile` and `FILE_FLAG_OPEN_REPARSE_POINT`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)
- [Microsoft: reparse points and file operations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations)
- [Microsoft: directory-handle enumeration with `GetFileInformationByHandleEx`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info)
- [Microsoft: handle-relative rename via `FILE_RENAME_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
- [Microsoft: `SetFileInformationByHandle`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
- [Node.js: `FileHandle` and filesystem APIs](https://nodejs.org/api/fs.html)
- [Node.js: child-process `cwd` is a path/URL option](https://nodejs.org/api/child_process.html)
