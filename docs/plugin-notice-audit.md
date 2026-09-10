# Plugin notice audit for the 2.1.5 selective port

Reviewed during the 2.1.5 plugin-platform integration on 2026-09-10. This document records the notice material imported with the plugin feature. It does not reuse upstream 2.0.8 release, hosted-CI, native-source, signing, notarization, or cross-platform publication claims.

## Scope

The catalog contains seven reviewed integrations: Blender MCP, Knowledge Memory, Playwright Browser, Web Fetch, HeyGen Video, Recraft Design, and Unity Editor. `docs/licenses/plugins/inventory.json` is the authority for the exact package/service reference, reviewed version where applicable, notice file, and SHA-256 digest.

The five downloadable catalog entries retain license material for their reviewed distributions or an explicit upstream supplement where the distribution omits it. HeyGen and Recraft are hosted services; their catalog entries are labeled as hosted-service terms and retain service-notice/terms references rather than representing those services as MIT-licensed software.

Catalog SVGs under `src/renderer/plugin-icons/` are repository-owned illustrations. They are not copied product logos and do not imply endorsement.

## Generated application notice inventory

`scripts/generate-third-party-notices.mjs` validates the installed production dependency versions against `package-lock.json`, preserves package-supplied license/NOTICE material, validates the retained `flora-colossus` license supplement, verifies every plugin notice hash, and generates `THIRD-PARTY-NOTICES.txt`.

Native/runtime notices are intentionally outside this plugin tranche. Existing platform-specific tunnel, ripgrep, Electron/Chromium, and image-library notice handling remains owned by the existing packaging pipeline. The plugin notice generator does not import or claim a separate native-source compliance system.

`THIRD-PARTY-NOTICES.txt` is added as a common packaged resource so Settings > Plugins > Legal Notices resolves to a real file in installed builds. `verify:ci` invokes `verify:notices` before TypeScript and Vitest verification.

## Verification recorded during this tranche

- Plugin UI / renderer / notice focused gate: 4 test files, 77 tests passed.
- TypeScript typecheck passed before notice generation.
- Notice generation and `--check` both validated 87 installed production packages and all 7 catalog entries.
- `git diff --check` passed after the notice/compliance changes.

These are local integration checks only. They are not a claim that a public release, code-signing run, notarization run, or all-platform package matrix has completed.
