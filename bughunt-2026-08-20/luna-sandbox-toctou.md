# Windows sandbox reparse/TOCTOU design analysis

Date: 2026-08-20  
Scope: read-only analysis; no production code, tests, or system state changed.

## Conclusion

`resolvePath()` is a correct lexical/canonical containment check for the namespace at the instant it runs, but it is not an authorization of a future pathname operation. On Windows, an attacker who can modify an approved tree can rename a validated directory and install a junction before the later `stat`, open, traversal, spawn, or write. The saved repro proves the concrete consequence: a path resolved inside the approved root is later read from the sibling `outside` tree.

A robust fix cannot be implemented by adding another `realpath()` immediately before each use. It needs object/handle-based operations, or a deliberate fail-closed policy where the operation is refused when the required handle-relative primitive is unavailable. Node 22/Electron 43 exposes `FileHandle` for files, but not Windows `NtCreateFile`/`RootDirectory`, handle-relative directory traversal, `FILE_FLAG_OPEN_REPARSE_POINT` policy control, handle-relative rename/delete, or a process-spawn cwd handle. `O_NOFOLLOW` is not a portable Windows solution (and Node's flag behavior is not a substitute for a Windows reparse-point policy). Therefore a complete closure requires a small native Windows helper (N-API/node-addon or carefully isolated bundled helper), or a narrower mitigation with explicitly residual race risk.

## Evidence and current resolve-then-use map

The repro `bughunt-2026-08-20/repro-reparse-toctou.ts` creates `approved/gate`, resolves `/workspace/gate/secret.txt`, renames `gate`, creates a junction at `gate` to sibling `outside`, and calls the real Codex read backend with the stale `resolved.real`; output is `read:"outside"`. No path leaves the disposable repository tree, but the approved-root boundary is crossed.

The common source of the stale authority is `src/main/sandbox.ts:252-315`: `realpathDeepest()` and containment checks return only `{ real, virtual, root }` strings. The affected consumers are:

* `src/main/mcp/tools-core.ts:322-324` — `view_image`; `:380-402` — `find` scope stat/search; `:1386-1395` — `read` directory/file metadata and walk; `:1431-1493` — `read` image/text.
* `src/main/codex/read-backend.ts:142-158,240-278` and `src/main/codex/filesystem.ts:148-291` — metadata, streams, reads, directory enumeration and path-based mutations.
* `src/main/fsops.ts:104-112,126-184,206-227,364-377,409-449,516-567,600-621,675-729,754-831` — repeated stat/open/read/write/rename/rm sequences. These helpers receive a string, so a caller cannot preserve the object validated by `sandbox.ts`.
* `src/main/search.ts:144-167,289-317,437-480` — ripgrep is spawned with a string `cwd`; fallback traversal, stat, binary sniff and streams use joined strings. A validated directory can be swapped before or during either search path.
* `src/main/mcp/kernel.ts:523-572` and `src/main/mcp/tools-core.ts:506-556` — exec cwd is checked/stat'ed, then passed as `cwd` to `UnifiedExecProcess`.
* `src/main/codex/unified-exec.ts:277-323,636-659` — `node-pty` and `child_process.spawn` receive only a pathname. Both ask Windows to resolve the cwd again.
* `src/main/mcp/tools-core.ts:1170-1214,1293-1349` and `src/main/codex/apply-patch/index.ts:261-295,314-370,465-497` — patch paths are resolved and verified, then later opened/written/moved/deleted by strings. The validation-to-mutation window is especially large; parent creation (`writeFileWithMissingParentRetry`) is itself pathname-based.

`src/main/search.ts` also starts ripgrep with a validated string and cannot make the child inherit a directory handle. `view_image` and all read variants have the same stale-string issue even when they are read-only; confidentiality is not restored by the absence of mutation.

## What is and is not a complete fix

### Complete closure: native handle-relative filesystem layer

The durable architecture is to change the security boundary from `Resolved.real: string` to an operation-scoped capability containing native handles and model-facing virtual metadata. A Windows helper would:

1. Open the approved root and each path component with `CreateFileW`/`NtCreateFile`, requesting directory semantics and rejecting reparse points (or explicitly opening and validating them) while traversing from a root handle.
2. Use `NtCreateFile` with `RootDirectory` (or an equivalent native handle-relative API) for every child component, so a renamed/replaced ancestor cannot redirect the lookup to a junction. `CreateFileW` with a concatenated path alone is insufficient.
3. Return a file handle for final files and a directory handle for directory operations. Read/stat/hash/decode/line scan must operate on that handle; enumeration must use directory-handle APIs rather than `readdir(path)` followed by joined child strings.
4. For mutation, retain the validated parent directory handle and use handle-relative create/open plus `SetFileInformationByHandle`/native disposition and rename operations. Writes should use the already-open file object or an atomic temporary-and-handle-relative-replace protocol. Every create parent must be traversed under the same root handle.
5. Provide a handle-backed search mode, or run a helper that walks/query-reads handles. Passing a path to ripgrep remains racy; it can be retained only as an explicitly weaker optimization with a post-check and refusal policy.
6. For exec, a native process launcher must define what “cwd” means under this threat model. `spawn`/`node-pty` cannot consume a directory handle. The strongest practical policy is to deny `exec_command` for a handle-secure operation unless a native launcher can establish the cwd without a pathname race; a launcher may need to create the process while holding directory locks and verify the child cwd before allowing execution, but that is a separate native subsystem and must be proven, not assumed.

The helper should expose narrow operations (open/read/stat/list/write/rename/delete, and possibly secure process launch), not arbitrary Win32 handles to renderer or model code. Handles must be closed in `finally`, and capability objects must be single-operation/short-lived to avoid leaks. A native test matrix must cover component replacement before child-open, after parent-open, final-file replacement, junction insertion/removal, rename/delete races, and reparse loops.

This is the only option that can claim closure against a concurrent namespace swap for file I/O. It is a meaningful native dependency and packaging task: N-API ABI compatibility, x64 installer resources, crash/handle cleanup, and a fallback decision all need explicit tests.

### Complete only with a restrictive policy: lock or refuse

Windows directory handles opened with a share mode that denies delete/rename can prevent an ancestor replacement while the operation runs. However, Node's normal `fs.open` does not let this app select the needed share mode, and locking every ancestor can conflict with Explorer, editors, antivirus, Git, and the app's own writes. It is not an acceptable universal fix unless implemented and measured in the native helper. Oplocks are notifications/cache hints, not an authorization barrier.

If the helper is unavailable or cannot acquire the needed locks, refusing the sensitive operation is robust. In particular, refusing `exec_command` and path-based patch mutation under a “secure sandbox” mode is preferable to claiming containment that cannot be maintained. A product may offer an explicit “best effort legacy mode,” but its UI and model-facing errors must label that it does not protect against concurrent reparse swaps.

### Narrow race-window reductions (not closure)

The following are useful defense-in-depth but must not be described as fixes:

* `realpath`/containment revalidation immediately before and after each operation;
* `lstat`/`stat` checks for reparse attributes, `GetFinalPathNameByHandle` comparison after opening, or comparing file identity before/after read;
* holding a normal `FileHandle` after `fs.open` and reading through it (this protects that opened file object, but the initial path open and any parent lookup can still be raced; it does not secure directory enumeration or writes by pathname);
* replacing `readdir(path)` with `opendir(path)` while retaining path-based child opens;
* using `O_NOFOLLOW`/`FILE_FLAG_OPEN_REPARSE_POINT` on one final component. These can reject some static symlinks/junctions, but do not provide recursive handle-relative traversal or protect an ancestor lookup performed by a later path operation;
* serializing this app's own sandbox operations. It prevents internal swaps but not an external process, another app, or a model-launched command from changing the namespace;
* retrying on `ELOOP`, `ERROR_CANT_RESOLVE_FILENAME`, or identity mismatch. Retry can reduce accidental failures but can also hand the attacker more attempts.

Revalidation is still worth adding as an interim signal: after a handle-backed file read, compare volume/file identity and final path where available; on mismatch discard the result and report a generic retryable sandbox error. It is a detection/response layer, not proof that the bytes were always inside the approved namespace.

## Recommended phased plan

### Phase 0: fail closed and make the boundary explicit

Introduce an internal `SandboxCapability`/`SecurePath` type and stop passing unconstrained `real` strings across new APIs. Add a feature probe at startup for the native helper. Until secure primitives exist:

* keep ordinary read/view_image/find only as “best effort” and add immediate pre/post identity checks where feasible;
* refuse `apply_patch` mutations and `exec_command` when a secure handle-backed path cannot be obtained (especially omitted/relative cwd);
* do not claim that `realpath` alone protects against reparse races;
* sanitize all native path errors, including `ELOOP`, so a refusal cannot disclose the host path.

This phase is a behavior/security decision, not a TOCTOU closure. It prevents the highest-impact wrong-target execution/mutation while preserving a documented read-only compatibility option.

### Phase 1: native secure file and directory operations

Add a small main-process-only native module with handle-relative open/traversal, file read/stat, directory enumeration, and atomic mutation. Adapt `read-backend`, `view-image`, `find` fallback, and `fsops` first. Change `tools-core` to acquire one capability per operation and pass it down, rather than resolving once and passing strings. Keep ripgrep as an opt-in optimization only when its path-based race is acceptable; otherwise use the secure walker.

### Phase 2: patch transaction

Make patch verification and execution one transaction over secure capabilities. Resolve every hunk to a parent/file handle, re-check expected content through that handle, stage data inside the same approved directory, and perform handle-relative replace/rename/delete. If any capability becomes invalid or identity changes, abort without later path fallback. Add negative tests for swaps at every validation/execution seam.

### Phase 3: command/search process policy

Decide whether a native secure process launcher is worth its maintenance cost. If yes, prove cwd and executable resolution semantics with Windows integration tests and use it for both PTY and non-PTY paths. If no, keep `exec_command` refused under strict sandbox mode and document that ripgrep/child processes cannot be made handle-relative by Node's current APIs. Search can use the secure walker; process-backed search remains best effort only.

## Negative tests required

Tests must orchestrate an actual namespace swap, not merely pre-place a junction before `resolvePath()`:

* read text: pause after resolution/open preparation, replace an ancestor with a junction to a disposable sibling, assert no outside bytes are returned;
* view_image and binary/hash paths: same swap, assert refusal or bytes from the originally opened file object;
* directory read/find: swap before child enumeration and between enumeration and child open; assert no outside entries/content and no outside process cwd;
* exec: swap after cwd validation and before spawn; strict mode must refuse, or the native launcher must prove the child cwd remains the approved object;
* apply_patch: swap before verification, between verification and write, during missing-parent creation, and during move/delete; assert no outside mutation and transactional failure;
* final-file replacement: replace the target with a junction/file after parent validation; assert handle identity or refusal;
* symlink/junction loops and access errors: assert model-visible errors contain virtual paths only;
* stress loops with a separate disposable worker repeatedly rename/junction-swap ancestors while each operation runs, recording any outside sentinel read/write.

Tests should run on Windows in CI/device validation; Linux tests can cover API shape and fallback behavior but cannot establish NTFS reparse semantics. Every test must clean a repo-contained temp tree in `finally` and never touch user roots.

## Residual risk and decision

The current `realpath` checks remain valuable against static escapes and should stay. They do not close F1. A normal Node `FileHandle` protects a file after it has been opened, but Node cannot safely perform the required Windows root-handle traversal or pass a directory handle as `cwd` to `spawn`/`node-pty`. Therefore the honest choices are: ship a native handle-relative layer and claim closure for the covered operations; or refuse operations whose security contract requires it and label remaining path-based reads/search as best effort. Revalidation, no-follow flags, locks unavailable through Node, and extra `realpath` calls are narrower reductions only.
