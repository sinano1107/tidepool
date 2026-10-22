#!/usr/bin/env bash
# docs/experiments/benchmark/run.sh — run the benchmark's sequence (run.json) item by item against one configuration
# on a disposable board in its own Lima VM, and extract the run record (ADR 0298, #2441, #2503). Run from the Mac:
#
#   bash docs/experiments/benchmark/run.sh --new [--sequence FILE] [--commit REF] [--registry URL#REF]
#        [--rows FILE] [--label LABEL]   # a new run: deletes the last run's state
#   bash docs/experiments/benchmark/run.sh             # resume the run in the VM from its first unprocessed item
#   bash docs/experiments/benchmark/run.sh --serve     # start the last run's board again, paused
#
# See README.md for what each step means and how to read the record. Tested by run.test.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The benchmark VM and its board unit. Fixed, never taken from the environment: the steps below wipe and rewrite it.
BENCH_VM="tidepool-bench"
UNIT="tidepool-bench"
# The gate board's VM (#1879). Only ever read here, never changed.
GATE_VM="tidepool-board"
# Lima forwards the guest's ports to the Mac on their own numbers, so keep clear of the gate board's 4589/4590.
PORT=4700
SEQUENCE="${BENCH_SEQUENCE:-$HERE/run.json}"
RESULTS="${BENCH_RESULTS:-$HERE/results}"
# Inside the VM. Literal on purpose: the guest shell expands $HOME.
TSX='~/tidepool/node_modules/.bin/tsx ~/tidepool/docs/experiments/benchmark/extract.ts'

# The installer's VM steps (ensure_lima, ensure_vm, prepare_claude_cli, vm) on the benchmark instance.
# Only those: its main also logs gh in and creates a GitHub registry, which a benchmark board does not use.
# shellcheck source=../../../scripts/mac-install.sh
TIDEPOOL_VM="$BENCH_VM" source "$HERE/../../../scripts/mac-install.sh"

NEW=0
COMMIT=main
REGISTRY=""
ROWS_FILE=""
LABEL=run

parse_args() {
  local given=""
  while (($#)); do
    case "$1" in
      --new) NEW=1; shift ;;
      --sequence) SEQUENCE="$2"; given+=" $1"; shift 2 ;;
      --commit) COMMIT="$2"; given+=" $1"; shift 2 ;;
      --registry) REGISTRY="$2"; given+=" $1"; shift 2 ;;
      --rows) ROWS_FILE="$2"; given+=" $1"; shift 2 ;;
      --label) LABEL="$2"; given+=" $1"; shift 2 ;;
      *) fail "unknown argument $1" ;;
    esac
  done
  # A resume runs the configuration the run started with: an option here would be silently ignored.
  ((NEW)) || [[ -z "$given" ]] || fail "$given configure a new run: add --new (it deletes the last run's state), or drop them to resume"
}

# The sequence's exercises, in declaration order: they live in exercises/ next to it.
NAMES=()
load_sequence() {
  [[ -f "$SEQUENCE" ]] || fail "no sequence $SEQUENCE"
  EXERCISES="$(dirname "$SEQUENCE")/exercises"
  local name
  while read -r name; do
    [[ -f "$EXERCISES/$name/exercise.json" ]] || fail "no exercise $name in $EXERCISES"
    NAMES+=("$name")
  done < <(jq -r '.items[] | .exercise // empty' "$SEQUENCE")
}

decl() { jq -r "$1" "$EXERCISES/$2/exercise.json"; }

# The table rows the run installs: the --rows file's and each selected exercise's.
rows() {
  local files=()
  local name
  for name in "${NAMES[@]}"; do files+=("$EXERCISES/$name/exercise.json"); done
  { jq -c '.table_rows // [] | .[]' "${files[@]}"; if [[ -n "$ROWS_FILE" ]]; then jq -c '.[]' "$ROWS_FILE"; fi; }
}

refuse_if_gate_board_running() {
  if [[ "$(limactl list --format '{{.Status}}' "$GATE_VM" 2> /dev/null || true)" == "Running" ]] \
    && limactl shell "$GATE_VM" -- systemctl --user is-active --quiet tidepool-board.scope; then
    fail "the gate board is running in '$GATE_VM' — stop it first, or the run takes its usage window: limactl shell $GATE_VM -- systemctl --user stop tidepool-board.scope"
  fi
}

