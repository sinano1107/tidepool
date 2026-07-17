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

## Priority labels

Orthogonal to the five roles above: a `ready-for-agent` issue additionally carries at most one `priority:*` label, ranking it for pickup. The 2026-07-17 triage ranked by what unblocks Tidepool developing Tidepool itself (deliverable integrity and trust foundations first, guardrails and tooling next, ops/UX last).

| Label             | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `priority:high`   | Work this first — blocks trusting agents with development work |
| `priority:medium` | Guardrails and quality tooling — next after high               |
| `priority:low`    | Ops and UX — not a prerequisite for agent-driven development   |

Same colon-namespaced shape as `model:*` (e.g. `model:opus`, which pins the model an issue's worker should run on).
