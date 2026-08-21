# 1.8.6 Windows packaging audit: sharp/libvips and NSIS

Date: 2026-08-20 (Europe/Berlin)  
Scope: read-only audit of the current working tree, installed dependency tree, existing unpacked release, and packaging configuration. The only file changed for this audit is this report. No production source, tests, package manifests, AppData, or Git state were changed.

## Verdict

The tree is **not ready to publish as 1.8.6**. The primary blocker is the current manifest/lock/build mismatch:

- `src/main/codex/view-image.ts` imports `sharp` and therefore needs the native Sharp/libvips runtime.
- The current `package.json` (version 1.8.5) has no `sharp`, no `scripts`, and no `devDependencies`.
- `package-lock.json` does contain `sharp@0.35.3`, `@img/sharp-win32-x64@0.35.3`, and the build toolchain, but lock-only packages are not production dependencies to Electron Builder.
- `electron-vite`'s `externalizeDepsPlugin()` externalizes the keys in `package.json.dependencies`; with `sharp` absent it is not treated as a runtime external.
- `npm ci --dry-run --ignore-scripts --no-audit --no-fund --json` exits 0 but plans to remove `sharp`, `@img/sharp-win32-x64`, `detect-libc`, Electron, Electron Builder, electron-vite, Vite, Vitest, and the other omitted development packages. A clean release checkout therefore cannot reliably build or load Sharp from this manifest.
- `out/main/index.js` and the existing `release/win-unpacked` artifact predate the Sharp source change and contain no Sharp package. The existing 1.8.5 artifact cannot be used as proof of Sharp packaging.

There is no evidence that electron-builder itself cannot package Sharp. With a corrected manifest and a fresh Windows x64 build, its default native-module detection should unpack the `@img/sharp-win32-x64` module (including the `.node` addon and libvips DLLs). That assumption still needs an artifact inspection and packaged-process smoke test before release.

## Version and artifact evidence

Current markers are all 1.8.5, not the requested 1.8.6:

| Location | Current value | Finding |
| --- | --- | --- |
| `package.json:3` | `1.8.5` | Package manifest is also structurally incomplete. |
| `package-lock.json` root | `1.8.5` | Lock root matches the current manifest version, not a 1.8.6 release. |
| `src/main/version.ts:15` | `APP_VERSION = '1.8.5'` | Runtime marker remains 1.8.5. |
| `extension/manifest.json:4` | `1.8.5` | Extension marker remains 1.8.5. |
| existing release installer | `ChatGPT-Local-Files-Setup-1.8.5.exe` | Old artifact only; not a fresh 1.8.6 build. |

`test/extension.test.ts` checks agreement between `package.json`, `APP_VERSION`, and the extension manifest, but does not check the lockfile, package resources, native modules, or packaged runtime. Updating only the three visible markers is therefore insufficient.

The current `release/` directory contains 1.8.3, 1.8.4, and 1.8.5 installers plus an unpacked package. The 1.8.5 installer hash observed during this audit is:

```text
ChatGPT-Local-Files-Setup-1.8.5.exe
SHA-256 A7EE05C03574EA4053D3D6DD6E81C028D9A4424E1E64516CD3604124B0E5818F
```

The expected NSIS name after a real version bump is `ChatGPT-Local-Files-Setup-1.8.6.exe`, because `electron-builder.yml` uses `ChatGPT-Local-Files-Setup-${version}.${ext}`. Do not rename an old binary: the artifact must be rebuilt from a synchronized manifest/lock and fresh `out/`.

## Sharp/libvips runtime path

The source path is real and native, not a cosmetic dependency:

- `src/main/codex/view-image.ts` imports `sharp` and calls `sharp(data, { failOn: 'warning', limitInputPixels: ..., sequentialRead: true }).raw().toBuffer(...)`.
- Current source ceilings bound wire bytes, decoded bytes, and decoded pixels. These bounds are useful, but only work if the packaged process can load Sharp/libvips.
- Installed `sharp` is 0.35.3. Its Windows x64 optional package is `@img/sharp-win32-x64@0.35.3`.
- The installed optional package contains `lib/sharp-win32-x64-0.35.3.node`, `lib/libvips-42.dll`, and `lib/libvips-cpp-8.18.3.dll`; the JS entry point requires the native `.node` file.
- Sharp declares Node `>=20.9.0`. The development machine’s Node smoke test ran on Node 22.22.3; Electron 43.4.0’s embedded Node 24.18.1 also loaded Sharp successfully on Windows x64.