# Logins are the human's, once per VM (ADR 0298 決定2). Checked before the reset, so a missing one keeps the last run.
check_credentials() {
  vm 'claude auth status --json' 2> /dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true' \
    || fail "log the benchmark VM's claude in first: limactl shell $BENCH_VM -- bash -lc 'claude auth login'"
  # The providers the run speaks beyond the default rows: its table rows and its Interview targets.
  local providers name
  providers="$({
    rows
    for name in "${NAMES[@]}"; do jq -c '.interview.targets // [] | .[]' "$EXERCISES/$name/exercise.json"; done
  } | jq -r .provider | sort -u)"
  if grep -qx openai <<< "$providers"; then
    vm 'test -s ~/.tidepool/codex/auth.json' \
      || fail "the run uses openai: install the pinned codex in the VM and log it in first (README.md, Run)"
  fi
  if grep -qx moonshot <<< "$providers"; then
    vm 'test -s ~/.tidepool/moonshot-api-key' \
      || fail "the run uses moonshot: put the key in the VM at ~/.tidepool/moonshot-api-key (mode 600)"
  fi
  # Commits in the registry and the workspaces need an identity; this VM never had gh to take one from.
  vm 'git config --global user.email > /dev/null || { git config --global user.name benchmark && git config --global user.email benchmark@localhost; }'
}

# Everything a run writes lives under ~/bench, so the reset is one directory. ~/.tidepool keeps the logins.
reset_state() {
  vm "systemctl --user stop $UNIT 2> /dev/null; systemctl --user reset-failed $UNIT 2> /dev/null; rm -rf ~/bench && mkdir -p ~/bench/exercises"
  vm 'cat > ~/bench/env' << ENV
export TIDEPOOL_REGISTRY=\$HOME/bench/registry TIDEPOOL_DB=\$HOME/bench/board.sqlite TIDEPOOL_WORKER_LOGS=\$HOME/bench/worker-logs
export TIDEPOOL_WORKSPACES_DIR=\$HOME/bench/workspaces TIDEPOOL_API_TOKEN_FILE=\$HOME/bench/api-token
export PORT=$PORT MCP_PORT=$((PORT + 1)) PATH=\$HOME/.local/bin:\$PATH
ENV
}

checkout_commit() {
  vm "cd ~/tidepool && git fetch -q origin $(printf %q "$COMMIT") && git checkout -q -f --detach FETCH_HEAD && npm ci --silent"
  TIDEPOOL_COMMIT="$(vm 'git -C ~/tidepool rev-parse HEAD')"
}

# The CLI versions the checkout pins (ADR 0186): a CLI on any other version is quarantined by the Harness
# containment check and nothing is picked up. Claude as the VM template does, Codex as codex-cli-version-bump.md.
apply_cli_pins() {
  local pins='cd ~/tidepool && c=$(cat claude-cli-version) && x=$(sed -n "s/^export const CODEX_APP_SERVER_VERSION = \"codex-cli \(.*\)\";$/\1/p" src/codex-app-server.ts)'
  pins+=' && { [ "$(claude --version | cut -d" " -f1)" = "$c" ] || claude install "$c" > /dev/null; }'
  pins+=' && { [ "$(codex --version 2> /dev/null)" = "codex-cli $x" ] || { d=~/.local/share/codex/$x && mkdir -p $d && cd $d && npm pack --silent @openai/codex@$x-linux-arm64 > /dev/null && tar xzf openai-codex-$x-linux-arm64.tgz --strip-components=3 package/vendor/aarch64-unknown-linux-musl && rm openai-codex-$x-linux-arm64.tgz && ln -sfn $d/bin/codex ~/.local/bin/codex; }; }'
  pins+=' && printf "{\"claude\":\"%s\",\"codex\":\"%s\"}" "$c" "$x"'
  CLI_PINS="$(vm "$pins")"
}

copy_exercises() {
  local name
  for name in "${NAMES[@]}"; do limactl copy -r "$EXERCISES/$name" "$BENCH_VM:bench/exercises/"; done
  limactl copy "$SEQUENCE" "$BENCH_VM:bench/run.json"
  # The loader at the board's commit rejects a malformed declaration now, not after an hour of board time.
  vm "cd ~/bench && $TSX check run.json"
}

