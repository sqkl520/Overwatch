# Security Policy

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting** —
[open a draft advisory](https://github.com/sqkl520/UntilDone/security/advisories/new).
It stays private between you and the maintainer until a fix ships.

If that link does not work on your account, open a
[regular issue](https://github.com/sqkl520/UntilDone/issues/new) that says only
"security report, please enable a private channel" and **nothing else** — no
details, no reproduction steps, no affected paths. The maintainer will open a
private channel and reply there.

Do not put exploit details in a public issue, a pull request, or a commit
message.

## What to expect

| | |
|---|---|
| Acknowledgement | within **7 days** |
| Initial assessment (is it a real issue, how severe) | within **14 days** |
| Fix or a written decision not to fix | within **90 days** for confirmed issues |

These are targets, not a contract. This is a single-maintainer project. If a
window passes with no reply, ping the advisory thread — silence means the
notification was missed, not that the report was ignored.

## Scope

Overwatch reads transcripts that other tools wrote and renders them to a
terminal. Things that count as security issues here:

- **Terminal escape injection.** Transcript content, project names, session
  titles and `cwd` values reach the screen. If any of them can emit a live
  escape sequence — OSC 52 writing the clipboard, cursor movement, SGR that
  fakes a different verdict — that is a real vulnerability, not a cosmetic bug.
  `scripts/tui-theme.mjs` and the `sanitize()` path in
  `scripts/oversight-tui.mjs` are the areas to examine.
- **Path traversal or arbitrary file read** driven by transcript content.
- **A hook that can be made to run something other than what it claims.**
  `scripts/pre-write-gate.mjs` and `scripts/stop-verify-hook.mjs` receive JSON
  on stdin and are wired into someone's editor session.
- **Credential leakage.** This project never asks for a token and never stores
  one. If you find a code path that reads an environment variable containing a
  secret and writes it anywhere — log, ledger, `tasks/runs/`, terminal — that
  is a vulnerability.

## Out of scope

These are known and documented, not vulnerabilities:

- **The tool reads files under `~/.claude/`.** That is what it is for. Running
  it means granting it read access to your session transcripts.
- **`tasks/runs/` accumulates session ids and local paths.** It is gitignored
  by design; see `.gitignore`. Do not commit it.
- **`--days N` scans and prints whatever it finds, including content you would
  rather not see on screen.** It is a local, read-only report.

## What this project does not do

For the avoidance of doubt about its blast radius:

- It does not modify files another tool wrote. Everything under `~/.claude/` is
  opened read-only.
- It does not send anything over the network. There is no telemetry, no update
  check, no remote config. `launch` starts a local process and talks to it over
  stdio.
- It has no dependencies to audit — the repository contains no `package.json`
  and never runs `npm install`.

## Supported versions

There are no tagged releases yet; the repository is the release. Fixes land on
`main`. If you are running an older clone and a security fix has shipped, the
only remedy is to pull.
