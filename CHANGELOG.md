# Changelog

All notable changes to this project are documented here.

This project is in **beta**. Versions before 1.0 of *stability* — regardless of the
number on the tin — may change behaviour between releases.

The app and the `extension/` companion are versioned together. **Reload the
extension after updating the app**; a mismatched pair will connect but can
mis-attribute tool calls.

## [1.9.2] — 2026-08-21

First public beta release.

### Fixed
- Harvest the request id before ChatGPT's safety check releases it. The id used to
  correlate a tool call with the turn that caused it could be gone by the time it
  was read, which surfaced as calls landing under the wrong turn or under
  *Unattributed activity*.

## [1.9.1] — 2026-08-21

### Fixed
- Attribute MCP calls that arrive without a `data-turn-id`. ChatGPT does not always
  stamp the attribute; those calls previously fell through to *Unattributed*.

## [1.9.0] — 2026-08-21

### Fixed
- Live transcript ownership and chronology. Turn identity could leak from an older
  generation into a newer one, progress ids could be reused across generations, and
  the same semantic tool row could be recorded two or three times under
  index-derived ids. Identity is now scoped per generation rather than trusting a
  DOM attribute that survives React node reuse.

## [1.8.9] — 2026-08-21

### Changed
- Hardening pass across MCP lifecycle, path handling and process control.
- The test suite terminates reliably instead of leaving stray workers behind.

## [1.8.4] — 2026-08-20

### Added
- Refreshed application icon.
- Current Codex-derived base tools ported to Core.

### Fixed
- Turn-killer bug; session identity now survives a reload.
- Live transcript capture and attribution repair.

## [1.7.6] — 2026-08-18

### Changed
- Reduced model-facing tool surface from 45 tools / ~60 kB to 12.5 kB across six
  core tools and 7.9 kB across two desktop tools, with those sizes held as test
  budgets. See [`docs/tool-surface.md`](docs/tool-surface.md).

## [1.5.1] — 2026-08-15

### Changed
- Hardened MCP workflows and process control.
- Corrected the documented Electron user-data path.

## [1.5.0] — 2026-08-15

### Added
- Transactional batch edits and process output cursors.

[1.9.2]: https://github.com/totec448-spec/chatgpt-local-files/releases/tag/v1.9.2
