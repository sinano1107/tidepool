# Board E2E test: flow one real task through the Pi

Verifies the board's GitHub-facing loop on production — task pickup → worker
session → PR creation → human merge answer → merge — with one minimal task.
First used for issue #50 (machine-user identity: PR/merge actor must be
`tidepool-bot`); reuse it for issue #53 (commit author identity) and any future
change to the spawn/PR/merge path. Runs a real sonnet worker session (~2 min,
one task) and touches the real `tidepool-registry` repo — cheap, but not free:
one task per verification, never a loop of them.

Ground rules that keep this safe and cheap:

- **One minimal task.** The task below is two small README appends — fully
  specified, no ambiguity, nothing for the worker to explore.
- **Bounded polling only.** Every wait below is a `for`-loop with a max
  iteration count, never `while true`.
- **`registry` is the only repo-backed workspace** (workspaces.yaml), so it's
  the only place a PR flow can be exercised. It's `protected: true`, which is
  what makes the flow deterministic: the PR always escalates to a merge
  question instead of auto-merging.

## 0. Preconditions

**Every `/api` call below needs the board's credential** (issue #153 / ADR 0036). The board
keeps only a hash and cannot reproduce the token, so supply the one you hold — or rotate it
(`npm run token` on the Pi; see [docs/human-surface-credential.md](../../../../docs/human-surface-credential.md)).
Define this helper once and use it in place of every `curl` below. It runs from *this* machine
over the tailnet, so the token never lands on the Pi — the host that runs workers — and it feeds
curl through `--config` on stdin, so it never appears in `ps`:

```bash
PI=masaki@100.78.52.97
BOARD=https://raspberrypi.tailc0084f.ts.net:8443
export TIDEPOOL_TOKEN=<the board's token>
board() { printf 'header = "Authorization: Bearer %s"\n' "$TIDEPOOL_TOKEN" | curl -sk --config - "$@"; }
```

A 401 from any call below means the token is stale, not that the board is down. A **200 from an
*unauthenticated* call** is the opposite problem: the board fail-opened, which means pickup is
already halted board-wide with a standing question, and this E2E cannot run until it is repaired
(issue #154).

```bash
ssh $PI 'systemctl is-active tidepool'
board "$BOARD/api/pause"; echo; board "$BOARD/api/settings/quiet-hours"
ssh $PI 'cd /mnt/ssd/tidepool-registry && git status --short | wc -l && git branch --show-current'
```

Expect: `active`, `paused:false`, `throttled:false`, registry checkout clean on
`main`. If the code under test isn't deployed yet, deploy first (SKILL.md
routine path).

Note: quiet hours (23:00–07:00 Asia/Tokyo) do **not** gate pickup — only
`src/push.ts` reads `isQuietHours`; `src/scheduler.ts`'s `pickupBlocked()` /
`poll()` never do. Pickup runs fine inside quiet hours, but the merge
question's push notification won't fire, so step 4 below must pull the
question via the API directly rather than waiting on a notification.

## 1. Register the minimal task

The task is two small parts in one, so a single PR yields both an
agent-authored commit and a board-made WIP-stash commit (issue #53's
criteria (a) and (b)):

- Append one line to README.md and **commit it yourself** (`git commit`) —
  leave the push/PR to the board.
- Make one more small edit — a second line appended to README.md — and
  leave it **uncommitted** in the working tree at completion.

```bash
board -X POST "$BOARD/api/tasks" -H "Content-Type: application/json" -d '{"type":"work","title":"E2E: minimal README append","purpose":"E2E probe of the board GitHub flow.","completion_criteria":"1) Append the line <!-- e2e: board flow check YYYY-MM-DD --> to README.md and commit it yourself with git commit (do not push). 2) Append a second line <!-- e2e: wip stash check YYYY-MM-DD --> to README.md and leave it uncommitted in the working tree. No other file is touched.","workspace":"registry"}'
```

Save the returned `id`. Adjust the marker lines' dates so reruns don't
collide with already-present lines.

## 2. Trigger pickup — it does NOT happen on registration