Read-only development smoke results:

```powershell
node -e "const sharp=require('sharp'); console.log(JSON.stringify({sharp:sharp.versions.sharp,vips:sharp.versions.vips,platform:process.platform,arch:process.arch,node:process.version})); sharp({create:{width:1,height:1,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer().then(b=>console.log('decode smoke bytes',b.length))"
```

```text
{"sharp":"0.35.3","vips":"8.18.3","platform":"win32","arch":"x64","node":"v22.22.3"}
decode smoke bytes 91
```

The equivalent `ELECTRON_RUN_AS_NODE=1` smoke loaded Sharp under Electron 43.4.0 and produced 91 PNG bytes. This proves the current installed dependency tree is viable; it does **not** prove an asar/unpacked production app.

## Why the current manifest breaks a clean build

`electron.vite.config.ts` uses `externalizeDepsPlugin()` for the main and preload bundles. The installed electron-vite implementation obtains dependency names from `package.json.dependencies` and builds its externalization list from those names. It does not use arbitrary entries that happen to remain in `package-lock.json` or `node_modules`.

Consequences of the current tree:

1. `sharp` is not a declared production dependency and is not a reliable input to Electron Builder’s production dependency collection.
2. Because it is absent from the externalization list, a build may try to bundle Sharp. Native optional packages and dynamic native loading are not a safe thing to bundle into the JS output; a successful-looking bundle would still need the platform addon and DLLs at runtime.
3. A clean `npm ci` reconciles the installed tree to `package.json` and removes Sharp and the build toolchain. The current `npm ci --dry-run` result is therefore a direct reproducible blocker, even though it does not mutate the checkout.
4. The present `out/main/index.js` has no `sharp` reference and still contains the earlier image validation path. It is stale output, not proof that the current source has been built.

Required release-prep correction (performed by the release owner, not by this audit):

```json
{
  "dependencies": {
    "sharp": "0.35.3"
  }
}
```

The full intended `scripts` and `devDependencies` also need to be restored in `package.json`; the lockfile must then be regenerated or validated from that exact manifest. Do not merely add a lock entry or copy `node_modules`. After `sharp` is a declared dependency, the existing `externalizeDepsPlugin()` will automatically externalize it. An explicit `include: ['sharp']` can be used as a defensive readability guard, but it is not a substitute for the manifest dependency.

The release should run dependency installation on the actual target platform/architecture (Windows x64) with optional dependencies enabled. `@img/sharp-win32-x64` is optional by design; a lock generated on another platform can omit the Windows package from the installed tree. The artifact must be built from a Windows x64 install and the exact installed package must be inspected.

## Electron Builder native-module handling

Current `electron-builder.yml` contains:

```yaml
npmRebuild: false
asarUnpack:
  - '**/node_modules/node-pty/**'
```

The explicit `node-pty` rule is correct and should remain. `node-pty` needs real native files and ConPTY helper assets outside the asar. The comment saying it is the “one native module” is now stale: Sharp/libvips is another native dependency.

The installed electron-builder 26.15.7 has `smartUnpack` enabled by default. Its unpack detector treats `.node`, `.dll`, `.exe`, `.so`, and similar files as native and marks the containing module root for unpacking. With `sharp` correctly declared and included in the production dependency tree, this should discover the native files below `@img/sharp-win32-x64` and unpack that module.

This is a builder behavior assessment, not artifact proof. For deterministic release hardening, add an explicit rule alongside node-pty:

```yaml
asarUnpack:
  - '**/node_modules/node-pty/**'
  - '**/node_modules/@img/sharp-win32-x64/**'
```

