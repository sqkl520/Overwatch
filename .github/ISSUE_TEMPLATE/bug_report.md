---
name: Bug report
about: Something reported the wrong thing, crashed, or rendered incorrectly
labels: bug
---

## What happened

<!-- One or two sentences. -->

## What you expected instead

## Reproduction

Exact commands, in order. If the bug depends on your corpus, say which part:
how many transcripts, how large, whether the session was live or finished.

```bash
node scripts/overwatch.mjs
# then
node scripts/...
```

## Environment

<!-- `node scripts/overwatch.mjs` prints all of this in one block; paste it. -->

```
node version:
OS:
terminal (Windows Terminal / conhost / Git Bash / VS Code / tmux / other):
shell (PowerShell / cmd / bash / zsh):
```

## Which part of the output is wrong

<!-- Paste the relevant lines. Redact anything you would not want public:
project names, file paths, transcript excerpts. -->

```

```

## If it is a state judgement

Say what state you expected and what it reported. If you can, quote the lines
from the transcript that you think should have changed the verdict — that is
usually the fastest way to tell a real miss from a threshold disagreement.

## Does it reproduce without your own transcripts?

<!--
If you can reproduce it against an empty or synthetic corpus, say so — it
turns a report about your machine into something maintainable. If you cannot,
that is fine, just say that too.
-->