# What the board does not hold, for a resume: the configuration measured and the label. The sequence and its
# exercises are already under ~/bench; the human steps' outcomes are appended there as each step finishes.
save_state() {
  jq -nc --arg commit "$TIDEPOOL_COMMIT" --argjson pins "$CLI_PINS" --arg registry "$REGISTRY_COMMIT" --arg label "$LABEL" \
    '{tidepool_commit: $commit, cli_pins: $pins, registry_commit: $registry, label: $label}' | vm 'cat > ~/bench/state.json'
}

# A resume reads the run as it started: its configuration, and its sequence and exercises copied back from the VM.
# ponytail: a --rows file is not copied back, so a resume checks the Codex / Moonshot logins against the exercises' rows only
restore_state() {
  vm 'test -f ~/bench/state.json' || fail "no run in $BENCH_VM's ~/bench to resume: start one with --new"
  local dir
  { read -r TIDEPOOL_COMMIT; read -r CLI_PINS; read -r REGISTRY_COMMIT; read -r LABEL; } \
    <<< "$(vm 'cat ~/bench/state.json' | jq -r '.tidepool_commit, (.cli_pins | tojson), .registry_commit, .label')"
  dir="$(mktemp -d)"
  limactl copy -r "$BENCH_VM:bench/exercises" "$BENCH_VM:bench/run.json" "$dir/"
  SEQUENCE="$dir/run.json"
}

# The registry's origin is a bare repo in the VM: the template seed, or the given URL#REF. One workspace per exercise, seeded here.
# The record names the registry as measured, not the seeded commit (whose sha changes every run): the given ref's
# commit, or the template at the tidepool commit, which the seed follows from.
seed_registry() {
  if [[ -z "$REGISTRY" ]]; then
    vm 'source ~/bench/env && git init -q --bare ~/bench/registry.git && git clone -q ~/bench/registry.git "$TIDEPOOL_REGISTRY" && cd ~/tidepool && npm run -s init-registry > /dev/null'
    REGISTRY_COMMIT="template@$TIDEPOOL_COMMIT"
  else
    REGISTRY_COMMIT="$(vm "source ~/bench/env && git init -q --bare ~/bench/registry.git && git clone -q $(printf %q "${REGISTRY%#*}") \"\$TIDEPOOL_REGISTRY\" && cd \"\$TIDEPOOL_REGISTRY\" && git checkout -q $(printf %q "${REGISTRY##*#}") && git remote set-url origin ~/bench/registry.git && git push -q origin HEAD:main && git rev-parse HEAD")"
  fi
  # Each exercise's workspace is a git repo whose initial commit is its seed; main is its protected branch.
  local name ws yaml=""
  for name in "${NAMES[@]}"; do
    ws="$(decl '.task.workspace // .interview.workspace // empty' "$name")"
    [[ -n "$ws" ]] || continue
    vm "source ~/bench/env && w=\"\$TIDEPOOL_WORKSPACES_DIR/$ws\" && git init -q -b main \"\$w\" && cp -a ~/bench/exercises/$name/workspace/. \"\$w\"/ && git -C \"\$w\" add -A && git -C \"\$w\" commit -qm 'Seed $name'"
    yaml+="$ws:"$'\n'"  review_allowed_commands:"$'\n'"    - \"node --test\""$'\n'
  done
  vm 'source ~/bench/env && cd "$TIDEPOOL_REGISTRY" && cat >> workspaces.yaml && git commit -qam "Benchmark workspaces" && git push -q origin HEAD:main' <<< "$yaml"
}

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS --fail-with-body -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@" "http://127.0.0.1:$PORT/api$path"
}

