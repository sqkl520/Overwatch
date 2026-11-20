[简体中文](CONTRIBUTING.md) | English

# Contributing

No build step, no dependency install, no package manager. If you can run `node`,
you can run everything here.

## What this project is

UntilDone: it makes the AI clarify the requirement before touching anything, then
carry the work through in one pass — no "skeleton in round one, veneer in round two".
It ships as a **plain Claude Code config library**: markdown role definitions plus
zero-dependency Node scripts, with no daemon, no database, no watch loop
(`docs/adr/0001-config-only.md`). Cross-session monitoring, state verdicts, the TUI
and the relay drafts are **secondary capabilities** of this framework, not its
definition.

Three honest things up front, so you do not wait for something that is not coming:

- **One maintainer, no response commitment.** There is no deadline promised for
  issues or pull requests. Only security reports have 7/14/90-day targets, and
  `SECURITY.md` says of them: "These are targets, not a contract."
- **The product goal is not yet supported by this project's own data.** "Finished
  in one pass" is the goal, not an accomplished fact: in README, the section on the
  three gates says the **middle gate is not implemented** and the closing gate
  defaults to observe mode (it logs, it does not block);
  `docs/adr/0004-ask-is-investment.md` §3.1 lists what **cannot be claimed**
  (including "this method improves efficiency" and "asking early reduces rework");
  and 80.7% of the checkable claims in README's measurement came out `UNCHECKABLE`.
  Everything under `docs/design/` is **not implemented** — do not read the roadmap
  as the current state.
