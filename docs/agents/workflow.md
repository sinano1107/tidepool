# Workflow

How work moves from a request to a merged pull request in this repo. The engineering skills carry the steps; this file records the routing between them and the places this repo deviates from what the skills assume.

Ask `/ask-matt` when the question is "which skill fits". This file answers "how this repo strings them together".

## Entry points

| The work arrives as | Start with |
| --- | --- |
| An issue someone else filed — a report, a request | `/triage` |
| Something is broken and resists a first look | `/diagnosing-bugs` |
| An idea of your own | `/grill-with-docs` |
| An effort too foggy to scope in one session | `/wayfinder`, rejoining at `/to-spec` when the map clears |

`/triage` and `/grill-with-docs` are two ways to reach the same place: an issue an agent can build from. They do not chain. When `/triage` lands an issue on `ready-for-agent` it posts an agent brief, and that brief **is** the specification — the issue does not then go through `/to-spec`. In the other direction, tickets `/to-tickets` produced are agent-ready by construction and are never triaged.

## What a grilling session lands

`/grill-with-docs` is finished when the record is, not when the design tree is walked. Six things land:

1. **One ADR** under `docs/adr/` — decision and rationale only. See the ADR landing convention in [domain.md](./domain.md), including the generated index.
2. **`CONTEXT.md`, updated as each decision lands** — not batched. The main job is correcting lines the decision just made false.
3. **Findings outside the scope, split into their own issues** — mixing them gives the ADR two subjects.
4. **The implementation work, written up** — see below.
5. **A comment on the originating issue** — the decisions, and links to the implementation issues. When step 4 produced no issue, this comment is also where the measurement tables and implementation walk-throughs go, since [domain.md](./domain.md) keeps them out of the ADR.
6. **A commit on `main`** — not pushed.

## Writing the work up

The branch is about sessions, not about size in the abstract and not about who implements:

- **The whole change fits one fresh context window, and this session still has room for it** → skip the write-up and go straight to `/implement-tidepool`, run against the originating issue and the comment step 5 left on it. Both gates have to hold: a long grilling session replays its whole context on every implementation turn, so writing the work up and starting fresh can cost less than staying put.
- **One slice, but not this session** → `/to-spec`, then hand the spec issue to `/implement-tidepool`.
- **Several slices** → `/to-spec`, then `/to-tickets`. Both, in that order — they are a chain, not a choice.

Do not `/compact` or `/clear` between `/to-spec` and `/to-tickets`: re-fetching a large spec out of an issue truncates.

**The slice count does not have to be settled first.** `/to-tickets` quizzes you on the breakdown *before* it publishes anything, so when it is unclear, run it — if one ticket comes back, don't publish, and carry on with the spec issue.

## ponytail

Off while deciding — `/grill-with-docs` and `/to-spec` — so that YAGNI pressure does not kill options before they have been considered.

On at `full` from `/to-tickets` onward — the mode throughout the work, and `/ponytail-review` as its own beat inside implementation. Over-decomposition is the most reported friction on `/to-tickets`, and this is cheaper than asking it to merge tickets at every quiz.

## Choosing the model

`/implementation-delegation` decides the implementation model, the effort, and the review strength. `/implement-tidepool` runs it and places the models, with one exception: **sub-agents inherit the session's effort**, so effort has to be right at launch. Implementation goes to Codex by default; only work that loops through the Design project stays on Claude.

## Building

`/implement-tidepool <issue> [review-model]` — see [the skill](../../.agents/skills/implement-tidepool/SKILL.md) for what one run does.

Tests need the Node version and sandbox permission described in `AGENTS.md`.

One issue per session, cleared between them. Two implementation sessions in one checkout share an index, a `HEAD`, and `refs/stash`, and corrupt each other.

## Where a human is required

- **Agreeing the seams**, before the first test. `/tdd` refuses to write a test at an unconfirmed seam, and a sub-agent cannot ask.
- **Merging the pull request.** The skill stops at an open PR and never merges, closes, or ticks acceptance criteria.
- **Closing the originating issue.** It stays open until the change has been confirmed on the real deployment — an implementation issue closing on merge is not evidence the symptom is gone.
