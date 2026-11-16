# Contributing

This repository has no build step, no dependency install, and no package
manager. If you can run `node`, you can run everything here.

## Prerequisites

- **Node ≥ 18.20.4** to run the tools.
- **Node ≥ 20.16.0** to run the test suite — it uses `import.meta.dirname` and
  `process.getBuiltinModule`, which landed later.
- Nothing else. There is no `package.json` and running `npm install` is neither
  needed nor wanted.

`node scripts/overwatch.mjs` reports both thresholds separately, so a machine
that can run the tools but not the tests will say exactly that.

## Before you open a pull request

Both of these have to pass. The first one is not optional — it enforces rules
that have been broken before and are easy to break again.

```bash
node scripts/check-structure.mjs
node --test scripts/
```

`check-structure.mjs` checks, among other things: that every path in the docs
exists, that no machine-specific absolute path reached a publishable file, that
the test count quoted in four files matches the source, that `docs/CHANGELOG.md`
has an entry for the commit, and that the two ledgers are well-formed. It is
allowed to fail your change for a reason that has nothing to do with your code —
read the message before assuming it is wrong.

If you add or remove a test, the hard gate will tell you the new count. Update
the four files it names; do not guess the number.

## Change requirements

**If you change behaviour, change `docs/` in the same commit.** This repository
has a rule against "code now, docs later", because later does not arrive. The
specific places that go stale:

| What you changed | What else must change |
|---|---|
| A user-visible capability | `docs/CAPABILITIES.md` — the hard gate checks that the commands listed there exist |
| A state threshold or a verdict rule | `docs/spec/state-model.md` |
| A finding or a known deviation | `tasks/dev-findings.md` or `tasks/accepted-deviations.md` |
| Anything under `scripts/` | `docs/CHANGELOG.md` — the hard gate fails without an entry |

**Every claim needs a source.** The CHANGELOG's own rule is: write the commit
hash, file path, function name, or measured number. A sentence that cannot be
traced to one of those does not go in.

**"Fixed" needs negative evidence.** Put the bug back and watch the test go red.
A single green run is not evidence that the test can detect the bug.

## Code conventions

- **Zero dependencies.** Do not add a package. If something seems to need one,
  the answer is usually that it needs less than you think — this repository
  reimplements terminal width tables and escape sanitising rather than
  importing them.
- **Comments say why, not what.** The existing comments explain why a rule
  exists and what breaks without it. Match that. A comment restating the next
  line will be asked to leave.
- **Two display paths, one source.** Anything the TUI renders must come from
  the same function the plain-text path uses. This has drifted twice; both
  times a session that was visible in one view was missing from the other.
- **"Cannot tell" is its own state.** Never render an unknown as a zero, as a
  blank, or as "all clear". If the data was not read, say so.

## Commits

```
type(scope): what changed, and why it matters
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.

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

`main` is the only branch. Open a pull request rather than pushing to it
directly — CI runs the same two checks and it is easier to talk about a diff
than about a commit that already landed.

## What gets pushed back

Some things will be asked to change even if they work:

- **A new metric that cannot drive an action.** This repository deliberately
  distinguishes states that mean "you need to do something" from states that
  merely describe. Adding the second kind to the first kind's display has been
  rejected before.
- **A gate that can be satisfied without doing the work.** If a check can be
  passed by writing a sentence instead of doing the thing, it is a ritual, not
  a gate.
- **A measurement whose denominator changed to make the number look better.**
  There is a documented instance of a 115/115 = 100% figure that turned out to
  be tautological. It is checked for now.

None of this is about style. Each one is a failure this project has already had.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md).