# A fresh token every start (the board keeps only its hash), and the board as a service so this script goes on.
# Lingering keeps the user manager, and so the board, alive while no `limactl shell` session is open.
start_board() {
  local notice
  vm 'loginctl enable-linger "$USER"'
  notice="$(vm 'source ~/bench/env && cd ~/tidepool && npm run -s token')"
  TOKEN="$(awk '/token:/ { print $2 }' <<< "$notice")"
  vm "systemd-run --user --unit $UNIT -p Delegate=yes -- bash -lc 'source ~/bench/env && cd ~/tidepool && exec npm start'" > /dev/null
  local tries=0
  until api GET /pause > /dev/null 2>&1; do
    ((++tries < 60)) || fail "the board did not answer on $PORT: limactl shell $BENCH_VM -- journalctl --user -u $UNIT"
    sleep 2
  done
  log "WebUI: open this on the Mac (sets the cookie): http://127.0.0.1:$PORT/auth?token=$TOKEN"
}

# Spend-down on every window clears the pace throttle (#2439 story 22); arming also wakes the scheduler.
spend_down() {
  local pair
  for pair in anthropic:session anthropic:week openai:primary openai:secondary; do
    api POST /spend-down -d "{\"provider\":\"${pair%:*}\",\"window\":\"${pair#*:}\",\"active\":true}" > /dev/null
  done
}

configure_board() {
  # English means no display-time translation, whose Board calls would spend the budget being measured (#224)
  api POST /settings/display-language -d '{"language":"English"}' > /dev/null
  local row
  while read -r row; do
    [[ -n "$row" ]] && api POST /settings/execution -d "{\"setting\":\"row\",\"row\":$row}" > /dev/null
  done <<< "$(rows)"
  local period
  period="$(jq '.period_days // empty' "$SEQUENCE")"
  [[ -z "$period" ]] || api POST /settings/meta-review -d "{\"period_days\":$period}" > /dev/null
  # a refusal (the 5 minutes after a window reset) is retried by every poll of the wait
  spend_down || true
}

# Closed, and for a work root its land question answered (landed or held) or nothing to land.
# ponytail: the landing kinds mirror extract.ts's LANDINGS plus the hold — add a kind there, add it here.
settled() {
  local task
  task="$(api GET "/tasks/$1")"
  case "$(jq -r .status <<< "$task")" in
    cancelled) return 0 ;;
    done) [[ "$(jq -r .type <<< "$task")" != work ]] \
      || api GET "/tasks/$1/events" | jq -e 'any(.[]; .kind | IN("local_merge_executed", "local_merge_held", "nothing_to_land", "landing_finished", "pr_merged"))' > /dev/null ;;
    *) return 1 ;;
  esac
}