- **Some boundaries are the platform's wall, not a TODO.** For example, it cannot
  deliver a message into a running session: host sessions are separate processes
  with no supported injection interface (README, "why it cannot relay
  automatically"). Those issues get an explanation, not a schedule slot.

If that is acceptable, read on. **Pull requests do get read carefully** — but what
gets read is the evidence (negative tests, traceable sources), not the wording.

## Reporting a problem

**Search the [issues](https://github.com/sqkl520/UntilDone/issues) first**, closed
ones included, then skim the "conclusions that have been overturned" table in
`docs/research/README.md` — several symptoms that look like bugs have their root
cause recorded there.

Use the template (`.github/ISSUE_TEMPLATE/bug_report.md`). Without each of these it
cannot be investigated:

| What | Why |
|---|---|
| **The commit hash you cloned** (`git rev-parse --short HEAD`) | There are no tags and no releases; `main` is the release, so the hash is the only version identifier |
| **The whole block printed by `node scripts/overwatch.mjs`** | Node version and platform (the `node` and `platform` lines) live there. **It does not report terminal type or shell** — fill in those two lines from the template yourself |
| **The exact commands, in order** | Any difference in `--days`, `--project` or an `OW_*` environment variable can change the answer |
| **Corpus shape** | How many transcripts, how large, and whether the session was live or finished — every verdict here is a **post-hoc reconstruction**, so the corpus decides what you see |
| **Which lines are wrong** | Paste them, **redacted first**: project names, local paths, transcript excerpts, session ids |
| **Expected vs actual** (state verdicts) | The state you expected and the one reported. Quoting the transcript lines that you think should have changed the verdict is the fastest way to separate a real miss from a threshold disagreement |
| **Does it reproduce without your corpus?** | If it reproduces against an empty or synthetic corpus, the report becomes maintainable. If it does not, say that too — no need to pretend |

Feature requests use `feature_request.md`, which asks what you were trying to do, not
which button to add. Answer its two closing questions yourself first; a request that
cannot answer them will most likely be explained rather than built:

- **Is this a state that drives an action, or a description?** `FAILED` / `BLOCKED` /
  `WAITING` drive actions and notifications; the other three are descriptions, and
  descriptions do not trigger reruns or change the layout (README, "six states").
- **Can it be checked without a human looking?** If someone has to watch a screen to
  decide, it can only be a report, never a gate.

## Prerequisites

Two different Node floors, because they gate two different things:

- **Node ≥ 18.20.4** to run the tools.
- **Node ≥ 20.16.0** to run the test suite. It uses `import.meta.dirname` and
  `process.getBuiltinModule`, which landed later than the tools need.

There is no `package.json`, and `npm install` is neither needed nor wanted — there
is nothing to install, and running it only leaves a `node_modules/` behind (it is
gitignored; see "What not to commit").

**To check whether yours is enough** (one command, do not guess):

```bash
node scripts/overwatch.mjs doctor
```

The first line is the answer. The output is Chinese; this is the real line from a
passing machine, with the labels translated in brackets:

```
[   1ms] node  v26.12.1 · 工具下限[tool floor] 18.20.4 满足[met] · 测试下限[test floor] 20.16.0 满足[met] · import.meta.dirname 在[present] · process.getBuiltinModule 在[present]
```

It **reports the version and also probes those two APIs directly** (`checkNode()`) — the
version is an inference, whether the API exists is a fact. A machine that can run the
tools but not the tests says exactly that instead of failing later with an unclear error.

| Needed | Why | Can it be omitted |
|---|---|---|
| Node (table above) | Every tool and test is `.mjs` | No |
| A real TTY | The interactive panel reads keystrokes | **Yes** — use `node scripts/oversight-tui.mjs --plain` on a non-TTY, or skip that command |
| `git` | The gate uses `git ls-files` to decide which files ship, and the CHANGELOG check reads `git log` | **Yes** — outside a git repo it falls back to scanning directories; coarser, but it does not crash (`gitPublishableRootFiles()` returns `null` and the `readdirSync` branch runs) |
| Network | — | **Not needed.** Nothing here goes online; see `SECURITY.md` |
| A login / account | — | **Not needed.** `doctor` and every scan read local files only |

## Before you open a pull request

Both of these have to pass. The first one is not optional — it enforces rules
that have been broken before and are easy to break again.

```bash
node scripts/check-structure.mjs
node --test scripts/
```

`check-structure.mjs` checks, among other things: that every path named in the
living docs exists, that no machine-specific absolute path reached a publishable
file, that the regression-test count quoted in four files matches the source,
that `docs/CHANGELOG.md` has an entry covering recent commits, and that the two
ledgers are well-formed. It is allowed to fail your change for a reason that has
nothing to do with your code — read the message before assuming it is wrong.

If you add or remove a test, the gate tells you the new count and names the
files that disagree. Update those; do not guess the number.

**One gap of the same kind, stated rather than hidden:** the gate reconciles the count in
the four places above. **The number inside the badge at the top of either README**
(`README.md` / `README-EN.md`) is not among them, so it can go stale without the gate
noticing — it has **been stale at least once** (before 2026-11-21 the badge read `1627`
while the source was already past a thousand `test(` calls; see the same-day entry in
`docs/CHANGELOG.md`).
If you touch the count, fix both badges by hand too.

## How to verify locally

Three commands, one job each. The first two are the bar for committing; the third is
a self-check.

### `node scripts/check-structure.mjs` — the structure gate, about 3 s

It reads no session corpus, only the repository's own files (2.7 s measured here on
2026-11-20). What it checks:

- every `scripts/`, `docs/`, `templates/`, `.claude/` path named in the living docs
  actually exists
- the publishable area (root files + `docs/`, `scripts/`, `templates/` and other
  directories + `.claude/agents/`) contains no machine-specific absolute path
- the regression-test count matches the four declarations (next section)
- `docs/CHANGELOG.md` covers recent commits that touched source or specs
- both ledgers are well-formed; `.gitignore` does not exclude the product itself
- `node --check` passes; every exported pure function can actually be called once,
  not merely imported
- no relative doc link dangles; every command listed in `docs/CAPABILITIES.md` has a
  real script and real `--flag`s
- the research and design indexes are complete; agent frontmatter has its required
  fields

**When to run it:** after any change, before committing. It is allowed to fail your
change for a reason unrelated to your diff — read the message before deciding it is
wrong; do not treat it as skippable.

### `node --test scripts/` — the full regression suite, 30–60 s

**Do not quote a hard-coded test count from any document, including this one.** The count
grows every day (on the day this paragraph was written the source went from 1756 to 1784
`test(` calls), so only the **shape** is given: the last line reads
`tests N / pass N-2 / fail 0 / skipped 2`. Runtime is not a criterion either — the same
code here measured `50.1 s` once and `38.2 s` another time. The two `skipped` entries are
mutually exclusive platform cases (case folding in `pathKeyOf` and `diffOf`: the win32 one
runs on Windows, the non-win32 one is skipped). **`skipped` is not a failure.**

Use the directory form `scripts/`, not `scripts/*.test.mjs`: before Node 22 the glob
is not expanded, and in cmd.exe / PowerShell the wildcard reaches Node verbatim and
becomes "file not found".

**When to run it:** after changing any behaviour or adding any test. CI runs the same
command split into two steps (a fast batch, plus `launch.test.mjs` and
`build-payload.test.mjs` serially) because those two files spawn dozens of real
processes and starve the rest — the split changes scheduling only, and drops no test.

### `node scripts/overwatch.mjs doctor` — eight preconditions, 1000 ms budget

It reports **what it read**, not "pass/fail". The eight items: `node` /
`transcripts` / `sources` / `claude/` / `gate` / `watcher` / `platform` / `plan`.

**When to run it:** first thing after a clean clone; when you suspect an environment
problem (Node too old, session records not found); and paste the whole block into a
bug report. Exit codes: `0` fine, `2` the transcript root does not exist, `3` it
cannot be read (an environment problem, not "no sessions"), `5` bad arguments.

Three numbers on the summary line are not the same: `workMs` (what the tool spent),
`bootMs` (Node startup) and `wallMs` (what `time` measures). It also states that the
~170–210 ms your shell spends starting node is outside every budget — without that,
doctor printing 850 ms while you measure 1020 ms reads as "the tool is lying to me".

## The bar for "green"

Stricter than "0 failures and no fewer tests than before": **the gate reconciles one
specific number against four documents.**

```bash
node scripts/check-structure.mjs   # must print ✓ 结构检查全部通过
node --test scripts/               # must report fail 0
```

The count is enforced by `checkTestCount()` in `check-structure.mjs`. It counts
occurrences of `^\s*test\(` in `scripts/*.test.mjs` — it does not run the tests, so a
genuinely failing test does not make it report "wrong number" — then compares that
against four declarations:

| File | The sentence it matches |
|---|---|
| `README.md` | `（N 条回归测试` |
| `CLAUDE.md` | `全量回归测试（N 条` |
| `docs/GUIDE.md` | `N 项全绿` |
| `.github/workflows/validate.yml` | `全部回归测试（N 条` |

All four must agree. **Adding a test without updating all four goes red**, and the
error names the new number and the files that disagree; edit those, do not count by
hand. Removing one of the declarations also goes red ("deleting the declaration
means nobody checks it any more").

Three things that are easy to misread:

- **The run reports more than the declared number.** The gate counts `test(` calls;
  `node --test` counts subtests separately. Reconcile with the former, read results
  with the latter — never edit the declared number in the docs to match the `ℹ tests`
  figure; they always differ by a few.
- **A number written into docs can go stale; the gate only guarantees it is
  self-consistent.** When the two disagree, run the gate and use the `actual` value it
  prints.
Links are scanned against the **git file list**, not against a directory:
`scripts/link-check.mjs` asks `git ls-files '*.md'` (170 files measured), so this file,
both READMEs and `SECURITY.md` are all in scope. The criterion used to be a hand-written
list covering only `README.md` / `CLAUDE.md` / `docs/`, with none of those four root
documents on it — and both commands printed "0 broken links" anyway (`DF-040`). So:
**a relative link added here will be checked**; a path you write in backticks will not
be, and you still have to check that yourself.

## Change requirements

**If you change behaviour, change `docs/` in the same commit.** This repository
has a rule against "code now, docs later", because later does not arrive. The
specific places that go stale:

| What you changed | What else must change |
|---|---|
| A user-visible capability | `docs/CAPABILITIES.md` — the gate checks that every command listed there exists and takes the flags shown |
| A state threshold or a verdict rule | `docs/spec/state-model.md` |
| A finding or a known deviation | `tasks/dev-findings.md` or `tasks/accepted-deviations.md` |
| Anything under `scripts/` | `docs/CHANGELOG.md` — the gate fails without an entry |

**Every claim needs a source.** The CHANGELOG's own rule: write the commit hash,
file path, function name, or measured number. A sentence that cannot be traced
to one of those does not go in.

**"Fixed" needs negative evidence.** Put the bug back and watch the test go red.
A single green run is not evidence that the test can detect the bug. This is scripted, in
three places that each cover a batch of fixes:

```bash
node scripts/verify-bugfix-negatives.mjs        # the TUI batch (tui-bugfixes.test.mjs)
node scripts/verify-claim-fix-negatives.mjs     # the claim-detection batch (verify-claims.test.mjs)
node scripts/verify-tui-negatives.mjs           # the second TUI rewrite
```

They **do not touch git state**: each revert reads the original file into memory, and the
original is written back immediately afterwards (guaranteed by `finally`). They also
confirm the baseline is green first — otherwise "goes red" proves nothing. Doing this by
hand is guaranteed to miss cases, and means re-running the full suite several times, which
is why it is a command.

## Code conventions

- **Zero dependencies.** Do not add a package. If something seems to need one,
  the answer is usually that it needs less than you think — this repository
  reimplements terminal width tables and escape sanitising rather than importing
  them.
- **Comments say why, not what.** The existing comments explain why a rule
  exists and what breaks without it. Match that. A comment that restates the
  next line will be asked to leave.
- **Two display paths, one source.** Anything the TUI renders must come from the
  same function the plain-text path uses. This has drifted twice; both times a
  session visible in one view was missing from the other.
- **"Cannot tell" is its own state.** Never render an unknown as a zero, as a
  blank, or as "all clear". If the data was not read, say so. `watch.mjs`'s
  process-liveness verdict is three-state, `true / false / null`, where `null` means
  "cannot tell" — writing `null` as `false` claims the process is dead.
- **A config option must have an execution path.** An option that is read but never used is
  the same as no option. `agent.roster` is the standing counter-example: it affects
  dispatch but not mounting, and no line of code currently executes it — recorded in
  `docs/spec/2026-11-14-launch.md` rather than left for the reader to discover.

## Commits

The documented format is:

```
type(scope): what changed, and why it matters
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`.

Being honest about its status: **this format is a convention, not a gate.** Most
commits in this repository's history describe the change in a plain sentence
instead. If you match the format, good; nothing rejects you for not doing it.

Write the body for someone reading `git log` in six months with no context.
Explain what was wrong, what you measured, and what the fix costs. If you
removed something, say what would break if it came back.

Before committing:

```bash
git status        # stage only what you meant to change
git diff          # read your own diff
```

Do not use `git add -A`. This repository has a `.gitignore` that is correct for
it and a habit of accumulating scratch files; `-A` will pick those up.

## Branches and pull requests

`main` is the only branch. A pull request is preferred over pushing to it
directly — CI runs the same checks and it is easier to discuss a diff than a
commit that already landed. Nothing enforces this: `main` is currently
unprotected, so a maintainer can push to it.

CI runs the structure gate, a payload-layout check, and the full test suite. That
is a superset of the two commands above; if both pass locally, CI should agree.

## What gets pushed back

Some things will be asked to change even if they work:

- **A new metric that cannot drive an action.** This repository deliberately
  distinguishes states that mean "you need to do something" from states that
  merely describe. Adding the second kind to the first kind's display has been
  rejected before.
- **A gate that can be satisfied without doing the work.** If a check can be
  passed by writing a sentence instead of doing the thing, it is a ritual, not a
  gate.
- **A measurement whose denominator changed to make the number look better.**
  There is a documented instance of a 115/115 = 100% figure that turned out to
  be tautological (the question mark split out "waiting on a human" first, then the
  remaining set was counted for question marks; `docs/research/README.md` records the
  red-team catch). It is checked for now.
- **A criterion that claims more coverage than it has.** `DF-039`: the gate's "zero drive
  letters in the publishable area" check only recognised 7 fixed prefixes, while claiming
  "no machine-specific absolute path in the publishable area". The first happened to be
  true, the second was always false, and the output was "all checks passed" either way.
  The rewritten criterion (`scripts/published-paths.mjs`, with unit tests) caught 8 real
  leaks on its first run — that is the cost of "seeing is not failing".
- **The same false statement in a new wording.** `DF-038` is the fourth recurrence of one
  failure mode: the fix touched the words, and the replacement words were still false
  ("one criterion in three places" was never the same criterion in the other two code
  paths). When you change an assertion, first run the command that proves it.

None of this is about style. Each one is a failure this project has already had.

## What not to commit

The reason for every entry in `.gitignore` is written in that file. These are the
ones most often picked up by accident:

| Path | Why |
|---|---|
| `tasks/runs/` | The **run ledger**, written by the dispatcher, containing session ids and local paths. Ignored by design; `.gitkeep` is the exception |
| `.claude/settings.local.json`, `CLAUDE.local.md`, `*.local.md`, `local/` | Machine-private config that means nothing on anyone else's machine |
| `.claude/.ow-*` | The pre-write gate's per-machine marker and its **signing secret**. Committing the secret publishes an HMAC key, and anyone can then forge `satisfied_by:"auto"` — the signature mechanism becomes worthless |
| `.tmp-*`, `.tmp-analysis/`, `tmp/`, `.scratch/` | Scratch probes, which regularly hold real transcript slices, session ids and local paths. **Four accidental commits of these already happened** (`3a2a883` / `39cc75d` / `b14f6ae` / `7d49543`) |
| `dist/` | Build output of the plugin payload, generated by `scripts/build-payload.mjs`. It is a **second source of truth that drifts**: `.claude/` is the project layout, `dist/` is the plugin layout, and if both are committed one of them inevitably stops being tested. `--check` fails on drift, so it is generated, never committed |
| `scripts/install/start-watch.vbs` | The launcher the installer generates; its content depends on your local repo path. The **template** `start-watch.vbs.template` is the versioned source of truth and must be committed |
| `node_modules/`, `*.log` | There is no `package.json` here, and no log file belongs in history |
| `docs/research/2026-11-02-host-interfaces.md` and four siblings | Reverse-engineering notes on local host / third-party gateway interfaces, tokens and ACL exposure, named-pipe protocol details. They stay on disk with `<!-- PRIVATE: 不在公开范围内 -->` as the first line |

**`docs/`, `tasks/` and `.claude/` are deliberately absent from `.gitignore`** — they
are the product itself. Ignoring them is right for the reference project this
repository borrows structure from, and copying that here would make `git add -A`
silently add nothing. `checkGitignoreSanity()` in `check-structure.mjs` exists to
block exactly that.

Before committing:

```bash
git status
git diff --cached
```

If any of the above shows up staged, run `git restore --staged <file>`.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md).
