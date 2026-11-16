---
name: Feature request
about: Describe the problem, not the button
labels: enhancement
---

## What are you trying to do

<!--
The situation, not the solution. "I come back after three hours and cannot
tell which session is waiting on me" is useful. "Add a badge" is not — it
does not say what the badge is for.
-->

## What happens today instead

<!-- Where does it break down? What do you do to work around it? -->

## Why the obvious answer does not work

<!--
If there were an easy fix you would have done it. Say what you tried and why
it was not enough.
-->

## What would tell you it was solved

<!--
Something observable. "It feels better" is not checkable; "I can tell in one
look whether any session has been waiting more than an hour" is.
-->

---

## Before you send this

Two questions that will change the answer:

**Is this a state that drives an action, or a description?**
This project separates the two on purpose. `FAILED` / `BLOCKED` / `WAITING`
mean "you need to do something". Everything else — `EXPLORING`, `PRODUCING`,
`STALLED` — is a description, and descriptions do not get to trigger work or
change the layout. If your request is to surface a description more
prominently, say what action it would lead to. If there is none, that is
probably the answer to the request.

**Can it be checked without a human?**
If a proposed feature needs someone to look at a screen and decide whether it
is right, it cannot be a gate — it can only be a report. Say which one you
are asking for.

## Is this about a specific tool in the space

If you are comparing to another session manager or agent view, name it. This
project deliberately does less than most of them, and knowing which one you
miss is more useful than a generic "make it better".
