# Contributing

This is a beta, maintained by one person. Contributions are welcome, but please
read this first — it will save us both time.

## Before you open a PR

**Open an issue first for anything non-trivial.** Large parts of this codebase
look strange on purpose: comments in the source name the exact live failure that
motivated a guard, and "cleaning up" one of those tends to reintroduce a bug that
took a long time to find. A quick issue avoids a wasted afternoon.

**Read [`AGENTS.md`](AGENTS.md).** It is the single orientation document for the
repository — one section per subsystem, each covering what it owns, its files, its
flow, what must hold, how it fails, and which tests cover it. §18 maps symptoms to
the files worth opening. It is long; you only need the section you are touching.

**Do not report security issues as PRs or public issues.** See
[`SECURITY.md`](SECURITY.md).

## Setup

Requires Windows 10/11 x64 and Node 22+.

```sh
npm install
npm run verify     # typecheck + tests; this must pass before you push
npm run dev        # run the app from source
```

`npm run dist` produces the installer. It first downloads `tunnel-client` and
`ripgrep`, so the first run needs network access.

## What a good change looks like

- **It fixes the root cause.** Not hidden in the UI, not retried until it passes.
- **It has a test that fails before and passes after.** The suite is the design
  record; a fix without one gets re-broken later.
- **`npm run verify` is green.**
- **The commit message says what changed and why**, in ordinary sentences.

## Areas where help is genuinely useful

- Reproductions. A reliable repro for anything in `AGENTS.md` §21 is worth more
  than a speculative fix.
- Documentation gaps — especially places where the README's setup steps have
  drifted from what ChatGPT's UI actually shows now. That moves often.
- Windows version coverage. It is developed on Windows 11.

## Areas where it probably is not

- Ports to macOS or Linux. Not because they are unwelcome in principle, but the
  Windows-specific surface (`node-pty`, path handling, desktop control) is deep
  enough that a port is a fork-sized project, not a PR.
- Broad reformatting, lint-rule changes, or dependency bumps without a reason.

## Licence

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
