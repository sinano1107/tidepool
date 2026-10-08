---
name: implement
description: Build a ready-for-agent tidepool issue end to end — branch, delegated TDD at the decided model, two-axis code review, one commit per stage, a PR that records how every review finding was handled, and the filing of what the run found along the way.
disable-model-invocation: true
argument-hint: "<issue> [decision already taken]"
---

# Implement

`$ARGUMENTS` is the issue number, optionally followed by a delegation decision already taken — written however `/implementation-delegation` phrased it, e.g. `378 Opus 5 / high, review at Fable 5.1`.

## Model and effort

`/implementation-delegation` is what picks the implementation model, the effort, and the review strength.

**Anything after the issue number is a decision already taken — do not run the delegation skill again.** Read it as prose rather than by position: model names carry spaces (`Opus 5 / high`, `Sol / xhigh`), so there is nothing to split on. When it names one model, that is the implementation's and the review takes the same setting. With nothing after the issue number, run `/implementation-delegation <issue>` yourself and state what it decided.

Either way, before touching the branch, say which models the run will use. They land like this:

- **Implementation** — the TDD loop goes to a sub-agent at the implementation model.
- **`/code-review`** — its sub-agents take the review strength.

**Effort is passed at spawn on both providers.** Codex takes it alongside the model; a model on its own does not fix the compute budget. Claude Code takes it as the Agent tool's `effort` parameter, which overrides the session's level. The one thing that parameter cannot override is `CLAUDE_CODE_EFFORT_LEVEL` in the environment: when that is set below the decided effort, stop before dispatching and ask the user to relaunch without it.

## Before writing code

Stay in this thread for all three:

1. Read the issue, its resolving comments, and every ADR it references. `CONTEXT.md` supplies the vocabulary for test names and interfaces.
2. Create the branch: `issue-<n>-<slug>` — never commit wherever `HEAD` happens to be.
3. Name the seams the work will be tested at and confirm them with the user. Pick from the three seams ADR 0107 names, and state each behaviour at the lowest seam it shows at. `/tdd` refuses to write a test at an unconfirmed seam, and a sub-agent cannot ask — so the agreement has to exist before the dispatch, and the agreed seams travel in the prompt. Handing a criterion to an existing test instead is a claim, and ADR 0107 決定3 makes it the attractive one — break the implementation and watch the test you named go red before you name it. One that stays green was never the evidence.

## The implementation sub-agent

Dispatch one `ponytail-implementer` sub-agent at the decided implementation model and effort. Give it the issue number and resolving comments, agreed test seams, governing ADRs, and the current branch. Instruct it to read `CONTEXT.md`, implement with `/tdd` one red-green slice at a time, run the touched test files and typecheck. Follow `AGENTS.md` for the Node version and test permissions; the full suite runs in CI after the PR opens (ADR 0155).

- **Claude Code:** select `.claude/agents/ponytail-implementer.md`, passing the decided model and effort.
- **Codex:** select `.codex/agents/ponytail-implementer.toml`, passing the decided model and effort. If this client cannot select custom agent types, pass that file's `developer_instructions` to an ordinary sub-agent with the same task and settings.

The agent definition owns its standing behavior and completion steps. Pass the implementation task rather than restating those instructions.

Ask for the commits, changed behavior, checks and outcomes, all findings and their dispositions, and problems outside the issue's scope: where, observed or suspected, and any matching existing issue. Wait for the completed report before proceeding. A stage with no diff produces no commit; never amend. Filing happens in this thread, below.

## Code review

Back in this thread, run `/code-review` on both axes (Standards + Spec) against this branch's merge-base with `main`, then apply the findings that should be applied and commit them as the next stage.

Add one line to each sub-agent's brief: "Separately, list anything wrong you noticed that the diff did not cause — where, and whether you observed it or only suspect it." Those notes feed the filing step below.

Judge each finding rather than applying the set wholesale. One finding is never yours to apply: one that contradicts a decision recorded in an ADR. The ADR is the decision of record, and overturning it is a fresh decision, not a fix. Every other call is yours, and it is accountable because it goes in the pull request.

## Filing what the run found

Before opening the PR, gather everything the run surfaced, wherever it came from: the sub-agent's report, the review sub-agents' notes on what the diff did not cause, every review finding you left unapplied because it lies outside the issue, and what you noticed yourself — reading the issue and ADRs, agreeing the seams, applying findings. Search the tracker for each, closed issues included (`gh issue list --state all --search "<words>"`), then settle it:

- **Belongs to an existing issue** — comment there. A closed hit means "not worth an issue", and the reason cites it.
- **New, and observed** — `gh issue create --label needs-triage`, the body citing the originating issue and where the observation is (file, test, commit on this branch). It enters `/triage` like any other filed issue.
- **New, but only suspected** — file it `needs-info`, saying what observation would settle it. An issue is not an observation (ADR 0102).
- **Not worth an issue** — say so in the PR, with a reason held to the same bar as a review finding.

One more, and it comes from the originating issue rather than from the run: **its subject is a symptom observed in the real environment** ("the Codex route's worker cannot start", not "add a preflight row"). The change removes a suspected cause and merging will close the issue (ADR 0126), so file a confirmation issue, `needs-info`, naming the venue and the observation that would settle it. Merging is not that observation, and neither is a green suite — the symptom was observed outside both. When the run already filed an issue that blocks the venue check, say there that it carries the confirmation too, rather than opening a second row.

## The pull request

Push the branch and open a PR. Follow the shape this repo already uses: a Japanese body with `## Summary`, a `## Test plan` checklist, and `Closes #<issue>` — plus `Closes #<originating issue>` when the spec names one it came from (`docs/agents/workflow.md`, step 5 of the grilling landing).

Record the delegation decision the run actually used — model and effort for the implementation, strength for the review — so a run dispatched at the wrong tier is visible afterwards.

Then add the section this flow depends on:

```markdown
## レビュー指摘の対応
```

List **every** finding returned by the implementation agent and `/code-review` — the applied ones included, none omitted. For each, say what was raised and either which commit addresses it or why it was not applied. A reason has to point at something checkable: an ADR number, a term defined in `CONTEXT.md`, an existing test. "Out of scope" on its own is not a reason.

Completeness is the whole point of the section. A list that quietly drops the findings you chose not to act on is worse than no list, because it reads as though review found nothing there.

A review finding that was filed or commented on says so on its own line above (`→ #n に起票`). Then a second section, `## 発見した問題`, for the rest of what the filing step settled — the sub-agent's report, the reviewers' notes on what the diff did not cause, your own observations: each one filed as `#<n>`, commented on `#<n>`, or not filed and why. Each problem appears in exactly one of the two sections.

## Waiting for CI

Once the PR is open, `gh pr checks --watch` until every check finishes — the `test` jobs on ubuntu and macOS, and `e2e`. When one fails, fix it on the branch, commit, push, and watch again. The PR goes to the human only once all pass.

## Where this stops

At the open pull request with CI green. Do not merge it, do not close the issue, do not tick its acceptance criteria. The human merges, and the PR's `Closes #<issue>` closes the issue with it (ADR 0126) — no confirmation of yours gates that. What survives a symptom issue's close is the confirmation issue the filing step filed.