# A read of the board's DB at the board's commit, in the VM.
board_read() { vm "source ~/bench/env && $TSX $1 \"\$TIDEPOOL_DB\" $2"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One poll's housekeeping: list the open questions when they change, and re-arm spend-down (a session window's reset
# drops it, and the post wakes the scheduler; the board refuses an arm for the 5 minutes after a window resets, so a
# refusal waits for the next poll).
SHOWN=""
poll() {
  local questions
  if questions="$(api GET /tasks | jq -r '.[] | select(.type == "question" and .status != "done" and .status != "cancelled") | "  \(.id)  \(.title)"')" \
    && [[ "$questions" != "$SHOWN" ]]; then
    log "waiting on the board; open questions (answer them in the WebUI):"
    printf '%s\n' "${questions:-  (none)}"
    SHOWN="$questions"
  fi
  spend_down || true
}

# A line the human types in this terminal (`done` / `skip`), or nothing once a poll's length has passed. Without a
# terminal (end of input) it waits the poll's length all the same rather than spin.
human_answer() {
  local line rc=0
  read -r -t 60 -u 3 line || rc=$?
  if ((rc == 0)); then printf '%s\n' "$line"; elif ((rc <= 128)); then sleep 60; fi
}

# The record of a human step, appended to ~/bench as the step finishes: what a resume skips and the extraction reads.
record_step() { # item, human, subject ("" for none), outcome, prompted_at, waited_on (JSON)
  jq -nc --argjson item "$1" --arg human "$2" --arg subject "$3" --arg outcome "$4" --arg prompted "$5" --arg finished "$(now)" --argjson waited "$6" \
    '{item: $item, human: $human} + (if $subject == "" then {} else {subject: $subject} end) + {outcome: $outcome, prompted_at: $prompted, finished_at: $finished, waited_on: $waited}' \
    | vm 'cat >> ~/bench/human-steps.jsonl'
  log "human step $1: $4"
}

# An exercise: registered unless the board already holds its root (a resume), then waited on until it settles. No
# timeout: a human's wait is recorded, not failed (ADR 0298 決定6). The root is followed through a retry if the human
# retried an Interview root. A failed read only costs that poll: the run must outlive a transient error over hours.
ROOTS=()
run_exercise() { # name, root already on the board or ""
  local root="$2" next body
  if [[ -z "$root" ]]; then
    body="$(jq -c 'if .task then .task + {type: "work"} else {type: "interview", title, hypothesis: .interview.hypothesis, tier: .interview.tier, interview_targets: .interview.targets}
      + (.interview | {measured_work, workspace} | with_entries(select(.value != null))) end' "$EXERCISES/$1/exercise.json")"
    root="$(api POST /tasks -d "$body" | jq -r .id)"
    log "registered $1 as $root"
  fi
  while :; do
    next="$(board_read current-root "$root")" && root="$next"
    # A retry cancels the old root and registers the new one in one step, which may fall between the two reads:
    # a settled root counts only if it is still the current one.
    if settled "$root" && next="$(board_read current-root "$root")" && [[ "$next" == "$root" ]]; then break; fi
    poll
    sleep 60
  done
  ROOTS+=("$root")
}

# Human step (a): the human starts the subject's first meta-review in the WebUI (ADR 0300), and the run waits for it
# and everything under it (repair children, RCA, proposal questions) to settle. A closed door (no material yet) is
# recorded and passed without waiting.
first_meta_review() { # item, subject, root the human already started or ""
  local prompted_at state
  prompted_at="$(now)"
  if [[ -z "$3" ]] && api GET /settings/meta-review/status | jq -e ".$2 | .first_review == \"not_started\" and .material == 0" > /dev/null; then
    record_step "$1" first_meta_review "$2" door_closed "$prompted_at" null
    return
  fi
  [[ -n "$3" ]] || log "human step $1: in the WebUI's settings, press 'Start first $2 meta-review', then answer its questions as they come (type skip here to leave it out)"
  while :; do
    state="$(board_read first-meta-review "$2")" || state='{"root":null}'
    if jq -e .settled <<< "$state" > /dev/null; then
      record_step "$1" first_meta_review "$2" done "$prompted_at" "$(jq .root <<< "$state")"
      return
    fi
    if jq -e '.root == null' <<< "$state" > /dev/null; then
      if [[ "$(human_answer)" == skip ]]; then
        record_step "$1" first_meta_review "$2" human_skip "$prompted_at" null
        return
      fi
    else
      sleep 60
    fi
    poll
  done
}

# Human step (b): free text the human acts on. Once they type done, the run waits until the board has no unsettled
# task left (attached children included).
human_step() { # item, instructions
  local prompted_at answer
  prompted_at="$(now)"
  log "human step $1: $2 (type done here when it is done, or skip to leave it out)"
  while :; do
    answer="$(human_answer)"
    [[ "$answer" != done ]] || break
    if [[ "$answer" == skip ]]; then
      record_step "$1" step "" human_skip "$prompted_at" null
      return
    fi
    poll
  done
  until api GET /tasks | jq -e 'all(.[]; .status == "done" or .status == "cancelled")' > /dev/null; do
    poll
    sleep 60
  done
  record_step "$1" step "" done "$prompted_at" '"board"'
}

# The sequence, one item at a time: an exercise is registered only after the previous item settled (ADR 0298 追記
# #2449 決定2). Where to continue comes from the board's record and the human steps' record, not from this shell.
run_sequence() {
  # The human's answers come in on fd 3; nothing else (a `limactl shell` above all) may read what they type.
  exec 3<&0 < /dev/null
  local position i n item root outcome
  position="$(vm "source ~/bench/env && $TSX position ~/bench/run.json \"\$TIDEPOOL_DB\" ~/bench/human-steps.jsonl")"
  n="$(jq '.items | length' "$SEQUENCE")"
  for ((i = 0; i < n; i++)); do
    item="$(jq -c ".items[$i]" "$SEQUENCE")"
    root="$(jq -r ".[$i].root // empty" <<< "$position")"
    outcome="$(jq -r ".[$i].outcome // empty" <<< "$position")"
    case "$(jq -r '.human // "exercise"' <<< "$item")" in
      exercise) run_exercise "$(jq -r .exercise <<< "$item")" "$root" ;;
      first_meta_review) [[ -n "$outcome" ]] || first_meta_review "$i" "$(jq -r .subject <<< "$item")" "$root" ;;
      step) [[ -n "$outcome" ]] || human_step "$i" "$(jq -r .instructions <<< "$item")" ;;
    esac
  done
}

