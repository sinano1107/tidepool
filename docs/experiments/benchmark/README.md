# Benchmark

A human-authored set of exercises, run on a disposable board in its own Lima VM, one configuration per run
(ADR 0298). The record of a run says, per exercise, whether the exercise's own tests pass after landing, how the
board settled it, what it cost and how long it took, and carries what the four optimisation processes decided
(meta-review decision rows, proposal questions, learner shadow rows, store writes, Interview scores).

## Plan

- **When:** a CLI pin is raised, the execution-setting table changes, or a release (ADR 0298 決定8). The default
  run is the sequence in `run.json` against the table's default rows.
- **Where:** the Lima VM `tidepool-bench`, never the gate board's `tidepool-board` (ADR 0298 決定2). The harness
  refuses to start while the gate board is running.
- **What is measured:** four axes, written into each record — the tidepool commit, the CLI pins that commit
  declares, the table rows, the registry commit.

## Run

On the Mac, from this checkout:

```bash
bash docs/experiments/benchmark/run.sh --new --label <label>
```

`--new` starts a new run and deletes the last run's state in the VM. Without it the harness never deletes anything:
it resumes the run the VM holds, or stops and asks for `--new` if there is none.

| Option | Default | |
|---|---|---|
| `--sequence FILE` | `run.json` | The sequence to run. Its exercises are read from `exercises/` next to it. |
| `--commit REF` | `main` | The tidepool commit the board runs. It must be on GitHub and contain this directory's `extract.ts`. |
| `--registry URL#REF` | the template seed | A registry to measure instead of the template (`init-registry`). |
| `--rows FILE` | none | A JSON array of table rows to add, in the table's own spelling. |
| `--label LABEL` | `run` | The name of the record's directory. |

These options apply only with `--new`. A resume runs with the configuration its run started with.

The first run creates the VM and then stops at the login it needs. Log the VM's claude in once and run again:

```bash
limactl shell tidepool-bench -- bash -lc 'claude auth login'
```

If the table rows or an Interview's targets name `openai`, the harness checks the Codex login before it changes
anything. Install the pinned codex in `tidepool-bench` first, as in
[step 2 of the Codex version bump](../../codex-cli-version-bump.md#2-install-the-new-version-in-the-vm), with
`CODEX_APP_SERVER_VERSION` (`src/codex-app-server.ts`) as the version. Then log it in:
`limactl shell tidepool-bench -- bash -lc 'CODEX_HOME=~/.tidepool/codex codex login --device-auth'`. If they name
`moonshot`, put the key at `~/.tidepool/moonshot-api-key` in the VM.

During the run the harness prints a URL. Open it on the Mac: it logs you into the benchmark board's WebUI at
`http://127.0.0.1:4700`. Answer the board's questions there as in real use, following each exercise's README.
The harness goes through the sequence one item at a time. It registers an exercise, waits for it to settle (with
no timeout), and only then goes to the next item. While it waits it lists the open questions. If you retry an
Interview root, the harness follows the new root on its own. If a failure question says a usage limit was reached,
answer `retry`.

At a human step the harness prints what to do and waits:

- **First meta-review of a subject:** in the WebUI's settings, press `Start first <subject> meta-review`, then answer
  the review's questions. The harness waits until the review and everything under it (repair children, RCA,
  proposal questions) have settled. If the subject has no material yet, the door is closed: the harness records
  that and goes on without waiting.
- **Free text:** do what it says, then type `done` in the harness's terminal. The harness then waits until no task
  on the board is left unsettled.

At either step, type `skip` to leave it out. The record keeps `done`, `human_skip` and `door_closed` apart.

When the run ends, the board is paused and stopped, its state (DB, worker-logs, workspaces) stays under `~/bench`
in the VM, and the record is copied to `results/<date>-<label>/`. To read the board again:

```bash
bash docs/experiments/benchmark/run.sh --serve
```

### Resume

If the run stops (the Mac slept, the terminal closed, a day passed), check these first:

```bash
limactl shell tidepool-bench -- bash -lc 'claude auth status'
limactl list tidepool-bench
```

The first should say you are logged in; the second should show `Running` (if it does not, the harness starts the
VM). Then run the harness again without `--new`:

```bash
bash docs/experiments/benchmark/run.sh
```

It reads from the board's record which exercises are already registered, follows the ones that are, and continues
from the first unprocessed item. Human steps you finished are not asked again.

### Control run

To measure what the record taught the board, run the same sequence again with no objections and no first
meta-review. Type `skip` at every human step:

