# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That opens a private advisory only
maintainers can see.

Useful things to include, as far as you have them: what you did, what happened,
what you expected, the app version (**Settings → About**), your Windows build,
and whether the Chrome extension was connected at the time.

This is a solo-maintained beta project, not a funded product. There is no bounty
and no guaranteed response window. Reports are read and taken seriously, but
please size your expectations accordingly.

## What counts as a vulnerability here

This app's entire job is to be a gate: it exposes folders you approve to a model,
and nothing else. So the bugs that matter most are the ones that get **past the
gate**:

- Reading, writing or executing anything outside an approved folder.
- Turning a read-only approval into a write, or performing a control/exec action
  that was never opted into.
- Making the real Windows path of an unapproved location observable.
- Letting anything other than the paired local app talk to the bridge, or getting
  a bridge token out of the ChatGPT page.
- Getting redacted material (environment variable values, clipboard contents,
  agent credentials) into session history or the activity log.
- Any remote origin reaching the loopback bridge.

## Known limitations — please read before reporting

These are already understood and documented, so reporting them tells us nothing new:

- **The installer is unsigned.** Windows SmartScreen will warn. See the README.
- **Path containment is defence in depth, not a kernel sandbox.** Validation
  happens on pathname strings, so NTFS reparse points, junctions and symlink
  races carry residual TOCTOU risk. Do not rely on this app as your only barrier
  against a genuinely hostile process.
- **An approved folder is approved in full**, including anything reachable through
  it. Approving your home directory approves your home directory.
- **Session recording is intentionally more revealing than the activity log.** That
  is its purpose. It is off unless enabled, and stored locally.
- **Desktop control, when enabled, is real.** Screen capture plus mouse and
  keyboard is not confined to approved folders — nothing about it could be.
  It is a separate opt-in for that reason.

## Scope

In scope: this app, the bridge, and the `extension/` companion.

Out of scope: ChatGPT itself, OpenAI's infrastructure, `tunnel-client`,
`cloudflared`, Electron and Chromium upstream. Report those to their own projects.
