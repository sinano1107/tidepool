# Benchmark

A human-authored set of exercises, run on a disposable board in its own Lima VM, one configuration per run
(ADR 0298). The record of a run says, per exercise, whether the exercise's own tests pass after landing, how the
board settled it, what it cost and how long it took, and carries what the four optimisation processes decided
(meta-review decision rows, proposal questions, learner shadow rows, store writes, Interview scores).

## Plan

- **When:** a CLI pin is raised, the execution-setting table changes, or a release (ADR 0298 決定8). The default
  run is every exercise against the table's default rows.
- **Where:** the Lima VM `tidepool-bench`, never the gate board's `tidepool-board` (ADR 0298 決定2). The harness
  refuses to start while the gate board is running.
- **What is measured:** four axes, written into each record — the tidepool commit, the CLI pins that commit
  declares, the table rows, the registry commit — and the state of #2437.

## Run

On the Mac, from this checkout:

```bash
bash docs/experiments/benchmark/run.sh --label <label>
```

| Option | Default | |
|---|---|---|
| `--commit REF` | `main` | The tidepool commit the board runs. It must be on GitHub and contain this directory's `extract.ts`. |
| `--registry URL#REF` | the template seed | A registry to measure instead of the template (`init-registry`). |
| `--rows FILE` | none | A JSON array of table rows to add, in the table's own spelling. |
| `--issue-2437 STATE` | `undecided` | The state of #2437, or the ADR that decided it. |
| `EXERCISE...` | every directory in `exercises/` | The exercises to run, by directory name. |

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
The harness waits for every exercise to settle, with no timeout, and lists the open questions while it waits.
If you retry an Interview root, the harness follows the new root on its own.

When the run ends, the board is paused and stopped, its state (DB, worker-logs, workspaces) stays under `~/bench`
in the VM, and the record is copied to `results/<date>-<label>/`. To read the board again:

```bash
bash docs/experiments/benchmark/run.sh --serve
```

The next run deletes `~/bench`.

## Read

- `summary.md` has one row per exercise: its kind (`work` for a declared task, `optimisation` for an Interview),
  handled (its expected-answer test passed on the protected branch), the board's status, review verdict and
  landing, `cost_usd` per Harness (Codex is unpriced, ADR 0297), wall time split into pickup queue, human wait and
  board time, and the number of questions raised. An exercise's cost is its tree's worker sessions (root,
  descendants, Interview examinees, the landing questions naming the tree, and the trees of Interview roots a
  retry replaced) minus the sessions that learn from the record: RCA reviews, `memory_repair` and `routing_repair`.
  A work repair child stays on the row. Below the table, one line each sums the run-level spend by Provider or
  Harness (ADR 0299 決定5): learning (Board calls `allocation_review` / `attribution` / `behavior_draft`, and the
  meta-review, RCA and repair sessions), human surface (the four draft uses and `translation`), observation
  (`cli_auth_probe` / `model_probe`), and the unclassified sessions that fall in no exercise tree and no section.
  Unpriced calls and sessions are counted, never summed. Calls without usage and the usage TUI's startup quota
  check are not included.
- `record.json` holds the same rows with each session's agent and board-verb sequence, and the run-level sections:
  `spend` (each section by use, subject or task type, with its total; the unclassified sessions listed),
  `decision_rows`, `proposals`, `shadow`, `memory_writes`, `interviews`.
- Compare two records only when their `config` blocks differ in the axis you mean to compare.

## Exercises

Each `exercises/<name>/` holds:

- `exercise.json`: the declaration that `extract.ts check` validates. It declares a task (or an Interview), the
  readings it serves, its expected-answer `test` command, and any table rows it needs.
- `workspace/`: the seed, committed as the exercise workspace's first commit on `main`.
- `README.md`: the human steps, in order.

The test command runs in a clone of the workspace's `main` after landing, with `EXERCISE_DIR` set to the
exercise's directory in the VM. Keep the expected answer there, outside `workspace/`, so the worker never sees it.
An exercise must fit in the work watchdog's 90 minutes.

## Tests

`run.test.sh` pins the harness's command order against stubs, and `tests/benchmark-extract.test.ts` pins the
extraction. Run `bash docs/experiments/benchmark/run.test.sh` by hand after changing `run.sh`.
