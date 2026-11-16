## What changed and why

<!--
The why matters more than the what — the diff already shows the what.
If this fixes a bug: what was broken, and how did you notice?
If you measured something: paste the numbers.
-->

## Which of the two checks did you run

```bash
node scripts/check-structure.mjs
node --test scripts/
```

<!-- Both have to pass. Paste the tail of each. -->

```

```

## Did you add or remove a test

<!-- If yes, the hard gate will name the new count. Did you update the four files it names? -->

- [ ] Not applicable
- [ ] Yes, and the four files named by the hard gate are updated

## If you changed behaviour

- [ ] The matching file under `docs/` is updated in this same pull request
- [ ] `docs/CHANGELOG.md` has an entry with a traceable source (commit, file:line, or measured number)

## If this fixes a bug

<!-- Put the bug back and confirm the test goes red. A green run alone is not evidence. -->

- [ ] I verified the test fails without the fix

## Anything a reviewer should be suspicious of

<!--
New thresholds, new denominators, new states, a change to what counts as
"done" — say which of these you touched. If you changed how something is
counted, say whether the denominator moved.
-->

## Does anything here need to be public-safe

<!--
No machine-specific paths, no real transcript content, no session ids.
`check-structure.mjs` checks the first one; the other two it cannot.
-->

- [ ] I checked that no local paths, session ids, or transcript excerpts are in this diff
