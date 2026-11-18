[简体中文](README.md) | English

<div align="center">

# UntilDone

**Give it the requirement once, and it gets finished in one pass.**

It makes the AI clarify the requirement before touching anything, then carries the
work through to the end — no "skeleton in round one, veneer in round two".
Cross-session monitoring exists only so you can see how far this pass actually got.

![CI](https://github.com/sqkl520/UntilDone/actions/workflows/validate.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518.20.4-blue?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)
![Tests](https://img.shields.io/badge/regression%20tests-1627%20passing-brightgreen?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**Zero dependencies** · **Nothing to install** · **Works without logging in** —
`git clone` then `node scripts/overwatch.mjs`

**[⚡ Quickstart](#-quick-start)** ·
[Capabilities](docs/CAPABILITIES.md) ·
[Guide](docs/GUIDE.md) ·
[Report an issue](https://github.com/sqkl520/UntilDone/issues)

</div>

> ⚠️ **Early-stage project.** No tags, no npm package; the repository is the release.
> Issues and suggestions are welcome — please [open an Issue](https://github.com/sqkl520/UntilDone/issues).
> If you find it useful, a star means a lot ⭐
>
> **This README does not track a version number.** The
> [Releases page](https://github.com/sqkl520/UntilDone/releases) is the source of truth.

---

## ✨ What problem it solves

Running five or six Claude Code sessions at once is normal by now. The friction
isn't switching windows — it's coming back hours later unable to tell **which
session is doing what, which one is stuck, and which one has been waiting on
you**:

- One threw a two-way question at you three hours ago and you never saw it
- Another said "fixed it" when all it did was swallow the error
- The rest are running, but you can't tell progress from spinning

UntilDone gives you visibility on all three: scan every transcript → judge the
state → notify only when it actually concerns you.
**It does not make decisions for you, and it never writes into a running session.**

### How this relates to the official `claude agents`

`claude agents --json` already lists every session, groups them by state, and
lets you dispatch and reply. **It has natively solved "see which sessions
exist"** — no point pretending otherwise. The two answer different questions:

```
claude agents --json  →  which sessions the host registered, busy / idle / blocked
scan-sessions.mjs     →  what those sessions are doing, stuck where
verify-claims.mjs     →  does "it's done" have a tool call behind it
```

**Only the third line is something the official tool does not do.**
Everything else is instrumentation around it.

---

## 🚀 Quick start

```bash
git clone https://github.com/sqkl520/UntilDone.git
cd UntilDone
node scripts/overwatch.mjs
```

That's a self-check: in about a second it tells you what this machine can and
cannot do, and whether anything is currently running. **It reports what it read,
and does not judge anything as passing for you.**

```
overwatch doctor · 8 prerequisites · budget 1000ms (prerequisites only, no corpus scan)
[   0ms] node        v26.12.1 · tool floor 18.20.4 met · test floor 20.16.0 met
[ 203ms] transcripts <home>/.claude/projects · 71 (incomplete) projects · 415 .jsonl (floor)
[  39ms] sources     jobs 11 state.json · sessions 15 .json
[   2ms] claude/     agents 12 · skills 1
[  62ms] gate        mode=observe · brake=halt · marker=absent
[ 409ms] watcher     launcher present · health says unrecognised
[   1ms] platform    win32 · desktop notifications available (Toast)
[  80ms] plan        <run-id> · 2/5 done · 1 failed · 2 unclaimed
total 795ms / budget 1000ms — prerequisites met, scan can run
```

**The panel looks like this** (`node scripts/oversight-tui.mjs`, real output,
project names replaced):

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
 project B                                          2s  `SendMessageW` returns `LRESULT`, needs converting to `HICON`.
 project C                                         12s  Description updated, but **Topics is empty**.
 project D                                         28s  The guard is solid (regex covers newlines/whitespace).
```

Three things worth noticing:

- **Line one is a verdict, not a title**: "1 waiting on you" leads; "12 running" is context
- **"watcher ✗" instead of a green check**: it isn't running, which affects how much
  the "1" above can be trusted, so it says so
- **"the other 1 thing was fine" instead of "all clear"**: it only vouches for what it checked

### Core commands

```bash
node scripts/scan-sessions.mjs --days 3        # one line per session: state / calls / idle
node scripts/verify-claims.mjs --days 3        # does "it's done" have evidence
node scripts/oversight-tui.mjs                 # panel: list → Enter detail → c copies relay draft
node scripts/watch.mjs --inbox                 # who is waiting on you
node scripts/check-structure.mjs               # structural hard gate
```

Every capability and its exact command lives in
[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — the hard gate verifies that the
scripts and flags listed there actually exist.

---

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

Seven-day window, 226 completion claims:

```
SUPPORTED      15    6.6%
STALE_ONLY      3    1.3%
NO_EVIDENCE    46   20.4%
UNKNOWN         3    1.3%
UNCHECKABLE   159   70.4%   ← seven in ten cannot be judged
```

**70.4% cannot be judged.** That is not a defect, it's the boundary: it only
works on assertions that have a specific tool call to compare against (build
succeeded, tests passed, push completed, file count). Everything else is filed
under `UNCHECKABLE` rather than guessed at. Calling "cannot judge" a "looks
fine" is the one mistake this project least wants to make.

---

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

---

## ⚠️ Known limitations

Not a to-do list — things that are known and deliberately not fixed:

| Limitation | Measured | Why it stays |
|---|---|---|
| Online stop classification is effectively dead | **95.4%** of the online path judges `UNCLASSIFIABLE` | Structural: telling "a question" from "finished" needs the next message, which does not exist yet while online |
| Notification suppression accuracy cannot be tested | no automated measurement | Needs a human to label "should this have fired"; no ground truth |
| `needs` is sparse | 2 of 16 jobs carry `needs`, 1 carries `suggestedReply` | The host writes them only when blocked |
| `STALLED` is nearly unreachable | 0.018% of the corpus | See "six states" above |

Two things unrelated to this library that still shape how you use it:

- **Multi-agent is not free.** Anthropic reports multi-agent systems burn roughly
  **15×** the tokens of chat, and token usage alone explains **80%** of the
  performance variance — the gain comes from spending more tokens, not from a
  smarter architecture. The MAST paper (1600+ traces) found both "improve the
  role specs" and "improve coordination" interventions insufficient. The
  `.claude/agents/` methodology here belongs to the second category; don't expect
  it to move results on its own.
- **Scanning is post-hoc reconstruction, not live.** Each file is read from the
  last 4 MB; the main transcript uses the trailing 1200 records. To know a
  session's real state right now, the most reliable thing is to open it.

**Good enough for**: "which of these sessions is waiting on me, which is claiming
a false completion". **Not good enough for**: automatic relay, automatic
decisions — and the reason is a platform wall, not a missing feature.

---

## 🔧 Why automatic relay is impossible

This boundary is spelled out because it is easily mistaken for "not built yet":

- Host sessions are **separate processes** with no supported injection interface.
  Writing into a running session means synthesising input, which the platform
  explicitly blocks (UIA, IPC pipes, and the CDP debug port were all tested and
  are all unavailable).
- So the library can only **generate a draft** (the `c` key copies it) for you to
  paste and send.
- That isn't a degradation — it's stating where the platform's wall actually is.

---

## 📁 Layout

```
UntilDone/
├─ .claude/agents/       12 role definitions (loaded directly by the host)
├─ .claude/skills/       dispatch workflow
├─ docs/                 entry point docs/README.md · CAPABILITIES · GUIDE
│                        spec/ current facts · adr/ decisions · research/ measurements
│                        design/ entirely unimplemented; see docs/design/README.md
├─ scripts/              scan / watch / verify-claims / stop-verify-hook / TUI / gates
└─ tasks/                two ledgers: out-of-scope findings, accepted deviations
```

Start at [`docs/README.md`](docs/README.md) — it routes by "what do you want to
know" and explains that the four document families carry different weight
(`spec/` is current fact, `design/` is entirely unimplemented, `research/` goes
stale).

## 🤝 Contributing

- Run the tests: `node --test scripts/` (needs Node ≥ 20.16, due to `import.meta.dirname`)
- Structural gate: `node scripts/check-structure.mjs`
- Both must be green before a commit; see [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: **do not open a public issue** — see [SECURITY.md](SECURITY.md)

## 📄 License

MIT — see [LICENSE](LICENSE)
