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

Specs and tickets are GitHub issues here, not files — the `.scratch/` layout in those skills belongs to the local-markdown tracker, which this repo does not use (see [issue-tracker.md](./issue-tracker.md)). Nothing lands in the working tree, so a machine that only has the issue number has everything it needs.

**The slice count does not have to be settled first.** `/to-tickets` quizzes you on the breakdown *before* it publishes anything, so when it is unclear, run it — if one ticket comes back, don't publish, and carry on with the spec issue.

## ponytail

`/ponytail` is a standing mode that biases how work gets done; `/ponytail-review` is a one-shot pass over a diff. The two are separate, and neither substitutes for the other.

**The mode is chosen by the launcher, once per session.** `claude-design` / `codex-design` start a session with `PONYTAIL_DEFAULT_MODE=off`; `claude-build` / `codex-build` start one with `full` — shell functions you add per machine, listed in [machine-setup.md](./machine-setup.md). The plugin's `SessionStart` hook re-derives the mode from that variable on every `startup`, `resume`, `clear`, and `compact`, so it never carries over and there is nothing to unset by hand.

So the boundary is which command you launched:

- **Design session** — `/grill-with-docs`, `/to-spec`. Off, so YAGNI pressure does not kill options before they have been weighed.
- **Build session** — `/to-tickets`, `/implement-tidepool`. Full. Over-decomposition is the most reported friction on `/to-tickets`, and the mode is cheaper than asking it to merge tickets at every quiz.

**The review** runs inside implementation as its own beat, with its own commit. `/implement-tidepool` dispatches it; the `SubagentStart` hook carries the live mode into the sub-agent, so the loop is ponytail-aware without anything extra — provided the session was launched as a build one.

**Say so when the session is in the wrong mode.** The launcher variable lives in a shell profile, not in this repo, and no repo-level setting can enforce it on either provider — so detection replaces prevention. A session with ponytail active carries the plugin's ruleset in its context: if that is there while you are grilling or writing a spec, stop and tell the user before going on. The reverse costs less and is partly self-healing, since `/ponytail-review` runs as a beat regardless of the mode.

The variable's absence is not a repo bug. Without it ponytail's own built-in default applies, which is `full` — leaving design sessions arguing you out of options. See [machine-setup.md](./machine-setup.md) for the one-time setup.

## Choosing the model

`/implementation-delegation` decides the implementation model, the effort, and the review strength. `/implement-tidepool` runs it when nothing follows the issue number, and places the models either way — with one caveat on effort: Codex takes it at spawn, while Claude Code's sub-agents inherit the session's — so on Claude the effort has to be right at launch and the skill can only check it, whoever decided it. Implementation goes to Codex by default; only work that loops through the Design project stays on Claude.

## Building

`/implement-tidepool <issue> [decision already taken]` — pass the delegation decision when it exists, omit it to have the skill run `/implementation-delegation` itself. See [the skill](../../.agents/skills/implement-tidepool/SKILL.md) for what one run does.

Tests need the Node version and sandbox permission described in `AGENTS.md`.

`/ponytail` and `/ponytail-review` come from a plugin rather than this repo. `.claude/settings.json` declares the marketplace and enables it, so Claude Code picks it up from a fresh clone; on Codex it has to be enabled per machine — Codex discovers skills from `.agents/skills` and can disable them in `~/.codex/config.toml`, but has no per-repository way to require one, so there is nothing to declare here. Everything else the flow calls — `/implementation-delegation`, `/tdd`, `/code-review` — is vendored under `.agents/skills/`, so a clone has it.

One issue per session, cleared between them. Two implementation sessions in one checkout share an index, a `HEAD`, and `refs/stash`, and corrupt each other.

## Where a human is required

- **Agreeing the seams**, before the first test. `/tdd` refuses to write a test at an unconfirmed seam, and a sub-agent cannot ask.
- **Merging the pull request.** The skill stops at an open PR and never merges, closes, or ticks acceptance criteria.
- **Closing the originating issue.** It stays open until the change has been confirmed on the real deployment — an implementation issue closing on merge is not evidence the symptom is gone.
