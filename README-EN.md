[简体中文](README.md) | English

<div align="center">

# UntilDone

**Give it the requirement once, and it gets finished in one pass.**

It makes the AI clarify the requirement before touching anything, and match "it's done"
against evidence before the turn ends — no "skeleton in round one, veneer in round two".
Cross-session monitoring exists only so you can see how far this pass actually got.

![CI](https://github.com/sqkl520/UntilDone/actions/workflows/validate.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518.20.4%20%C2%B7%20tests%2020.16%2B-blue?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)
![Tests](https://img.shields.io/badge/regression%20tests-1792%20passing-brightgreen?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**Zero dependencies** · **Nothing to install** · **Evidence checking works without logging in** —
`git clone`, then `node scripts/overwatch.mjs`

**[⚡ Quick start](#-quick-start)** ·
[Capabilities](docs/CAPABILITIES.md) ·
[Guide](docs/GUIDE.md) ·
[Report an issue](https://github.com/sqkl520/UntilDone/issues)

</div>

> ⚠️ **This is an early-stage toolkit built by a high-school student with AI assistance (vibe coding).**
> Issues, questions and suggestions are all welcome —
> please [open an Issue](https://github.com/sqkl520/UntilDone/issues).
> If you find it useful, a star means a lot ⭐
>
> **It is not an app and not a Claude Code plugin**: no installer, no release, no npm package —
> **the version you get is whatever `main` was when you cloned it.** Internal stage numbers live at the
> top of [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (currently `0.2.0` + `[Unreleased]`); that is a
> work log, not a downloadable version. To see what your copy can actually do, run
> `node scripts/overwatch.mjs` — it reports what it read and does not judge anything as passing for you.

---

## ✨ Features

**Requirement handoff: three gates**

- **Ask before the first write** — before the first file write, the transcript must already contain N de-duplicated questions (`ask.minQuestionsBeforeWrite`, default `0` = the rule does not exist)
- **Prove you read the project** — the first write requires ≥3 distinct files read (`minReads`); the Edit side has a second rule: you must have read the very file you are editing
- **Match "done" against evidence** — the Stop hook looks for a tool call that backs the claim; `NO_EVIDENCE` / `STALE_ONLY` / `FAILED_ONLY` block, anything unjudgeable is let through
- **Mechanical reconciliation on delivery** — when a subagent says which files it produced, `claim-ledger.mjs verify` cross-checks expectation / self-report / disk / transcript traces

**Evidence checking**

- **Assertion vs evidence** — four verdicts, `SUPPORTED` / `STALE_ONLY` / `NO_EVIDENCE` / `UNCHECKABLE`; no guessing, no merging
- **Freshness reasoning** — not "a successful build was found" but "that success was voided by the source change after it"
- **Ten assertion families, nine with deterministic evidence** — test counts, builds, file counts, artifact hashes, commits, pushes, PR/CI, runtime probes, and vague completions with no metric at all; `todos` ("backlog cleared") has **no** evidence source and is reported separately, outside the four-way ratio
- **Usable in CI** — exits non-zero when any `NO_EVIDENCE` exists (`--exit-zero` forces success)
- **Explains itself** — `--explain 1` prints the matched calls, the last source edit, and why it judged as it did

**Session observability**

- **One table for every session** — one line each: state / calls / novelty / idle / reason
- **Passes the host's own words through** — the `[BLOCKED]` row is followed by the host-written "waiting for input / suggested reply"
- **Who is waiting on you** — `watch.mjs --inbox`; exit code 3 distinguishes "genuinely nothing" from "empty, but the daemon isn't running"
- **Panel** — list → `Enter` for detail → `c` copies a relay draft; falls back to a plain-text snapshot outside a TTY
- **Machine-readable** — `--json` is the same data; the human output is rendered from it, not a second implementation

**Self-check and ledgers**

- **One entry point** — `overwatch.mjs` reports 8 prerequisite facts on a **1000 ms budget and says so when it overruns** (measured 1133 ms here; the last line prints "1133ms / budget 1000ms"), without scanning the corpus
- **Start a session with the payload attached** — `launch`; `--dry-run` shows the exact command line first, `--verify` checks the payload only and needs no login
- **Structural hard gate** — 23 checks (test-count reconciliation, document paths and commands, capability list, links, ledger format, …)
- **Two ledgers** — `tasks/dev-findings.md` (out-of-scope findings), `tasks/accepted-deviations.md` (known deviations)

> The **exact command** behind each capability lives in [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) —
> the hard gate verifies that the scripts and flags listed there really exist. The "cannot do" table
> is there too, with grounds, precisely so it doesn't read as "not built yet".

## 🚀 Quick start

1. Check Node: **≥ 18.20.4** to run the tools, **≥ 20.16.0** to run the tests (it uses `import.meta.dirname` and `process.getBuiltinModule`)
2. Clone and self-check (nothing to install, no login, no `package.json`)

   ```bash
   git clone https://github.com/sqkl520/UntilDone.git
   cd UntilDone
   node scripts/overwatch.mjs
   ```

3. Read those 8 lines. **Each one only reports what it read — no green lights** (real output from one machine, paths replaced with placeholders)

   ```
   overwatch doctor · 8 prerequisites · budget 1000ms (prerequisites only, no corpus scan)
   [   0ms] node        v26.12.1 · tool floor 18.20.4 met · test floor 20.16.0 met
   [ 209ms] transcripts <home>/.claude/projects · 81 (incomplete) projects · 509 .jsonl (floor) · newest 2h ago
   [   8ms] sources     jobs 11 state.json · sessions 10 .json
   [   2ms] claude/     agents 12 · skills 1 · settings.local.json present
   [  47ms] gate        mode=observe · brake=halt · marker=exists {...}
   [ 624ms] watcher     launcher present · shortcut present · health says unrecognised · data dir <state>
   [   1ms] platform    win32 · desktop notifications available (Toast) · autostart via Startup folder
   [ 116ms] plan        <run-id> · 1/5 done · 2 failed · 2 unclaimed · budget 50% · longest limit 8 min
   total 1133ms (1013ms in-process + 120ms startup) / budget 1000ms — prerequisites met, scan can run
   ```

   The three empty states are distinct: root missing → `exit 2`, root present but unreadable → `exit 3`,
   root present with 0 entries → `0`.

4. Pick a direction (the entry point only routes; it does not run these for you)

   ```bash
   node scripts/scan-sessions.mjs --days 3        # one line per session: state / calls / idle
   node scripts/verify-claims.mjs --days 3        # does "it's done" have evidence
   node scripts/oversight-tui.mjs                 # panel: list → Enter detail → c copies relay draft
   node scripts/watch.mjs --inbox                 # who is waiting on you
   node scripts/check-structure.mjs               # structural hard gate
   ```

**The panel looks like this** (`node scripts/oversight-tui.mjs --plain`, real output, project names replaced):

```
1 waiting on you · 12 sessions running · 3 stopped
plain-text snapshot (interactive view needs a terminal) · window last 1 day · data 0s ago

 claims off   … 4 questionable · d for evidence
 watcher      ✗ not running (jobs 2.2d / probe 2.2d stale) · fix this first
 ✓ the other 1 thing was fine

needs you (1)
 project A                                         1.9d  Enter for original text
    waiting on: login required — run /login

running (12)
 project B                                          2s  build still running, nothing written yet.
 project C                                         12s  Description updated, but **Topics is empty**.
 project D                                         28s  The guard is solid (regex covers newlines/whitespace).
```

Three things worth noticing:

- **Line one is a verdict, not a title**: "1 waiting on you" leads; "12 running" is context
- **"watcher ✗" instead of a green check**: it isn't running, which affects how much the "1" above can be trusted, so it says so
- **"the other 1 thing was fine" instead of "all clear"**: it only vouches for what it checked

## ❓ FAQ

| Question | Answer |
|---|---|
| I put the pause file under `Overwatch` per the old docs — does it still work without renaming the folder? | Yes, both are honoured. `%LOCALAPPDATA%/UntilDone/stop-hook.PAUSE` is the primary path and the old `Overwatch` name is **deliberately kept** (`DF-041`). To see whether you got it right: `node scripts/pre-write-gate.mjs status --cwd .` lists every path it checks and marks the one that hit |
| I exported `OVERWATCH_STOP_VERIFY=block` in my shell and the gate still doesn't block | Hook environment is inherited from the **host process**, not your terminal. On the desktop app you must put it in the `env` block of `.claude/settings.local.json`. This failure mode is the worst kind: you believe the gate is on while it has been observe-only the whole time, and nothing tells you |
| I installed the pre-write gate and nothing happens | Two things default to off: with `OW_PRE_WRITE_GATE` unset the mode is `observe` (writes a record, allows everything), and `ask.minQuestionsBeforeWrite` defaults to `0` (rule does not exist). Run for a few days and look at the `would-deny` rows in `tasks/runs/pre-write-gate/<date>.jsonl` before turning it on |
| Why is `--days 30` so slow? | It scans by **file**, not by day. Cost grows with the corpus, not linearly with the window: at most 4 MB of tail per session, at most 100 subagents expanded. Use `--days 3` day to day. **Don't trust any hardcoded number of seconds** — including the ones this README deliberately doesn't state |
| Does scanning interfere with sessions that are running? | No. It only reads `.jsonl` under `~/.claude/projects/` and `state.json` under `~/.claude/jobs/` — no writes, no locks, no signals |
| Can the panel change a session's state? | No. State is **computed**, not stored — there is no "state field" to flip. The panel only renders what `scan-sessions.mjs --json` returns; it offers no fake buttons |
| My session has shown `EXPLORING` for three days — is it stuck? | Probably not. `idle` over one hour is reported as dormant (`reason: dormant`), and `FAILED` **only** comes from the host, never inferred from "quiet for a long time". The most reliable signal is to open that session and look |
| `claude agents --json` already lists sessions. Why use this too? | They answer different questions. The former says "which sessions the host registered, busy/idle/blocked right now" (no `failed`, no novelty / idle duration / subagent tree / tokens); the latter says "what those sessions are doing and where they're stuck". Use `scan` to decide whether to step in, `claude agents` to confirm a session is really registered and reachable |
| Does `UNCHECKABLE` being 80% mean everything is fine? | No — it means **it could not be judged**. It only works on assertions that have a specific tool call to compare against (build succeeded, tests passed, push completed, file count). Calling "cannot judge" a "looks fine" is the one mistake this project least wants to make |
| Can the AI send a reply into the target session automatically? | No, and not because it's unimplemented — see [Why automatic relay is impossible](#-why-automatic-relay-is-impossible) |
| The host provides `needs`, so why is it empty most of the time? | `needs` / `suggestedReply` are written by the host **only when blocked**. Measured on one machine: 2 of 16 jobs carried `needs`, 1 carried `suggestedReply` |
| I edited a role in `.claude/agents/`. How does it take effect? | New sessions load it automatically; open sessions do not hot-reload (roles are read at startup). Then run `node scripts/check-structure.mjs` — it validates frontmatter, `description` length, and whether a read-only role has quietly gained `Edit`/`Bash` |
| A gate went red / a test went red. Now what? | See [`docs/GUIDE.md`](docs/GUIDE.md) §10 ("what to do when something breaks") and work through the error class by class. The gate must be run from the **repository root**; otherwise it treats your current directory as the root |

## 🔧 How it works

```
your session (host: claude)
   │  called back twice per turn; there is no long-running process of ours
   ├─ PreToolUse ──► scripts/pre-write-gate.mjs ──► tasks/runs/pre-write-gate/<date>.jsonl
   │                   rules: has the project been read / have N questions been asked
   └─ Stop ────────► scripts/stop-verify-hook.mjs ─┐
                                                   │ reuses the same judging code
   ~/.claude/projects/*.jsonl (read-only)──────────┴─► detectClaims → findEvidence → classifyEvidence
                                                           │
                   scripts/scan-sessions.mjs ◄─────────────┘ (same transcripts, tail only)
                             │ --json
                             ▼
             oversight-tui.mjs (panel) / watch.mjs (inbox, notifications, health)
```

Two rules run through the whole repository: **read only what the host left behind, write only your own
ledger**; and **when it can't be judged, say so — never treat missing as evidence**.

### Tech stack

| Layer | What it uses |
|---|---|
| Runtime | Node (≥ 18.20.4 for tools, ≥ 20.16.0 for tests), **no `package.json`, no `node_modules`** |
| Size | 54 production scripts + 43 test files (1792 `test(` calls, reconciled by the hard gate against source) |
| Surface | host hooks (`PreToolUse` / `Stop`) + command line + plain text / JSON output |
| Roles | 12 markdown role definitions under `.claude/agents/` + 1 dispatch skill (loaded by the host directly) |
| Storage | host transcripts are read-only; own state lives in `tasks/runs/` (gitignored) and a user state directory |
| CI | GitHub Actions: [`validate.yml`](.github/workflows/validate.yml) — structure gate + payload layout + full test suite |

<details>
<summary><b>Design note 1: why hooks, not a daemon</b></summary>

Something that can "stop this turn" has to be invoked at the **turn boundary**, and only the host
knows where that is. A daemon of our own would either poll transcripts (post-hoc reconstruction, too
late to block) or inject into a running session (a path the platform blocks).

So the real interception surface is the host's two hooks:

- `PreToolUse` — receives `tool_name` and `tool_input` **before** the tool runs, and may return `permissionDecision: "deny"`
- `Stop` — receives `transcript_path` when the turn ends, and may return `{"decision": "block"}` to keep the model going

Two traps found by measurement: `exit 2` is **not** equivalent to `{"decision":"block"}` (it is recorded
as `Failed with non-blocking status code` and the turn ends anyway); and a `timeout` below 60 s gets the
hook silently killed by the host, which looks exactly like "the hook ran but had no effect".

</details>

<details>
<summary><b>Design note 2: why all three gates default to off</b></summary>

The cost of a false block is asymmetric. Blocking one honest session costs far more than letting one
boastful claim through — the user turns the hook off entirely, and then they lose the record too. Hence:

- The pre-write gate has three modes, `observe` / `warn` / `deny`, and **defaults to `observe`**, writing `would-deny` rows
- The stop gate defaults to `off`: it writes a record and always `exit 0`
- `ask.minQuestionsBeforeWrite` defaults to `0`, which means the rule **does not exist** (behaviour after installing is byte-for-byte unchanged, pinned by a test)
- The stop gate is `fail-open` and **cannot be configured fail-closed**: hook crash, timeout, garbage input, unreadable transcript — all allow
- It only blocks "insufficient evidence", never "contradictory evidence": `UNKNOWN` / `UNCHECKABLE` pass, because **not having read it is not the same as it not happening**
- It caps itself at 6 blocks (`MAX_BLOCKS = 6`; because the counter decays over time this really means "6 per 10 minutes") instead of relying on the host's `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (an implementation detail that moves between versions)

</details>

<details>
<summary><b>Design note 3: why the panel doesn't pretend to be live</b></summary>

`scan-sessions.mjs` is **post-hoc reconstruction**: 4 MB of tail per file, the trailing 1200 records of
the main transcript, 400 records per subagent up to 100 subagents. That isn't laziness — it's the only
way to get through hundreds of transcripts in under a minute.

The cost is stated up front: the `liveness` field tells you how fresh that reconstruction is
(`reconstructed` / `stale` / `insufficient-sample`), and the panel's top line ("data 0s ago") is it.
To know a session's real state right now, the most reliable move is still to **open it and look**.

</details>

## 🎯 The one difference worth arguing about: assertion vs evidence

This is the whole reason the project exists. A real output:

```
AI said: "## Delivered: **BUILD SUCCESS — 1341 tests green**"
evidence: build invoked 5 times (2 succeeded); last success 11-16 19:58;
          source modified again at 11-16 20:56
verdict: STALE_ONLY (build/compile success)
advice:  the success was invalidated by a later source change. Re-run
         `mvn -q -DskipTests package` to produce evidence after the last edit
```

**Look at the third line.** It doesn't say "a successful build was found". It says
**that success no longer holds**, because the source changed after it. That is
reasoning about the freshness of evidence, not keyword matching.

Four verdicts:

| Verdict | Meaning |
|---|---|
| `SUPPORTED` | the assertion has a matching call, and the call came after the last relevant change |
| `STALE_ONLY` | a matching call exists, but the code changed afterwards — **the success is void** |
| `NO_EVIDENCE` | said it was done, no matching call found anywhere |
| `UNCHECKABLE` | the assertion type is outside what can be checked — **said plainly, not guessed** |

### The honest numbers

Seven-day window, measured 2026-11-18: 192 checkable assertions.

```
SUPPORTED      20   10.4%
STALE_ONLY      3    1.6%
NO_EVIDENCE    11    5.7%
UNKNOWN         3    1.6%
UNCHECKABLE   155   80.7%   ← eight in ten cannot be judged
```

**80.7% cannot be judged.** That is not a defect, it's the boundary: it only
works on assertions that have a specific tool call to compare against (build
succeeded, tests passed, push completed, file count). Everything else is filed
under `UNCHECKABLE` rather than guessed at. Calling "cannot judge" a "looks
fine" is the one mistake this project least wants to make.

These numbers drift as the corpus grows — run `node scripts/verify-claims.mjs --days 7`
to see yours. Do not quote the denominator here as a constant. Re-running that same
command while writing this README gave `172 assertions: 10 SUPPORTED / 4 STALE_ONLY /
3 NO_EVIDENCE / 1 UNKNOWN / 154 UNCHECKABLE` — **different counts, same shape**. That is
why every number here comes with a command: a number you can re-run is evidence.

## 📋 Six states, only three of them drive an action

The code has `EXPLORING` / `PRODUCING` / `STALLED` / `FAILED` / `BLOCKED` /
`WAITING`, but the real distribution is extremely lopsided. Measured
2026-10-31 across 129 sessions' final states:

| State | Hits | Note |
|---|---|---|
| `EXPLORING` | 122 | the final state of most sessions |
| `PRODUCING` | 4 | real writes inside the window |
| `BLOCKED` / `FAILED` | 2 / 1 | reported by the host, not inferred |
| `WAITING` | 0–1 | live host state; vanishes the moment you speak |
| `STALLED` | **0** | 10 hits across 56,809 sliding windows (0.018%), never as a final state |

**Do not use this as a state machine.** Only the host-reported ones can drive an
action. Notifications fire on `WAITING` / `BLOCKED` / `FAILED` / `ASKED`; the
first three come from host files rather than inference, and `ASKED` is inferred
from transcript text under a stricter gate.

Re-run on 2026-11-21 over the default 7-day window (524 sessions): `EXPLORING 511 / PRODUCING 10 /
BLOCKED 3` — no `FAILED`, no `WAITING`, no `STALLED` at all. Same shape as two months
earlier, which means "drive a re-run or a re-decomposition off `EXPLORING`" has never
actually held.

## ⚠️ Known limitations

Not a to-do list — things that are known and deliberately not fixed:

| Limitation | Measured | Why it stays |
|---|---|---|
| Online stop classification is effectively dead | **95.4%** of the online path judges `UNCLASSIFIABLE` | Structural: telling "a question" from "finished" needs the next message, which does not exist yet while online |
| Notification suppression accuracy cannot be tested | no automated measurement | Needs a human to label "should this have fired"; no ground truth |
| `needs` is sparse | 2 of 16 jobs carry `needs`, 1 carries `suggestedReply` | The host writes them only when blocked |
| `STALLED` is nearly unreachable | 0.018% of the corpus | See "six states" above |
| The checklist mechanism misses real usage | 7-day window, sandboxes excluded: 72 transcripts, 54 dispatched (75%), **1 used a checklist (1.4%)** | A gate would only apply to the small set already following the process — the set that least needs it |

Two things unrelated to this library that still shape how you use it:

- **Multi-agent is not free.** Anthropic reports multi-agent systems burn roughly
  **15×** the tokens of chat, and token usage alone explains **80%** of the
  performance variance — the gain comes from spending more tokens, not from a
  smarter architecture. The MAST paper (1600+ traces) found both "improve the
  role specs" and "improve coordination" interventions insufficient. The
  `.claude/agents/` methodology here belongs to the second category; don't expect
  it to move results on its own.
- **Scanning is post-hoc reconstruction, not live.** To know a
  session's real state right now, the most reliable thing is to open it.

**Good enough for**: "which of these sessions is waiting on me, which is claiming
a false completion". **Not good enough for**: automatic relay, automatic
decisions — and the reason is a platform wall, not a missing feature.

## 🚧 Why automatic relay is impossible

This boundary is spelled out because it is easily mistaken for "not built yet":

- Host sessions are **separate processes** with no supported injection interface.
  Writing into a running session means synthesising input, which the platform
  explicitly blocks (UIA, IPC pipes, and the CDP debug port were all tested and
  are all unavailable).
- So the library can only **generate a draft** (the `c` key in the panel copies it)
  for you to paste and send.
- That isn't a degradation — it's stating where the platform's wall actually is.

## 📌 Current status

> Last updated 2026-11-21. This table records **implementation state only**, not planned
> `fixN` rounds — there are no tags and no releases; `main` is the version.

**The three gates, one by one:**

| Gate | Where | Status |
|---|---|---|
| Clarify the requirement before work | `scripts/pre-write-gate.mjs` (`PreToolUse`) | ✅ **Implemented, off by default.** `ask.minQuestionsBeforeWrite` defaults to `0` = rule absent; even when on, it counts questions, it cannot judge whether they were good ones |
| Decompose into a checklist you approve | `scripts/claim-ledger.mjs` + `scripts/validate-run.mjs` | ⚠️ **Tools exist, no gate.** Checklist usage measured at 1.4% (sandboxes excluded), so it doesn't reach real usage and no gate was added |
| Check each item landed on disk | `scripts/stop-verify-hook.mjs` (`Stop`) | ✅ **Implemented, defaults to `off` (record only)**; turned on to `block` on the author's machine. 2 of 355 ledger verdicts were real blocks |

**Modules:**

| Module | Status |
|---|---|
| Single entry point / 8-prerequisite self-check | ✅ done (1000 ms budget, three empty states kept distinct) |
| Session scan (six states, novelty, subagent tree, host stream) | ✅ done |
| Panel (list / detail / plain-text fallback / copy draft) | ✅ done |
| Assertion vs evidence (ten families, four verdicts + freshness) | ✅ done |
| Pre-write gate (read proof / question count / three modes / brake) | ✅ done, **defaults to observe** |
| Stop gate (fail-open, blocks only insufficient evidence, self-capped) | ✅ done, **defaults to off** |
| Output reconciliation (expectation / self-report / disk / transcript) | ✅ done |
| Background daemon + desktop notifications + autostart (Windows) | ✅ done (`install-watcher.mjs`) |
| Automatic relay / auto-send into a target session | ❌ platform-blocked, will not be built (see above) |
| Live state | ❌ post-hoc reconstruction, not faked (see "how it works") |
| Checklist gate | ⚠️ none, because of coverage (see "known limitations") |

## 📦 Building and verifying

**There is no build step** — no `package.json`, no `node_modules`, no compiled output.
"Building" this repository means running the gates.

**Requirements**: Node ≥ 18.20.4 (tools) / ≥ 20.16.0 (tests).

```bash
node scripts/check-structure.mjs     # structural gate: 23 checks, green only at 0 violations
node scripts/check-links.mjs         # relative doc links resolve (170 .md files, 0 broken)
node --test scripts/                 # full regression: 43 files, 1792 tests
```

`check-structure.mjs` and the full test suite **must both be green before a commit**. Both run in
seconds to half a minute, and CI runs the same set ([`validate.yml`](.github/workflows/validate.yml)):

```yaml
- node scripts/check-structure.mjs      # structure / syntax / doc consistency / capability list
- node scripts/build-payload.mjs --verify-self   # .claude/ payload layout
- node --test <all test files>          # in two batches: 43 fast files, then the two spawn-heavy ones serially
```

> The two batches aren't fussiness: `launch.test.mjs` spawns the host 28 times and competes with the
> other files at the default concurrency — measured at 116 s and timing out, versus 20 s. Split, the
> total is shorter and stable.

## 🤝 Development and contributing

This is a small project a high-school student builds after class. The code isn't pretty, but every
rule has a test pinned to it, and every "fixed" requires negative evidence — put the bug back and the
test or the gate must go red.

- **Contributing guide**: [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to report, how to send a PR, code conventions and the definition of "green".
- **When reporting a bug, include**: the output of `node scripts/overwatch.mjs`, `node --version`, and reproduction steps. It only reports facts, which is exactly what triage needs.
- **Please open an Issue before writing code**, so the work isn't wasted.
- **Security reports**: **do not open a public issue** — see [`SECURITY.md`](SECURITY.md).
- **Running the tests**: `node --test scripts/` (1792 regression tests; **that number is reconciled by the
  hard gate against `test(` calls in source, so a wrong value goes red** — copy it, don't hand-count.
  The live run reports a few more, because subtests are counted separately).

> **No contributor wall and no star chart here, on purpose.** The star count is 0, so a star-history
> chart would render empty, and the two GitHub accounts in the commit log are the same person. Both
> can be added once there is genuinely a second person — a chart with only yourself on it makes the
> project look more established than it is.

## 📚 Documentation

> Full index at [`docs/README.md`](docs/README.md) — it routes by "what do you want to know" and
> explains that the four document families carry different weight (`spec/` is current fact,
> `design/` is entirely unimplemented, `research/` goes stale).

| Document | Contents |
|---|---|
| [`docs/FOR-USERS.md`](docs/FOR-USERS.md) | **Onboarding for new users**: every claim is followed by a command you can run yourself |
| [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) | Capability → runnable command; the "cannot do" table comes with grounds |
| [`docs/GUIDE.md`](docs/GUIDE.md) | User manual: how to read the output, what to do when it breaks |
| [`docs/FACTS.md`](docs/FACTS.md) | Measured facts, one per line: evidence level + re-run command + refuted conclusions |
| [`docs/spec/state-model.md`](docs/spec/state-model.md) | Single source of truth for state judging (thresholds, six states, why "long gap ⇒ failure" was deleted) |
| [`docs/spec/dispatch-contract.md`](docs/spec/dispatch-contract.md) | How to dispatch, what to give each agent |
| [`docs/spec/evidence-discipline.md`](docs/spec/evidence-discipline.md) | How to write a finding, how to use the ledgers |
| [`docs/spec/relay-protocol.md`](docs/spec/relay-protocol.md) | When relay fires, how the draft is written |
| [`docs/adr/`](docs/adr/) | Decision records: why this shape, why honest degradation, why asking counts as investment |
| [`docs/design/README.md`](docs/design/README.md) | Design archive index — **all unimplemented**; don't read it as a capability list |
| [`docs/research/README.md`](docs/research/README.md) | Measurement index + **the refuted-conclusions table** (check it before citing anything) |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Change log by stage (including failures and self-invalidating rules) |

## ⚖️ License and acknowledgements

MIT — see [`LICENSE`](LICENSE).

- The evidence grading scheme (T0 assertion / T1 static text / T2 re-runnable / T3 end-to-end /
  T4 counterfactual) comes from this project's own
  [`docs/spec/2026-11-02-autorelay-acceptance.md`](docs/spec/2026-11-02-autorelay-acceptance.md) and is still in use.
- The dual-layer workspace (control layer / published layer), four-part evidence discipline, and
  write-scoped tool allowlists were structurally borrowed from a similar project — but its `.gitignore`
  was **deliberately not** copied, because ignoring `.claude/` and `tasks/` would be fatal here.
- Thanks to [Claude Code](https://claude.com/claude-code) for the hook interface — without the
  `PreToolUse` and `Stop` interception points, half of this project (the gates) would have nowhere to attach.