`POST /tasks` never fires the scheduler; the next natural poll is the *hourly*
tick. The immediate trigger is the "run now" gesture: moving a todo task that
is already at the queue head to the head again (`after: null`) — api.ts's
`/move` handler fires `pollNow()` only for that exact shape.

```bash
board -X POST "$BOARD/api/tasks/$ID/move" -H 'Content-Type: application/json' -d '{"after":null}'
```

## 3. Watch the task run (bounded)

```bash
for i in $(seq 1 20); do board "$BOARD/api/tasks/$ID" | python3 -c 'import sys,json; t=json.load(sys.stdin); print(t["status"], t["pr_number"])'; sleep 25; done
```

Expected progression: `todo` → `in_progress` (~seconds after the move; the
spawn includes an ~2s skill-enumeration ping per ADR 0025) → `done` with a
`pr_number` (~2 min). If it sticks at `todo`, see troubleshooting.md's pickup
section (throttle fail-closed is the usual culprit). If it wedges at
`in_progress` for >10 min, stop polling and read the worker log under
`/opt/tidepool/worker-logs/` — do not re-trigger.

## 4. Answer the merge question

The protected workspace escalates the PR to a merge-decision question task.
Find it and answer `merge` — use the FULL task id (a prefix 404s):

```bash
board "$BOARD/api/tasks" | python3 -c 'import sys,json; [print(t["id"], t["question_pending_merge_pr"]) for t in json.load(sys.stdin) if t["type"]=="question" and t["status"]=="todo"]'
board -X POST "$BOARD/api/tasks/$QID/answer" -H 'Content-Type: application/json' -d '{"answers":["merge"]}'
```

The answer route re-checks CI live and then merges as the board.

## 5. Verify on GitHub — the actual assertions

What "pass" means depends on the issue under test. From the dev machine:

```bash
# Identity of the PR/merge executor (issue #50): both must be tidepool-bot
gh pr view $PR --repo sinano1107/tidepool-registry --json author,mergedBy,state

# Commit authorship (issue #53): the task commit's author/committer must be
# the agent identity (e.g. "tako <tako@tidepool.invalid>"), and any
# board-made WIP commit must be the Tidepool identity
# (306969821+tidepool-bot@users.noreply.github.com)
gh api repos/sinano1107/tidepool-registry/pulls/$PR/commits --jq '.[] | {message: .commit.message, author: .commit.author, committer: .commit.committer}'
```

## 6. Fail-closed check (token file, issue #50 criterion 3)

Optional unless the change touches `github-auth.ts`. The warning doubles as
proof that `TIDEPOOL_GITHUB_TOKEN_FILE` reaches the process (an unset var is
silently off — no warning):

```bash
ssh $PI 'mv ~/.tidepool/github-token ~/.tidepool/github-token.bak && sudo systemctl restart tidepool && sleep 8 && sudo journalctl -u tidepool --since "30 sec ago" --no-pager | grep github-auth'
# expect: [github-auth] token file not readable — GitHub features off: ...
ssh $PI 'mv ~/.tidepool/github-token.bak ~/.tidepool/github-token && sudo systemctl restart tidepool'
```

After the restore restart, wait ~15s and confirm `active` plus **no** new
`github-auth` warning. (Caution: restart also re-runs registry parsing — a
crash here may be unrelated to the token; check the full journal, not just the
grep. This exact confusion happened during #50's ops when a registry data
migration was missing.)

## 7. Cleanup — always

The board leaves the workspace checkout on the task branch (pickup handles
switching, so this is normal, not damage) and the merged branch behind:

```bash
ssh $PI "cd /mnt/ssd/tidepool-registry && git checkout main -q && git pull --ff-only -q && git branch -D task/$ID && git push -q origin --delete task/$ID"
```

The README marker lines stay merged in — harmless, but if a pristine README
matters, remove them with a direct human-named commit to registry main (no
second E2E task for it). Because the uncommitted change in step 1 lands as a
second README line rather than a new file, the WIP-stash commit can never
introduce a stray file into `main` — there's nothing extra to clean up here.
