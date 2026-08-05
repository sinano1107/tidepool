## Context Vault
Everything about this project is gathered under `projects/tidepool` in context-vault.

## Agent skills

### Issue tracker

Issues live as GitHub issues; use the `gh` CLI. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the canonical five-role label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Test runtime

Tests require Node 22.x (`.nvmrc`). `npm test` runs a preflight that repairs a
`better-sqlite3` ABI mismatch and checks localhost binding. Because the test
server binds HTTP and MCP listeners, Codex must run `npm test` with the
sandbox permission that allows localhost binds; an `EPERM` from the preflight
means the command needs to be retried with that permission, not that the test
suite is broken.
