## Context Vault
Everything about this project is gathered under `projects/tidepool` in context-vault.

## Agent skills

### Issue tracker

Issues live as GitHub issues; use the `gh` CLI. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the canonical five-role label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Workflow

**Read `docs/agents/workflow.md` before starting a grilling, spec, or ticket step** — it decides
which skills run, in what order, and where this repo departs from what those skills assume. Build
with `/implement-tidepool`, not `/implement`. `/ponytail` stays off while deciding and goes to
`full` from `/to-tickets` onward.
