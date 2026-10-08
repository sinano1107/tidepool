# Workflow

How work moves from a request to a merged pull request in this repo. The engineering skills carry the steps; this file records the routing between them and the places this repo deviates from what the skills assume.

Ask `/ask-matt` when the question is "which skill fits". This file answers "how this repo strings them together".

## Entry points

| The work arrives as | Start with |
| --- | --- |
| An issue someone else filed — a report, a request | `/triage` |
| A backlog of `needs-triage` / `needs-info` issues | `/triage-sweep <N>` in a design session, then act on each `auto-triaged` comment |
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
5. **A comment on the originating issue** — the decisions, and links to the implementation issues. When step 4 produced no issue, this comment is also where the measurement tables and implementation walk-throughs go, since [domain.md](./domain.md) keeps them out of the ADR. Take `needs-triage` off the originating issue at the same time — it has been evaluated, and leaving the label puts a decided issue in the triage queue. The issue stays open until the fix lands: the implementation PR carries `Closes #<originating issue>` alongside `Closes #<spec or ticket>`, so the spec's Further Notes say so (without it the originating issue outlives its fix, as #559 and #538 did).
6. **A commit on `main`** — not pushed.

## Writing the work up

The branch is about what the record already says, not about size in the abstract and not about who implements. Implementation starts in a fresh session with `/implement-tidepool`, working from the issue.

- **One slice, and the comment step 5 left on the originating issue already says what a spec would** — completion criteria, the files to touch, the invariants and the tests that pin them → skip the write-up and hand `/implement-tidepool <originating issue>` to a fresh implementation session.
- **One slice, but the comment does not carry that** → `/to-spec`, then hand the spec issue to `/implement-tidepool`.
- **Several slices** → `/to-spec`, then `/to-tickets`. Both, in that order — they are a chain, not a choice.

Do not `/compact` or `/clear` between `/to-spec` and `/to-tickets`: re-fetching a large spec out of an issue truncates.

Specs and tickets are GitHub issues here, not files — the `.scratch/` layout in those skills belongs to the local-markdown tracker, which this repo does not use (see [issue-tracker.md](./issue-tracker.md)). Nothing lands in the working tree, so a machine that only has the issue number has everything it needs.

**The slice count does not have to be settled first.** When it is unclear, run `/to-tickets`; [its quiz](../../.agents/skills/to-tickets/SKILL.md#4-quiz-the-user) resolves the breakdown and handles the single-slice outcome before publication.

## ponytail

Use the repo-local ponytail skills directly. See [machine-setup.md](./machine-setup.md#ponytail) for provider discovery and plugin migration.

- **Deciding** — `/grill-with-docs`, `/to-spec`, and `/triage-sweep` run without ponytail. The skill is not model-invocable (`disable-model-invocation` in its frontmatter; Codex has no such flag, and there the narrowed description does the same work), so it enters a session only when the user types `/ponytail`, through `/to-tickets`, or inside the implementer agent — never on its own.
- **Ticketing** — invoke `/to-tickets`; [its setup](../../.agents/skills/to-tickets/SKILL.md#before-ticketing) owns activation.
- **Implementation** — invoke `/implement-tidepool`; [its delegation step](../../.agents/skills/implement-tidepool/SKILL.md#the-implementation-sub-agent) supplies the task to the implementation agent, whose definition owns its standing behavior and completion steps.

Required ADR behavior and tests take precedence over ponytail simplifications.

If returning to design in a conversation where ponytail is active, explicitly turn it off with `stop ponytail` or start a fresh conversation. After compaction, reload the active phase's instructions and ponytail level when they are missing.

## Choosing the model

`/implementation-delegation` decides the implementation model, effort, and review strength. [The implementation skill](../../.agents/skills/implement-tidepool/SKILL.md#model-and-effort) explains how to pass an existing decision and apply provider settings.

## Building

`/implement-tidepool <issue> [decision already taken]` — pass the delegation decision when it exists, omit it to have the skill run `/implementation-delegation` itself. See [the skill](../../.agents/skills/implement-tidepool/SKILL.md) for what one run does.

Tests need the Node version and sandbox permission described in `AGENTS.md`.

The full suite runs in CI, not in the run's stages — see the skill's "Waiting for CI" (ADR 0155).

One issue per session, cleared between them. Two implementation sessions in one checkout share an index, a `HEAD`, and `refs/stash`, and corrupt each other.

## Where a human is required

- **Agreeing the seams**, before the first test. `/tdd` refuses to write a test at an unconfirmed seam, and a sub-agent cannot ask. The seams on offer are the three in ADR 0107 — server boundary (`bootTidepool`), domain layer (exported functions, asserted through exports), schema layer (SQL, migrations only) — and a behaviour is stated once, at the lowest seam it shows at.
- **Merging the pull request.** The skill stops at an open PR with CI green and never merges, closes, or ticks acceptance criteria.

Closing the originating issue is **not** one of them: the PR carries `Closes #<issue>` and merging
closes it (ADR 0126).

When the issue's subject is a symptom observed in the real environment, the confirmation that the
symptom is gone rides a derived issue, filed by `/implement-tidepool`'s filing step before it opens
the PR. That issue carries `needs-info` until the observation lands, and `verify:production` when
production is the only venue that can show it — never the implementation issue
([triage-labels.md](./triage-labels.md)). The venue is otherwise CI, or the Lima VM for worker-facing
behaviour (containers, reclaim, containment, a real worker run — [machine-setup.md](./machine-setup.md)).