```bash
bash docs/experiments/benchmark/run.sh --new --label control
```

Compare the last exercise between the two records: the difference in whether it passes is the effect of what the
board learned.

## Sequence

`run.json` declares the run as an ordered list. The harness never reorders it.

```json
{
  "period_days": 1,
  "items": [
    { "exercise": "slugify" },
    { "human": "first_meta_review", "subject": "memory" },
    { "human": "step", "instructions": "Object to the meta-review's write row: ..." }
  ]
}
```

- `exercise` names a directory in `exercises/`.
- `human: first_meta_review` takes a `subject`, `memory` or `routing`.
- `human: step` takes free-text `instructions`.
- `period_days` (optional) is the meta-review period, set on the board before the first exercise is registered.

`extract.ts check run.json` validates the sequence and its exercises. The harness runs this check in the VM before
it starts.

## Read

- `summary.md` has one row per exercise: its kind (`work` for a declared task, `optimisation` for an Interview),
  handled (its expected-answer test passed on the protected branch), the board's status, review verdict and
  landing, `cost_usd` per Harness (Codex is unpriced, ADR 0297), wall time split into pickup queue, human wait and
  board time, the number of questions raised, and what the agents did: `children` (tasks resting on a
  decomposition decision), `depth` (the decomposition decision rows), `objections`, `repairs` by type (`work`,
  `memory_repair`, `routing_repair`) and `retries` (failure questions answered `retry` and Interview root retries).
  An exercise's cost is its tree's worker sessions (root,
  descendants, Interview examinees, the landing questions naming the tree, and the trees of Interview roots a
  retry replaced) minus the sessions that learn from the record: RCA reviews, `memory_repair` and `routing_repair`.
  A work repair child stays on the row. The replaced roots add to the cost only: wall time, settlement and
  questions read the current root's tree. Below the table, one line each sums the run-level spend by Provider or
  Harness (ADR 0299 決定5): learning (Board calls `allocation_review` / `attribution` / `behavior_draft`, and the
  meta-review, RCA and repair sessions), human surface (Board calls `task_draft` / `child_draft` / `handoff_draft` / `issue_inspection` /
  `translation`), observation
  (`cli_auth_probe` / `model_probe`), and the unclassified sessions that fall in no exercise tree and no section.
  Unpriced calls and sessions are counted, never summed. Calls without usage and the usage TUI's startup quota
  check are not included. Then one line per human step: its outcome, when it was prompted and finished, and what
  it waited on.
- `record.json` holds the same rows with each session's agent and board-verb sequence, and the run-level sections:
  `spend` (each section by use, subject or task type, with its total; the learning and unclassified sessions listed
  with their agent and board-verb sequence),
  `human_steps`, `decision_rows`, `proposals`, `shadow`, `memory_writes`, `interviews`. Each session row's `record`
  is the relative path of its session file.
- `sessions/<task id>.<worker_spawned event id>.md` is one file per session the record counts (exercise trees,
  learning, unclassified): the prompt the worker received (the user prompt, then each system part under its own
  heading, the definition with its builtin flag and version, the authority with its source and profile name) and
  every board verb call in transcript order with its arguments and response in full as JSON. A response is the text
  the worker saw, so a response cut to the response budget ends with the board's `[tidepool: response cut to …]`
  marker. An error result is marked `(error)`. Other tools (Bash, Read, …) are not shown. A session whose prompt or
  transcript was not recorded says so in one line. The worker's stderr is never read.
- To follow an exercise down, read its row in `summary.md`, then its session rows in `record.json`, then the
  session files those rows name.
- Compare two records only when their `config` blocks differ in the axis you mean to compare.

## Exercises

Each `exercises/<name>/` holds:

- `exercise.json`: the declaration that `extract.ts check` validates. It declares a task (or an Interview), the
  readings it serves (`work`, `interview`, `memory`, `routing`, `learner`, `decompose`, `repair`), its
  expected-answer `test` command, and any table rows it needs.
- `workspace/`: the seed, committed as the exercise workspace's first commit on `main`.
- `README.md`: the human steps, in order.

The test command runs in a clone of the workspace's `main` after landing, with `EXERCISE_DIR` set to the
exercise's directory in the VM. Keep the expected answer there, outside `workspace/`, so the worker never sees it.
An exercise must fit in the work watchdog's 90 minutes.

## Tests

`run.test.sh` pins the harness's command order against stubs, and `tests/benchmark-extract.test.ts` pins the
extraction. Run `bash docs/experiments/benchmark/run.test.sh` by hand after changing `run.sh`.
