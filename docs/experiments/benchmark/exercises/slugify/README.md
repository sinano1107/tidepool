# slugify: two planted defects

A work exercise. `workspace/slugify.js` breaks two rules of `workspace/SPEC.md`: runs of `-` are not collapsed
(`"a  b"` gives `"a--b"`), and a trailing `-` is not removed (`"trail "` gives `"trail-"`). The seed's own tests
pass because they don't cover either rule. `expected.test.cjs` checks every rule. It passes only when both defects
are fixed.

Readings: `work`.

## Human steps

1. When the board asks to land the completed task (`land completed task: Make slugify meet its spec`), answer
   **merge**. The expected-answer test runs on `main` after that.
   - Answering **hold** settles the exercise too. The test then runs against the unfixed seed and records
     `handled: no`.
2. Answer any other question the board raises as you would in real use. The record counts each one.