The second rule is not strictly required while smart-unpack remains enabled and verified, but it makes the Sharp platform boundary visible and protects against a future smart-unpack/configuration change. The critical requirement is still a synchronized manifest and a fresh artifact. Unpacking only `sharp/**` would not be sufficient if the `@img/sharp-win32-x64` optional package is missing; the addon and libvips DLLs live in that platform package.

Keep `npmRebuild: false` only if the release continues to use Sharp’s prebuilt N-API package and the Windows x64 smoke passes. If the dependency version or Electron/Node ABI changes to a package without a compatible prebuild, this setting becomes a separate release blocker; do not silently rely on a developer’s `node_modules`.

Recommended post-build artifact assertions:

- `resources/app.asar` contains the JS package metadata and bundled app code.
- `resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/` contains the Windows x64 `.node` addon and both libvips DLLs.
- `resources/app.asar.unpacked/node_modules/node-pty/` still contains its native addon and ConPTY files.
- No release runtime depends on `C:\Users\totec\chatgpt-local-files\node_modules`.

An asar listing can be checked without launching the app, for example:

```powershell
node -e "const asar=require('@electron/asar'); const p='release/win-unpacked/resources/app.asar'; const xs=asar.listPackage(p); for (const q of xs.filter(x=>/sharp|libvips|node-pty/.test(x))) console.log(q)"
Get-ChildItem -Recurse 'release/win-unpacked/resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64'
```

The current 1.8.5 artifact fails this Sharp assertion: its `app.asar` and `app.asar.unpacked` contain node-pty, tree-sitter, and tree-sitter-bash, but no `sharp` or `@img/sharp-win32-x64`. This is expected for the stale artifact and must be rechecked against 1.8.6.

## Resources that must remain outside the asar

The current extra-resource configuration is structurally correct and should be preserved:

```yaml
extraResources:
  - from: resources/tunnel
    to: tunnel
    filter: ['**/*']
  - from: extension
    to: extension
    filter: ['**/*', '!**/*.map']
  - from: resources/rg
    to: rg
    filter: ['**/*']
```

The packaged runtime locators expect these exact paths under `process.resourcesPath`:

- `src/main/extension-path.ts` -> `resources/extension`; packaged `extension/manifest.json` must be present and parseable.
- `src/main/tunnel/locate.ts` -> `resources/tunnel`; the tunnel executable and its licenses/version data must be present.
- `src/main/ripgrep.ts` -> `resources/rg/rg.exe`; the executable must be present and runnable.

The existing unpacked 1.8.5 package contains all three (`extension/manifest.json`, `tunnel/tunnel-client.exe`, and `rg/rg.exe`). This is a positive check for the unchanged resource layout, not 1.8.6 proof. The `dist` scripts fetch “latest” resources when no explicit version is passed, so release reproducibility also requires recording the resolved `VERSION` files and hashes (or passing pinned versions) during the build.

## NSIS, install scope, and AppData preservation

The current installer policy is per-user and non-elevated:

- `oneClick: false`
- `perMachine: false`
- `requestedExecutionLevel: asInvoker`
- `allowToChangeInstallationDirectory: true`
- `deleteAppDataOnUninstall: false`
- artifact name: `ChatGPT-Local-Files-Setup-${version}.${ext}`

This is consistent with preserving `%APPDATA%\chatgpt-local-files`. In electron-builder 26.15.7, `deleteAppDataOnUninstall` defaults false and the NSIS define is only enabled when the option is true; the explicit false is valuable documentation. Do not enable the delete option for this product.

No install or uninstall was run against the real user profile during this audit. The existing `%APPDATA%\chatgpt-local-files` directory was only listed read-only. A real smoke must use a disposable Windows profile or VM and must test both upgrade and uninstall:

