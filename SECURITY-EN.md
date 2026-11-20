[简体中文](SECURITY.md) | English

# Security Policy

## What this is, and what it is not

UntilDone is a **plain Claude Code config library**: markdown role definitions plus
zero-dependency Node scripts, with no daemon, no backend and no accounts
(`docs/adr/0001-config-only.md`). It does three things:

1. **Reads** this machine's `~/.claude/` session records (transcripts,
   `sessions/*.json`, `jobs/*/state.json`) to decide what each session is doing and
   whether it is stuck.
2. **Writes** its own run ledgers and state (`tasks/runs/`,
   `%LOCALAPPDATA%/UntilDone`, `.claude/.ow-*` inside your project directory).
3. **Acts as a hook inside host sessions**: a pre-write gate (`PreToolUse`) and a
   stop gate (`Stop`) that can deny a tool call or block the end of a turn.

It is **not networked** (`probe-relay.mjs` connecting to a local named pipe is the only
socket; see §2), it collects **no** telemetry, has **no** update checker, **never asks
you for a token**, and **stores no credentials**.

**Every file read, file write and child process below cites a `file:line`.** If this
document disagrees with the code, **the code wins** — an issue pointing that out is
welcome.

> ⚠️ **The most important point first:** **this library can read all of your
> conversation content.** It reads transcripts, and transcripts contain the code you
> showed the AI, the errors you pasted, and the keys you pasted (if you pasted any).
> Its mitigations are redaction and reading less — not privilege separation. See §5.

---

## Supported versions

**There is no version number to speak of.** Measured: `git tag` is empty, there are no
releases, and there is no npm package — the `main` branch *is* the release (stated at
the top of `README.md`).

| What you run | Supported |
|---|---|
| The latest commit on `main` | ✅ That is the only option |
| Any older clone | ❌ Fixes are not backported to branches; the remedy is `git pull` |
| A fork | ❌ The fork owner's problem |

Two facts, stated plainly:

- **`main` has no branch protection** (measured: the GitHub API answers
  `Branch not protected`), so "fixes land on main" means **a fix takes effect the
  moment it lands**, with no review gate in between. That is also an attack surface:
  any credential that can push to `main` can change hook behaviour directly.
- **No commit signing is required and there are no release artifacts.** What you
  `git pull` is all there is; there is no checksum to compare against. To know which
  version you are running, use `git rev-parse --short HEAD`.

---

## Reporting a vulnerability

**Do not open a public issue for a security problem.** A public issue is visible to
everyone, including anyone who would exploit it before a fix exists.

