---
name: implement-tidepool
description: Build a ready-for-agent tidepool issue end to end — branch, TDD and ponytail-review in a sub-agent at the decided model, two-axis code review, one commit per stage, and a PR that records how every review finding was handled. Use this instead of /implement in this repo.
disable-model-invocation: true
argument-hint: "<issue> [decision already taken]"
---

# Implement (tidepool)

A tidepool-local derivative of `/implement`. Upstream `/implement` is deliberately left untouched, so skills that route to it — `ask-matt`, `to-tickets` — keep pointing at the canonical one. In this repo, reach for this skill instead: it adds the branch, the ponytail beats, the code-review follow-through, and the pull request — all of which upstream leaves to the human — and takes the delegation decision when one has not been made yet.

`$ARGUMENTS` is the issue number, optionally followed by a delegation decision already taken — written however `/implementation-delegation` phrased it, e.g. `378 Opus 5 / high, review at Fable 5`.

## Model and effort

`/implementation-delegation` is what picks the implementation model, the effort, and the review strength.

**Anything after the issue number is a decision already taken — do not run the delegation skill again.** Read it as prose rather than by position: model names carry spaces (`Opus 5 / high`, `Sol / xhigh`), so there is nothing to split on. When it names one model, that is the implementation's and the review takes the same setting. With nothing after the issue number, run `/implementation-delegation <issue>` yourself and state what it decided.

Either way, before touching the branch, say which models the run will use. They land like this:

- **Implementation** — the TDD loop goes to a sub-agent at the implementation model.
- **`/code-review`** — its sub-agents take the review strength.
- **`/ponytail`** and **`/ponytail-review`** — never moved. Both run inline in the implementation thread at the implementation's own setting. They are different things: `/ponytail` is the standing mode that biases how the code gets written, `/ponytail-review` is a one-shot pass over a diff.

**Effort behaves differently per provider.** Where the sub-agent spawn takes an effort — Codex — pass the decided one alongside the model; a model on its own does not fix the compute budget. Where it does not — Claude Code, whose sub-agents inherit the session's effort — the decided effort is a check rather than a setting: state the effort this session is running at, and if it is below what the decision calls for, stop and say so rather than implementing at the wrong tier.

## Before writing code

Stay in this thread for all three:

1. Read the issue, its resolving comments, and every ADR it references. `CONTEXT.md` supplies the vocabulary for test names and interfaces.
2. Create the branch: `issue-<n>-<slug>`. Upstream `/implement` does not create one and commits wherever `HEAD` happens to be.
3. Name the seams the work will be tested at and confirm them with the user. `/tdd` refuses to write a test at an unconfirmed seam, and a sub-agent cannot ask — so the agreement has to exist before the dispatch, and the agreed seams travel in the prompt.

## The implementation sub-agent

Dispatch one sub-agent at the implementation model, carrying the issue number, the agreed seams, and the ADRs that govern the area. Have it open with `/ponytail full` so the mode is on for the whole loop. It owns two commits and returns what it did:

1. **Implementation** — `/tdd` at the agreed seams, one red-green slice at a time, typechecking and running single test files as it goes. Full suite green, then commit.
2. **ponytail-review** — `/ponytail-review` over its own diff, inline in the same thread, applying what it finds. This is a separate beat from the mode above, not a substitute for it. Full suite green, then commit.

A stage with no diff produces no commit. Never amend: keeping the stages apart is what makes each applied change reviewable and revertible on its own.

## Code review

Back in this thread, run `/code-review` on both axes (Standards + Spec) against the commit this branch started from, then apply the findings that should be applied and commit them as the third stage.

Judge each finding rather than applying the set wholesale. One finding is never yours to apply: one that contradicts a decision recorded in an ADR. The ADR is the decision of record, and overturning it is a fresh decision, not a fix. Every other call is yours, and it is accountable because it goes in the pull request.

## The pull request

Push the branch and open a PR. Follow the shape this repo already uses: a Japanese body with `## Summary`, a `## Test plan` checklist, and `Closes #<issue>`.

Record the delegation decision the run actually used — model and effort for the implementation, strength for the review — so a run dispatched at the wrong tier is visible afterwards.

Then add the section this flow depends on:

```markdown
## レビュー指摘の対応
```

List **every** finding `/ponytail-review` and `/code-review` raised — the applied ones included, none omitted. For each, say what was raised and either which commit addresses it or why it was not applied. A reason has to point at something checkable: an ADR number, a term defined in `CONTEXT.md`, an existing test. "Out of scope" on its own is not a reason.

Completeness is the whole point of the section. A list that quietly drops the findings you chose not to act on is worse than no list, because it reads as though review found nothing there.

## Where this stops

At the open pull request. Do not merge it, do not close the issue, do not tick its acceptance criteria. The human runs the final verification and merges.