1. Before install, create a non-secret sentinel in the disposable app-data directory and record hashes/metadata for `config.json`, `secrets.bin`, and one session directory. Do not print secret contents.
2. Install `ChatGPT-Local-Files-Setup-1.8.6.exe` with the assisted per-user installer, choosing a disposable installation directory. Confirm no elevation is requested.
3. Launch the installed app and verify the displayed/runtime version is 1.8.6. Confirm `resources/extension`, `resources/tunnel`, `resources/rg`, `app.asar`, and `app.asar.unpacked` are under the installed resources directory.
4. Exercise one node-pty terminal command, one ripgrep-backed search, tunnel/resource discovery, extension discovery/pairing path, and the image path using a tiny approved-root PNG. The image action must reach the installed process and prove Sharp/libvips loaded from the package.
5. Install the 1.8.6 build over the disposable 1.8.5 install, if an upgrade scenario is required. Recheck the same app-data sentinel and metadata.
6. Uninstall from Windows’ installed-apps flow. Verify the install directory is removed but `%APPDATA%\chatgpt-local-files` and its sentinel/config/secrets/session data remain.
7. Record the installer and blockmap SHA-256, installed executable path, app version, resource paths, and process exit codes. Keep this separate from static artifact assertions and unit-test results.

Do not use the production profile or the current live AppData for this destructive uninstall check.

## Exact release gate

The following sequence is the minimum evidence I recommend before calling 1.8.6 packaging ready:

### 1. Synchronize inputs

- Restore the complete intended `package.json` scripts and development dependencies.
- Set all four version roots to 1.8.6: `package.json`, `package-lock.json` root metadata, `src/main/version.ts`, and `extension/manifest.json`.
- Add `sharp: 0.35.3` to runtime dependencies and regenerate/validate `package-lock.json` from that exact manifest.
- Build on Windows x64 with optional dependencies enabled; do not use a copied cross-platform `node_modules`.
- Pin or record tunnel/ripgrep resource versions and hashes.

### 2. Source/static checks

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if (p.dependencies.sharp !== '0.35.3') throw Error('package.json sharp missing'); if (l.packages['node_modules/sharp'].version !== '0.35.3') throw Error('lock sharp mismatch'); console.log('manifest/lock sharp OK')"
```

`npm ci` must not plan to remove Sharp or the build toolchain. Run the nearest image/view-image tests and the complete `npm run verify` after the manifest is repaired.

### 3. Fresh build/package checks

```powershell
npm run build
npm run dist:dir
npm run dist
```

Use the repository’s existing scripts after restoring them; they fetch resources, build `out`, then invoke electron-builder. Do not inspect a previously generated `out/` or `release/` directory as if it were the new build.

Check the new unpacked artifact with the asar listing and filesystem assertions above. Verify that the new installer is exactly named `ChatGPT-Local-Files-Setup-1.8.6.exe` and that the blockmap is emitted beside it.

### 4. Installed-process proof

Run the disposable-profile NSIS smoke. In particular, a plain `node -e require('sharp')` in the repository is not enough. The proof must come from the installed packaged process, with a tiny approved image passed through the actual view-image path and no repository-relative module resolution.

## Findings summary

| Priority | Finding | Status |
| --- | --- | --- |
| P0 | Current `package.json` omits `sharp`, scripts, and devDependencies while lockfile retains them. Clean npm install removes Sharp/tooling. | Must fix before build. |
| P0 | `out/main/index.js` and existing 1.8.5 release predate Sharp and contain no Sharp package. | Must rebuild from clean synchronized inputs. |
| P0 | All version markers are 1.8.5, so no 1.8.6 artifact is currently identified. | Must bump and verify all roots. |
| P1 | `electron-vite` externalizes declared dependencies only; Sharp must be in `package.json.dependencies`. | Fixed by manifest correction; optional explicit include is defensive only. |
| P1 | Sharp native module is not explicitly listed in `asarUnpack`; current builder smart-unpack should detect it, but this has not been proven on a new artifact. | Add explicit `@img/sharp-win32-x64` rule or enforce artifact assertion. |
| P1 | `electron-builder.yml` comment says node-pty is the only native module. | Update documentation/config comment with the Sharp boundary. |
| P1 | Resource fetching without a pinned version is not reproducible. | Pin or record tunnel/rg versions and hashes at release. |
| PASS (old artifact only) | node-pty is unpacked; extension/tunnel/rg are extra resources; NSIS artifact naming and `deleteAppDataOnUninstall: false` are configured coherently. | Recheck on fresh 1.8.6 and disposable install. |