**Preferred — GitHub's private vulnerability reporting** —
[open a draft advisory](https://github.com/sqkl520/UntilDone/security/advisories/new).
Until a fix ships it is visible only to you and the maintainer.

> That channel is a repository setting, and settings can be turned off. As of
> 2026-11-21 it reads `enabled: true` and the link works. If you land here after it has
> been switched off, the fallback below is what it is for.

If the link does not work on your account, open a
[regular issue](https://github.com/sqkl520/UntilDone/issues/new) whose body says only
"security report, please enable a private channel" and **nothing else** — no details,
no reproduction steps, no affected paths. The maintainer will open a private channel
and reply there.

Do not put exploit details in a public issue, a pull request, or a commit message.

### What to include

| What | Why |
|---|---|
| **The commit hash you cloned** (`git rev-parse --short HEAD`) | No tags and no releases; the hash is the only identifier for that version |
| **The whole block printed by `node scripts/overwatch.mjs`** | Node version and platform live there. **Strip paths first**: the `root` on the `transcripts` line and `claudeDir` on the `sources` line are your home-directory absolute paths (`checkSources()`), and `--json` carries the raw values too |
| **Exact commands and any `OW_*` / `OVERWATCH_*` variables** | Gate mode, log destination and state directory are all decided by env vars. The same code behaves completely differently under `OW_PRE_WRITE_GATE=observe` and `deny` |
| **Reproduction steps or a minimal PoC** | A minimal repro is worth more than a long write-up |
| **What an attacker gains** | **Impact matters more than mechanism.** "Can inject an escape sequence" and "can make a read-only report rewrite your clipboard" are different bugs |
| **Relevant log excerpts, redacted** | Session ids, project names, local paths and transcript text do not belong in public content |

### What to expect

| | |
|---|---|
| Acknowledgement | within **7 days** |
| Initial assessment (real issue? how severe?) | within **14 days** |
| Fix, or a written decision not to fix | within **90 days** of confirming the issue |

These are targets, not a contract. This is a single-maintainer project. If a window
passes with no reply, ping the advisory thread — silence means the notification was
missed, not that the report was ignored. There is no bug bounty and no PGP key (ask
first if you want encryption; do not assume one exists).

---

## 1. Scope — what counts as a security issue

**Each entry below maps to a concrete attack surface, not a generic checklist.**

### In scope

| Category | What exactly | Where to look (code) |
|---|---|---|
| **Terminal escape injection** | Transcript content, project names, session titles, `cwd`, `needs` / `suggestedReply`, and the token list in `delta` all reach the screen. If any of them can emit a live escape sequence (OSC 52 writing the clipboard, cursor movement, SGR that fakes a different verdict), that is a real vulnerability | `stripAnsi()` / `ANSI_RE` in `tui-theme.mjs`; `sanitize()` in `oversight-tui.mjs` (`:106`), and `viewOf()` (`:601`), which is the one mandatory cleaning entry point |
| **A read-only path producing side effects** | If a report that claims to be "read-only" can change the clipboard or write files, that is a vulnerability. This has real history here: `DF-013` (unsanitised `sessionId` / `project` / `hostState`, OSC 52 getting through), fixed | The comments at `oversight-tui.mjs:1000` / `:1042` record why fields are only read from `viewOf` |
| **Path traversal or arbitrary file read driven by transcript content** | Externally-controlled input (session `cwd`, instance names, run ids, log filenames) escaping its intended directory | Path resolution in `claim-ledger.mjs:244` / `:520`; `detectProjectCommands()` in `project-commands.mjs` only reads build-marker files at the **session cwd**, capped at 256 KiB per file (`MAX_READ_BYTES`) |
| **A hook induced to do something else** | Both hooks take JSON on stdin and are wired into someone's session. Input must be treated as untrusted data: a parse failure must fail open, and input must never be concatenated into a command | `parseHookInput()` / `readStdin()` in `pre-write-gate.mjs` (4 MiB cap plus a time gate); the fail-open design in `stop-verify-hook.mjs` |
| **A gate silently switched off or bypassed** | Making a gate look like it works while none of its criteria execute (`DF-031` / `DF-033` are exactly this: a silent skip printed the same thing as a pass); or forging a "verified" marker by getting around the signature | `verifyMarkerSig()` at `pre-write-gate.mjs:1212` (HMAC-SHA256 plus `timingSafeEqual`); a write to the secret file itself is judged `secret-tamper` (`:1515`) |
| **Credential leakage** | This project asks for no token and stores none. A code path that reads an environment variable holding a secret and writes it anywhere — log, ledger, `tasks/runs/`, terminal — is a vulnerability | The only secret in the repo is the gate's own `.claude/.ow-gate-secret`; `launch.mjs:613` only mentions the *name* `ANTHROPIC_API_KEY` in help text and never reads it |
| **A hook blocking what should pass** | `stop-verify-hook.mjs` fails open by default and cannot be configured to fail closed; turning its crash into "the session cannot end" is a security issue (availability is security) | `stop-verify-hook.mjs`, header "design principle 1"; `isPaused()` is the L1 stop path |

### Out of scope — expected behaviour or declared trade-offs

| Not a vulnerability | Basis |
|---|---|
| **It reads files under `~/.claude/`** | That is what it is for. Running it grants it read access to your session records. This document does not dress that up as anything else |
| **It can read all conversation content in a transcript** | Same. It reads only a **tail window** (1 MiB / 512 KiB, two tiers) — a concession to speed and privacy, not isolation |
| **Session ids and local paths appear in `tasks/runs/`** | Ignored by design (`.gitignore:8`). **Do not commit it.** Its existence is the price of being auditable after the fact |
| **`--days N` prints whatever it finds** | A local, read-only report. Content you would rather not see on screen is the direct consequence of reporting honestly |
| **`probe-relay.mjs --send` really delivers a message to another session** | Measuring exactly that is the script's purpose. Do not run it and no connection is opened |
| **Hooks block your tool calls / the end of a turn** | That is the product. You choose whether to install them and at which tier (`observe` / `warn` / `deny`), and a stop file cuts them off entirely (§8) |
| **Upstream problems**: Claude Code itself, Node bugs | Report those upstream. If an upstream defect is **amplified by this library**, that part is ours |

---

## 2. Network — what the code actually shows

**Conclusion: the entire repository has exactly one socket, and it connects to a local
named pipe, not a network.**

How to verify (independently reproducible):

```bash
grep -rn "from 'node:net'\|from 'node:http'\|from 'node:https'\|from 'node:tls'\|from 'node:dgram'" scripts/
grep -rn "\bfetch(\|globalThis.fetch\|WebSocket\|undici" scripts/ .claude/ templates/
```

Every hit:

| # | Hit | Purpose | Is it network? |
|---|---|---|---|
| 1 | `scripts/probe-relay.mjs:37` `import net from 'node:net'` | Connects to a **local named pipe** | **No** |
| 2 | `scripts/gen-width-table.mjs:22`–`23`, `scripts/width-table.mjs:7` | `https://www.unicode.org/...` appears **in comments**, naming the source of the two data files | Not a call. The data is vendored under `scripts/data/` |
| 3 | `scripts/published-paths.mjs:28` | A comment using `http://x` to explain why the regex must exclude URLs | Not a call |

`fetch` / `WebSocket` / `node:http(s)` / `node:tls` / `node:dgram` have **zero hits** in
`scripts/`, `.claude/` and `templates/` (`fetch\s+first` at `verify-claims.mjs:455` is a
regex matching git push error text, not a network call).

### The one socket: `probe-relay.mjs`

| Fact | Location |
|---|---|
| Session registrations are read from `~/.claude/sessions` | `probe-relay.mjs:41`, `:44` (`listSessions()`) |
| The socket path comes from `messagingSocketPath` in the registration file | `probe-relay.mjs:58` |
| Connections are opened | `probe-relay.mjs:91` (`canConnect`), `:128` (`sendFrame`) |
| **`messagingSocketPath` is only checked for being non-empty — prefix and shape are not validated** | `probe-relay.mjs:90`: after `if (!socketPath) { done(...) }` it calls `net.createConnection(socketPath)` directly (`:91`) |
| `--send <pid>` really sends a frame, with `peerToken` in it | `probe-relay.mjs:219`–`:226` (the token is read from `<pid>.<64hex>.key`, `:71`–`:85`) |

**What that means, plainly**: the script trusts the path written in
`~/.claude/sessions/*.json`. If you can write in that directory (it is in your own home
directory, guarded by OS permissions), you can point this script at any named pipe. The
library does not validate it. That is the boundary of "a diagnostic script that only
runs on this machine" and it is not privilege escalation — anyone who can change that
directory can change far more. It does **not** open TCP and needs no network.

### Inbound

**No listening port.** No script calls `listen()` / `createServer()`. This is not a
service; there is no address to connect to.

---

## 3. Files — what is read, what is written

### Reads (external data, always opened read-only)

| Path | Purpose | How much | Location |
|---|---|---|---|
| `~/.claude/projects/**/*.jsonl` | Transcripts: state verdicts, claim checks, sampling | A **tail window**: 1 MiB (`CLAIM_TAIL_BYTES`), 512 KiB (`TAIL_BYTES`), plus bounded backtracking (`readBack`'s `steps`) | `verify-claims.mjs:50` / `:1092` / `:1107`; `stop-signals.mjs:42` / `:78` |
| `~/.claude/sessions/*.json` | Sessions the host has registered | Whole JSON | `watch.mjs:1045`; `scan-sessions.mjs:649`; `probe-relay.mjs:44` |
| `~/.claude/jobs/**/state.json` | The host facts behind `BLOCKED` / `FAILED` / `WAITING` | Whole JSON | `scan-sessions.mjs:690`; `watch.mjs:2683` |
| Build-marker files in the session `cwd` recorded in a transcript | To work out "how this project runs its tests" (`package.json` / `pom.xml` / `build.gradle` / `Cargo.toml` / `go.mod` / `pyproject.toml` / `*.sln` …) | **Repo root only**, 256 KiB per file, no recursion | `project-commands.mjs:24` / `:116`; call sites `verify-claims.mjs:1872`, `stop-verify-hook.mjs:855` |
| The repository itself | Structure gate, payload, width table | — | all of `scripts/*.mjs` |

**`~/.claude/` is read-only here and is never written.** Verified: among the
`writeFileSync` / `appendFileSync` / `rmSync` / `mkdirSync` call sites, **not one** path
contains `.claude`, `projects`, `sessions` or `jobs` (reproducible with `grep`). The only
`.claude` writes happen inside **your project directory** (below), not `~/.claude`.

### Writes (always one of four places)

| Location | Content | Overridable? | Location |
|---|---|---|---|
| `<repo>/tasks/runs/**` | Gate ledgers (`pre-write-gate/<date>.jsonl`, `stop-hook/<date>.jsonl`, `stop-hook-samples.jsonl`, `hook-dedupe/`), launch ledgers, run ledgers | `OVERWATCH_STATE_DIR` / `OVERWATCH_RUNS_DIR` / `OW_PRE_WRITE_GATE_LOG` / `OVERWATCH_STOP_VERIFY_LOG` redirect them | `pre-write-gate.mjs:1810`; `stop-verify-hook.mjs:452` / `:505` / `:603`; `hook-dedupe.mjs:100`; `launch.mjs:494` |
| State directory: `%LOCALAPPDATA%/UntilDone` (Windows) or `$XDG_STATE_HOME/untildone` | `state.json`, observation log, `asked-history.json`, `notify/`, process witness, `.witness.json` | `OVERWATCH_STATE_DIR`; if the pre-rename `Overwatch` directory exists it **keeps using it** (nothing is migrated automatically) | `state-dir.mjs:30`–`:63`; `watch.mjs:112`; `asked.mjs:714`; `notify.mjs:44` |
| Session directory: `<cwd>/.claude/.ow-*` | The pre-write gate's marker `.ow-read-done`, denial counter `.ow-gate-denials.json`, and the **signing secret** `.ow-gate-secret` (`mode 0600`) | Follows the project, not the repo | `pre-write-gate.mjs:128` / `:131` / `:135` / `:1183` |
| Temp dir / in-repo generated artifacts | `os.tmpdir()/overwatch-replay-cache` (replay cache, `--cache off` disables), `dist/` (plugin payload, social preview), `scripts/install/start-watch.vbs` (rendered by the installer), `scripts/width-table.mjs` (generated from `scripts/data/`) | — | `replay-observe.mjs:915`; `build-payload.mjs:350`; `make-social-preview.mjs:265`; `install-watcher.mjs:188`; `gen-width-table.mjs:35` |

**One action that writes outside the repo**: `install-watcher.mjs install` creates a
shortcut `Overwatch Watch.lnk` under
`%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/` (`install-watcher.mjs:62` /
`:102`). That is autostart at login; it only happens if you run `install` explicitly, and
`uninstall` removes it. On non-Windows, `startupDir()` returns `null` and the script
prints the launchd / systemd recipe instead of pretending it installed something.

**The only scripts that modify repository sources**: `verify-bugfix-negatives.mjs`,
`verify-claim-fix-negatives.mjs`, `verify-tui-negatives.mjs`. To produce negative
evidence they **temporarily** put a bug back into the source, run the tests, then restore
the original text (`verify-bugfix-negatives.mjs:203`–`:215`, with restoration in
`finally`). They **do not touch git state**. If you do not want anything editing your
working tree, do not run them.

---

## 4. Will it run commands you did not ask for?

**Verified: there is no `shell: true` anywhere (`grep -rn "shell: true" scripts/` returns
nothing).** Every child process is started from an argument array, never from a
shell string. All spawn sites:

| What is started | Who | Location | Is it "something you did not ask for"? |
|---|---|---|---|
| `git ls-files` / `git log` / `git show` / `git --version` | structure gate | `check-structure.mjs:122` / `:1548` | No — read-only queries |
| `node --check`, `node --input-type=module -e <generated script>`, `node --test` | structure gate / negative verification | `check-structure.mjs:376` / `:958` / `:1495`; `verify-*.mjs` | No — the script bodies are generated by this repo |
| `claude` (or `--host-bin`) | `overwatch launch` | `launch.mjs:1154` | **Yes, and that is the point**: starting a host session is what this subcommand does |
| `wscript.exe` → `powershell.exe` running a repo-generated `.ps1` | desktop notifications | `notify.mjs:186`; `install-watcher.mjs:233` | No — the script comes from an inline template in this repo |
| `powershell.exe` / `pbcopy` / `xclip` (write the system clipboard) | TUI, on pressing `c` to copy a draft | `oversight-tui.mjs:394`–`:430` | No — only happens on your keypress |
| `powershell` `Get-Process .StartTime` / `ps -o etimes=` | deciding whether the watcher is alive and whether a PID was reused | `watch.mjs:288` / `:296` | No — read-only queries |
| `node <repo script>` | entry routing, WUI scans, TUI sampling, health checks | `overwatch.mjs:202`; `watch.mjs:1301`; `oversight-tui.mjs:309` / `:344` | No |
| `taskkill /T` | kills the process tree after a `launch --print` timeout | `launch.mjs:1190` | No — it kills the child it just started |

**`scripts/uia-probe.ps1`** (1168 lines, PowerShell + UI Automation) is the only thing in
the repo that can operate **another window**. **No `.mjs` ever invokes it**
(`grep -rn "uia-probe" scripts/*.mjs` returns nothing); it only runs if you run it. Its
own safety model: resolve controls by name in the UIA tree, **never by screen
coordinate**; abort if the target cannot be resolved to exactly one candidate
(`ProbeExitCode 2`); after writing into the composer with `SetValue` (`:772`) it **polls
the read-back** and restores the previous content on a mismatch (`:812`); and it
**never invokes the Send button's `InvokePattern`** (the only two occurrences, `:593`
and `:685`, merely test whether that pattern exists — there is no `.Invoke(` call).
Two real incidents are recorded in `docs/CHANGELOG.md`: it overwrote a 47-character draft
(restored byte-exactly) and it triggered `Hide sidebar` once. **It is an experiment, not
a product feature.**

---

## 5. What this library cannot protect against

**This section is the most important part of this document.** Every item is a real
limitation, not a disclaimer.

1. **It reads all of your conversation.** Transcripts contain the code you showed the
   AI, the errors you pasted, the paths you wrote. This library reads a **tail window**
   (1 MiB / 512 KiB) and writes only **excerpts** into its own ledgers — but how much a
   single read covers is fixed, while *what* is in that window is decided by your corpus,
   not by the library.
2. **Excerpts are written to disk too.** `tasks/runs/stop-hook-samples.jsonl` stores the
   **first 500 characters** of the last reply plus a tool-call summary
   (`SAMPLE_TEXT_LIMIT` at `stop-verify-hook.mjs:599`, `samplePathFor` at `:603`). That is
   deliberate: the sample layer exists to "collect the real distribution before adding
   rules". It is **on by default** and can be turned off with
   `OVERWATCH_STOP_VERIFY_SAMPLES=off` or `--no-sample-log`. **Know that it is on before
   you decide anything based on its absence.**
3. **The hooks block your tool calls and the end of a turn.** `pre-write-gate.mjs` may
   return `permissionDecision:"deny"` before your first file write; `stop-verify-hook.mjs`
   returns `{"decision":"block"}` when `OVERWATCH_STOP_VERIFY=block`, feeding the reason
   back to the model as the next instruction. The `.claude/settings.local.json` on this
   machine (gitignored, not in the repo) sets that switch to `block`.
4. **The stop path can be deleted by the model.** The L1 stop file
   (`pausePathsFor()` in `stop-verify-hook.mjs`: `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE`,
   plus the legacy `Overwatch/` file of the same name — either one counts) silences the
   gate immediately, but its own comment says: it "**can** be deleted by the model with
   Bash — but that is an operation that leaves a trace in the transcript and is auditable
   afterwards. This does not pretend to be safe."
   **Consequence of checking both**: deleting one location no longer lifts the stop; you
   have to remove every candidate (or point `OVERWATCH_STOP_VERIFY_PAUSE` at a path that
   does not exist). That is the price of failing safe.
5. **The gates fail open by default.** A crashed hook, a timeout, garbage input, an
   unreadable transcript — all pass (both hook headers give the reason: a broken gate
   must not stop you writing files or ending a session). **The cost: a broken gate looks
   exactly like "nothing to block".** The evidence is `allowReason` in the ledger, not
   "nothing was reported".
6. **It trusts the paths it reads.** `probe-relay.mjs` does not validate
   `messagingSocketPath` (§2); the stop gate reads `package.json` and friends from the
   `cwd` recorded in a transcript (§3). Both trust rests on "your home directory and your
   project directories are trustworthy".
7. **A host session started by `launch` inherits your **entire** environment.** `childEnv()` (`launch.mjs:409`) is `{ ...process.env }` plus a `PATHEXT` fallback — anything you did not hand it (including any environment variable holding a secret) is passed to the child unchanged. That is necessary (the host works from those variables), but it means "whatever is in this shell is in that session".
8. **No protection against an already-compromised machine.** A process that can read your
   home directory can read everything this library reads, and can also change its
   criteria — the hook scripts live in the repo.
8. **No dedicated security response, no bug bounty, and `main` is unprotected.** See
   "Supported versions".

---

## 6. Known residual risks (known to us, not fixed)

These are trade-offs kept on purpose, not things nobody thought of. They are listed so
you can judge the risk yourself. Entry numbers refer to `tasks/dev-findings.md`.

| Entry | Status | In one line |
|---|---|---|
| **`DF-030`** | `wontfix` | Hook ledgers under `tasks/runs/` contain **polluted rows that cannot be told apart from real ones** (test-written and session-written rows look identical; `sessionId` / `cwd` are mostly `unknown` / `null`). Cleaning them means *assuming* they are all from tests, and that assumption cannot be proven, so the dirty data stays. **Statistics from it may only be cut by time** (only rows after `2026-11-18 11:00` are clean) |
| **`DF-021` residual risk** | `open` | Archived observation logs and run ledgers **still live on the same disk in the same directory**: it survives "one file deleted by mistake", not "the directory deleted / disk failure / a cleaner sweeping old files". **There is no backup mechanism, and README must not claim one** |
| **`DF-026`** | `open` | Two tests in `overwatch.test.mjs` occasionally go red under concurrent load and have not been reproduced reliably. The damage is not wrong data — it is that **"all green" is an unreliable signal**, and CI reds on and off train people to ignore red |
| **`DF-034`** | `open` | The figure "50 real blocks, only 1 followed by a tool call" **cannot be reproduced** on this machine, and it was once used to argue that the Stop gate should not block. The comment should say "no reproducible data on this machine". **This is not a vulnerability, but it is a warning**: how strong this library's criteria are depends on real ledgers, and real `blocked` rows are currently very few |
| **`DF-032` / `DF-035` / `DF-037` / `DF-038`** | `wontfix` / `open` | Fabricated or unreproducible numbers written into comments and docs (the same failure mode recurred four times). **Security implication**: any claim citing a "measured number" from this repo should be treated as unverified rather than established |
| **`DF-039`** | `fixed` | The structure gate's "zero drive letters in the publishable area" check only recognised 7 fixed prefixes, so 8 real local paths reported green the whole time. After the rewrite the first run caught all 8. **Its lesson still holds**: a criterion that covers only part of its claim is as bad as no criterion |
| **`DF-013`** | `fixed` | Unsanitised `sessionId` / `project` / `hostState` let OSC 52 make a **read-only renderer rewrite your system clipboard**. Now everything goes through `sanitize()`. **It is listed because it is the sample of this library's most serious class of past defect**: cleaning was done on the detail page and not on the list page — two display paths, each fixed halfway |

**One inconsistency I found while verifying but which is not in the ledger** (stated
rather than hidden): the stop-file path in `stop-verify-hook.mjs` used to hard-code the
old directory name `'Overwatch'`, ignore the rename rule in `state-dir.mjs`
(`UntilDone` / `untildone`), and ignore `OVERWATCH_STATE_DIR`. **Fixed 2026-11-21**
(`DF-041` → `fixed`): it is now a family of candidate paths, and **any one of them
matching means paused**. The primary path comes first:

| # | Path |
|---|---|
| 1 | `$OVERWATCH_STOP_VERIFY_PAUSE` (explicit; if set, it is the only one) |
| 2 | `$OVERWATCH_STATE_DIR/stop-hook.PAUSE` |
| 3 | `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE` (POSIX `$XDG_STATE_HOME/untildone/`) |
| 4 | `%LOCALAPPDATA%/Overwatch/stop-hook.PAUSE` (legacy name, **kept for backward compatibility**) |

The direction is **deliberately opposite** to `resolveStateDir()`'s "new if it exists, else
old": that rule protects *data* (history must not look like it vanished), while this one
protects "the user asked us to stop" — so we would rather pass once too often than miss a
stop. The cost is in §5 item 4 (deleting one location no longer lifts the stop).
**Observability**: the `allowed-user-paused` row records `pauseHit` (the path that actually
matched), and `node scripts/pre-write-gate.mjs status --cwd <project>` lists all four
candidates and marks the matching one — you do not have to read source to know where the
file goes.

---

## 7. Known hardening (independently verifiable)

| Measure | Location | Notes |
|---|---|---|
| Terminal escape cleaning | `sanitize()` at `oversight-tui.mjs:106`; `ANSI_RE` / `stripAnsi()` in `tui-theme.mjs` | `stripAnsi` handles CSI **and OSC** (`\x1b]...`). The past defect was "the TUI wrote its own narrower, CSI-only regex", noted at `tui-theme.mjs:332` |
| One cleaning entry point | `viewOf()` in `oversight-tui.mjs` | Both the list page and the plain-text page take data from it; the render layer does not open a second path. This is the `DF-013` fix |
| Gate markers cannot be forged | `verifyMarkerSig()` at `pre-write-gate.mjs:1212` | HMAC-SHA256 plus `timingSafeEqual`; an `auto` marker without a valid signature is invalid; **there is no fail-open downgrade** ("no secret" ≠ "anyone's word counts") |
| The secret file cannot be written | `pre-write-gate.mjs:1515` | A write to the secret path is judged `secret-tamper` and is not allowed through as "the gate's own file" |
| Hook input is bounded | `readStdin()` (4 MiB) plus a time gate (`DEFAULT_BUDGET_MS` = 5000) in `pre-write-gate.mjs` | Over budget = pass and log: the user's write matters more than the verdict |
| A crashed hook cannot lock you out | both hooks fail open | `stop-verify-hook.mjs`, header "design principle 1": a gate you cannot get past is worse than a hundred unverified claims |
| Blocking is capped | `MAX_BLOCKS = 6` at `stop-verify-hook.mjs:89`; `RESET_AFTER_MS` at `:503` | Counted **per session total**, not consecutively — a gate that expires is not a gate |
| Ledger paths are masked | `maskPath()` at `launch.mjs:221`, `ledgerEntry()` at `:884` | Repo root / home / temp become `<repo>` / `<home>` / `<tmp>`; other drive paths become `<abs>/<basename>`. Two leaks happened once (`judge.detail` was passed through wholesale), caught by a test |
| Dedupe keys are hashed | `hook-dedupe.mjs:115` | Keys contain session ids and reply text, so they are hashed to filenames with `sha256` |
| No shell execution | `grep "shell: true"` over the whole repo returns nothing | Child processes always take an argument array |
| No third-party dependencies | No `package.json`; only `node:` builtins | There is no `npm install` step, and therefore no install-time scripts |

---

## 8. Hardening recommendations (for users)

- **Read the two hooks before installing them.** They are `scripts/pre-write-gate.mjs` and
  `scripts/stop-verify-hook.mjs`, and both are merged by hand into
  `.claude/settings.json` or `.claude/settings.local.json` (templates are in
  `templates/`). The default is `observe` (log only, always pass); blocking requires you
  to set `OW_PRE_WRITE_GATE=deny` / `OVERWATCH_STOP_VERIFY=block`.
- **Run a few days in observe before switching either on.** The ledger is at
  `tasks/runs/pre-write-gate/<date>.jsonl`; look at how many `would-deny` rows there are
  and for which tools.
- **If you do not want it writing anything into the repo**, point `OVERWATCH_STATE_DIR`
  outside the repo — both hooks and `hook-dedupe` honour that one variable.
- **If you do not want conversation excerpts on disk**: sample logging is on by default.
  Turn it off with `OVERWATCH_STOP_VERIFY_SAMPLES=off` or by passing `--no-sample-log` to
  the hook.
- **To silence the gates immediately**, create
  `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE` (the legacy
  `%LOCALAPPDATA%/Overwatch/stop-hook.PAUSE` works too), or point
  `OVERWATCH_STOP_VERIFY_PAUSE` somewhere else. Candidate paths and the direction of the
  rule are in §6, last item (`DF-041`, fixed).
  **To check you put the file in the right place**: `node scripts/pre-write-gate.mjs status
  --cwd <project>` lists every path being checked and marks the one that matched.
- **Check before pasting logs in public**: `tasks/runs/` holds session ids, local paths and
  tool-call paths, and `doctor` prints your home directory. None of that is redacted for
  you — redaction is your step.
- **Do not `git add -A`**: `tasks/runs/` and `.claude/.ow-*` contain session ids and the
  gate's signing secret.
- **Do not run `scripts/uia-probe.ps1` unless you know which window it is operating on.**
  It rewrites the composer of another session.
- **`main` has no branch protection**: if you fork and run this in production, add
  protection yourself and pin a commit hash.

---

> This document describes the implementation on `main` at the time of writing.
> **There is no version number to cite** — to check, run `git rev-parse --short HEAD`.
> Security claims answer to the code; where this document and the code disagree, the code
> wins, and an issue pointing that out is welcome.
