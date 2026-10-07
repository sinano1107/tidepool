# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

A `needs-info` issue waits on an observation, so where it goes when the observation lands depends on
what the observation showed: it **closes** when the observation is the answer, and takes
`needs-triage` only when the observation leaves something to decide. This is the general rule, not a
property of `verify:production` below — a confirmation issue whose venue is CI or the Lima VM closes
the same way.

An issue that has been evaluated and only waits for another issue to land records the wait as
GitHub's native blocked-by relation, and takes the state its content warrants: `ready-for-agent` when
it is decided enough to build — the maintainer approves that, as with the blocked tickets
`/to-tickets` publishes — and `needs-triage` only when something is left to decide. Not `needs-info`:
that waits on an observation, not another issue. No label is no answer — an unlabeled issue reads as
untriaged, and #1416 sat outside every queue after its blocker #1419 closed.

## Priority labels

Orthogonal to the five roles above: a `ready-for-agent` issue additionally carries at most one `priority:*` label, ranking it for pickup. The 2026-07-17 triage ranked by what unblocks Tidepool developing Tidepool itself (deliverable integrity and trust foundations first, guardrails and tooling next, ops/UX last).

| Label             | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `priority:high`   | Work this first — blocks trusting agents with development work |
| `priority:medium` | Guardrails and quality tooling — next after high               |
| `priority:low`    | Ops and UX — not a prerequisite for agent-driven development   |

Same colon-namespaced shape as `model:*` (e.g. `model:opus`, which pins the model an issue's worker should run on).

## Environment labels

| Label       | Meaning                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `env:cloud` | The task completes end-to-end — implementation **and** verification — inside a cloud Claude Code session (isolated container, repo clone, `claude` CLI available). |

Absent means completion needs something outside the cloud container: hardware the container cannot reach (ssh to the Pi over Tailscale, #83), human-performed acceptance (browser E2E per ADR 0027, e.g. #55/#78), real external accounts or ops (machine-user setup, #50), or verification that can only be observed in a browser UI (#47). An issue whose agent portion is cloud-workable but whose acceptance is human-performed does **not** qualify — the label promises the whole loop closes in the cloud.

## Verification labels

| Label                | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `verify:production`  | What is still missing is an observation only a running board can give — the confirmation of a merged change, or whether something hurts in real use. |

Absent is the point: an open issue with no `verify:*` label is work not yet done, so the open set
reads as a queue. The label comes off when the observation lands, and the issue moves on by the
`needs-info` rule above — closed when the observation is the answer, `needs-triage` when it leaves a
decision.

**It rides the issue that holds the confirmation, not the implementation one.** Implementation issues
close at merge (ADR 0126), so the issue still waiting on production is the derived one — the row whose
whole content is "watch for X". Putting the label on a merged implementation issue would reopen a
question its own close already answered.

**A label, not a comment.** The queue is read as a list — `gh issue list`, the web list — and a
comment only speaks once the issue is already open. Filter the queue with
`gh issue list --search '-label:verify:production'`. The filter names the venue, so a second
`verify:*` label means fixing the filter here too — otherwise its issues quietly read as work again.

Most implementation issues never carry it. The venue a change's subject demands is usually CI or the
Lima VM (`docs/agents/machine-setup.md`), and the Pi is production-only — "don't make checkouts there
to test a change". This label is for the residue: behaviour that only the deployed board can show.

## Sweep label

| Label          | Meaning                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `auto-triaged` | `/triage-sweep` has posted its evaluation; the maintainer's move is next. |

Orthogonal to the state roles: the sweep leaves the state label where it was, and its comment's
"Recommended next step" names the move — `ready-for-agent`, close, grill, `verify:production`. The
sweep stops here because a brief is the specification ([workflow.md](./workflow.md)) and
`ready-for-agent` is the build queue, so moving the label approves a spec; that stays the
maintainer's step.

The sweep's queue is `needs-triage` / `needs-info` without `auto-triaged` or `verify:production`.
Take the label off to put an issue back in it — after answering the sweep's questions in a comment,
say.