# The expected answer, on a clone of the protected branch after landing (ADR 0298 決定5). The board's checkout is left as it is.
TEST_EXITS=()
run_expected_tests() {
  local i name test ws rc
  for i in "${!NAMES[@]}"; do
    name="${NAMES[i]}"
    test="$(decl '.test // empty' "$name")"
    if [[ -z "$test" ]]; then TEST_EXITS+=(null); continue; fi
    ws="$(decl '.task.workspace' "$name")"
    # a fresh clone each time, so a resumed run never meets the last attempt's
    vm "source ~/bench/env && mkdir -p ~/bench/check && d=\$(mktemp -d ~/bench/check/$name.XXXXXX) && git clone -q -b main \"\$TIDEPOOL_WORKSPACES_DIR/$ws\" \$d && cd \$d && export EXERCISE_DIR=~/bench/exercises/$name && $test" && rc=0 || rc=$?
    log "$name: expected-answer test exited $rc"
    TEST_EXITS+=("$rc")
  done
}

extract_record() {
  local input i table
  input="$(mktemp)"
  table="$(api GET /settings/execution | jq -c '.table | map(del(.quarantine_question_id))')"
  {
    jq -n --arg commit "$TIDEPOOL_COMMIT" --argjson pins "$CLI_PINS" --argjson rows "$table" --arg registry "$REGISTRY_COMMIT" \
      '{tidepool_commit: $commit, cli_pins: $pins, table_rows: $rows, registry_commit: $registry}'
    for i in "${!NAMES[@]}"; do
      jq -n --arg dir "exercises/${NAMES[i]}" --arg id "${ROOTS[i]}" --argjson exit "${TEST_EXITS[i]}" '{dir: $dir, task_id: $id, test_exit: $exit}'
    done
  } | jq -s --argjson steps "$(vm 'cat ~/bench/human-steps.jsonl 2> /dev/null || true' | jq -s .)" '{config: .[0], exercises: .[1:], human_steps: $steps}' > "$input"
  limactl copy "$input" "$BENCH_VM:bench/input.json"
  rm -f "$input"
  vm "source ~/bench/env && cd ~/bench && $TSX run \"\$TIDEPOOL_DB\" \"\$TIDEPOOL_WORKER_LOGS\" input.json results"
  OUT="$RESULTS/$(date +%Y-%m-%d)-$LABEL"
  mkdir -p "$OUT"
  limactl copy "$BENCH_VM:bench/results/record.json" "$BENCH_VM:bench/results/summary.md" "$OUT/"
}

# Paused, then stopped: the state stays for the human to read (ADR 0298 決定7), and --serve brings it back paused.
# Also the exit trap of a run that fails or is interrupted once the board is up, so neither step may abort the other.
stop_board() {
  api POST /pause -d '{"paused":true}' > /dev/null || true
  vm "systemctl --user stop $UNIT" || true
}

main() {
  if [[ "${1:-}" == "--serve" ]]; then
    start_board
    return
  fi
  parse_args "$@"
  refuse_if_gate_board_running
  ensure_lima
  ensure_vm
  if ((NEW)); then
    load_sequence
    check_credentials
    reset_state
    checkout_commit
    apply_cli_pins
    prepare_claude_cli
    copy_exercises
    seed_registry
    save_state
  else
    # Nothing is reset, checked out, seeded or configured again: the table-row posts are not idempotent.
    restore_state
    load_sequence
    check_credentials
  fi
  start_board
  trap stop_board EXIT
  trap 'exit 130' INT TERM
  if ((NEW)); then configure_board; else api POST /pause -d '{"paused":false}' > /dev/null; fi
  run_sequence
  run_expected_tests
  extract_record
  trap - EXIT
  stop_board
  log "Run record: $OUT"
}

# Guarded so run.test.sh can source this file and call main against its stubs (as scripts/mac-install.sh).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi
