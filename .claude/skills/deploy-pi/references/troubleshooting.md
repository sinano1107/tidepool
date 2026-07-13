# Troubleshooting

## Board picks up nothing after a deploy (most common issue — check this first)

Symptom: service is `active`, WebUI/API return 200, but a registered task just sits in `todo` forever, and `journalctl -u tidepool.service` shows nothing at all (no errors, no `[worker]` lines).

**Check `throttle_state` before anything else:**

```bash
ssh masaki@100.78.52.97 "cd /opt/tidepool && node -e \"
const Database = require('better-sqlite3');
const db = new Database('/opt/tidepool/data/board.sqlite', {readonly:true});
console.log(db.prepare('select * from throttle_state').all());
\""
```

If it shows `{ throttled: 1, resets_at: null }`, the Swell usage-limit gate (ADR-0008, `src/usage.ts`) is permanently fail-closed. This happens **silently** — `checkThrottle` swallows any parse failure into `{session: null, week: null}` → `evaluateThrottle` → `throttled: true, resetsAt: null`, with no exception and no log line. `isPickupBlocked` (the throttle read) is a display-only helper (`api.ts`) — the scheduler's own gate in `src/scheduler.ts` doesn't consult it, so this state doesn't even show up as an obvious "board is paused" signal anywhere in the UI logic; it just quietly never picks anything up again until a fresh `/usage` call parses cleanly.

Root cause seen once already (fixed 2026-07-13, but the failure mode can recur if the CLI's output format drifts again): `claude -p "/usage"`'s rendered text is **not stable across accounts**. An account with rich usage history renders `resets Jul 9 at 5:59pm`; a freshly-authenticated account with zero history on that device renders `resets Jul 13, 1:10pm` (comma instead of "at", and minutes dropped entirely when exactly on the hour — `Jul 16, 1pm`). `src/usage.ts`'s `LINE_PATTERN` regex was only ever tested against the first form. If you hit this again with an already-updated `usage.ts`, the format has drifted a third way — reproduce with:

```bash
ssh masaki@100.78.52.97 "cd /opt/tidepool && claude -p '/usage' --output-format json --model haiku --max-turns 1 --max-budget-usd 0.01 --safe-mode"
```

...and diff the `result` field's `resets ...` lines against `LINE_PATTERN` in `src/usage.ts` / the fixtures in `tests/usage.test.ts`.

To recover once the code is fixed and deployed: nothing extra needed, the very next pickup attempt (task registration + `POST /tasks/:id/move {"after":null}` to force it — see below) runs `checkThrottle` fresh and updates `throttle_state`.

## Task registration alone does not trigger pickup

The scheduler polls hourly (`HOURLY` in `src/scheduler.ts`) via `setInterval` — which does **not** fire immediately on startup. `POST /api/tasks` does not call `onQueueHeadChanged`. The only things that trigger an immediate poll are: a triage-session auto-commit, and `POST /api/tasks/:id/move` with a body that changes the queue head (including `{"after": null}` on a task that's already at the head — that specific case is special-cased to still fire, per the comment in `api.ts`'s move handler). For manual verification, always follow registration with a move-to-front call (this is what `scripts/smoke-test.sh` does).

## Board crashes at boot with a ZodError from `registry.ts`

```
ZodError: [...] path: ["assignable_to"], message: "Invalid input: expected array, received undefined" ...
```

`tidepool-registry`'s `authority/*.yaml` is out of date relative to `authorityProfileSchema` in this repo's `src/registry.ts`. `assignable_to`/`allowed_workspaces` became required fields (issue #41 — "unrestricted" must be spelled out with the literal string `"*"` in the array, never omitted). Fix by editing the registry repo (separate git history from this one), not this repo:

```yaml
assignable_to: ["<agent-name>"]      # or ["*"] only if genuinely unrestricted
allowed_workspaces: ["<workspace-name>"]  # or ["*"]
```

Prefer scoping to the actual current agent/workspace names over `"*"` — `"*"` grants the agent authority to self-assign decompose children to *any* future agent/workspace name without a code change, which is a real authority-widening decision, not a neutral default. `outsideAuthority` (`src/tasks.ts`) only enforces this check when a `decompose` call explicitly names an assignee/workspace for a child — self-assignment to the agent's own name works fine under a scoped list, it does not require `"*"`.

After editing: `git pull` the registry clone on the Pi, then `sudo systemctl restart tidepool.service` (the board reads its own default workspace from the registry once at boot).

## `git pull`/`push` fails with "could not read Username for 'https://github.com'"

`gh auth login` succeeded but `gh auth setup-git` was never run, so git itself has no credential helper configured. Run `ssh masaki@100.78.52.97 "gh auth setup-git"` once; it's a one-time git-config change, not a per-session thing.

## Useful debugging commands

**Live journal follow** (best first move for anything that isn't obviously the throttle issue above):
```bash
ssh masaki@100.78.52.97 "sudo journalctl -u tidepool.service -f --no-pager"
```

**Query `board.sqlite` directly** — the Pi has no `sqlite3` CLI installed, use `better-sqlite3` via `node -e`:
```bash
ssh masaki@100.78.52.97 "cd /opt/tidepool && node -e \"
const Database = require('better-sqlite3');
const db = new Database('/opt/tidepool/data/board.sqlite', {readonly:true});
console.log(db.prepare('select id,kind,created_at from events order by id desc limit 10').all());
\""
```
(`{readonly:true}` avoids ever accidentally writing to the live board from a debug session.)

**Reproduce the exact systemd execution environment** (env vars, cwd, uid/gid) to rule out an environment-specific failure when a command works fine over plain SSH but not from inside the service:
```bash
ssh masaki@100.78.52.97 "sudo systemd-run --uid=masaki --gid=masaki --working-directory=/opt/tidepool --property=EnvironmentFile=/etc/default/tidepool --unit=debug-repro -- <command...>"
# then: sudo journalctl -u debug-repro.service --no-pager
```

**`tasks` table can be updated (e.g. to rename a stray smoke-test task), `events` cannot.** `events_no_update`/`events_no_delete` are real DB triggers (`src/db.ts`) — this is deliberate (decision log is meant to be unfalsifiable), not a bug to work around. If a verification task needs to be made harmless rather than actually removed:
```bash
ssh masaki@100.78.52.97 "sudo systemctl stop tidepool.service && cd /opt/tidepool && node -e \"
const Database = require('better-sqlite3');
const db = new Database('/opt/tidepool/data/board.sqlite');
db.prepare('update tasks set title=? where id=?').run('[deploy verification] ' + '<original title>', '<task-id>');
\" && sudo systemctl start tidepool.service"
```
Stop the service first to avoid racing a live write; `tasks` itself has no append-only constraint so this is safe once stopped.
