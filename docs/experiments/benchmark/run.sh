#!/usr/bin/env bash
# docs/experiments/benchmark/run.sh — run the benchmark's exercise set against one configuration on a
# disposable board in its own Lima VM, and extract the run record (ADR 0298, #2441). Run from the Mac:
#
#   bash docs/experiments/benchmark/run.sh [--commit REF] [--registry URL#REF] [--rows FILE]
#        [--issue-2437 STATE] [--label LABEL] [EXERCISE...]
#   bash docs/experiments/benchmark/run.sh --serve     # start the last run's board again, paused
#
# See README.md for what each step means and how to read the record. Tested by run.test.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_VM="${BENCH_VM:-tidepool-bench}"
# The gate board's VM (#1879) and its board unit (scripts/vm-board.sh). Only ever read here, never changed.
GATE_VM="tidepool-board"
UNIT="tidepool-bench"
# Lima forwards the guest's ports to the Mac on their own numbers, so keep clear of the gate board's 4589/4590.
PORT=4700
EXERCISES="${BENCH_EXERCISES:-$HERE/exercises}"
RESULTS="${BENCH_RESULTS:-$HERE/results}"
# Inside the VM. Literal on purpose: the guest shell expands $HOME.
TSX='~/tidepool/node_modules/.bin/tsx ~/tidepool/docs/experiments/benchmark/extract.ts'

# The installer's VM steps (ensure_lima, ensure_vm, prepare_claude_cli, vm) on the benchmark instance.
# Only those: its main also logs gh in and creates a GitHub registry, which a benchmark board does not use.
# shellcheck source=../../../scripts/mac-install.sh
TIDEPOOL_VM="$BENCH_VM" source "$HERE/../../../scripts/mac-install.sh"

COMMIT=main
REGISTRY=""
ROWS_FILE=""
ISSUE_2437=undecided
LABEL=run
NAMES=()

parse_args() {
  while (($#)); do
    case "$1" in
      --commit) COMMIT="$2"; shift 2 ;;
      --registry) REGISTRY="$2"; shift 2 ;;
      --rows) ROWS_FILE="$2"; shift 2 ;;
      --issue-2437) ISSUE_2437="$2"; shift 2 ;;
      --label) LABEL="$2"; shift 2 ;;
      -*) fail "unknown option $1" ;;
      *) NAMES+=("$1"); shift ;;
    esac
  done
  if ((${#NAMES[@]} == 0)); then
    local dir
    for dir in "$EXERCISES"/*/; do NAMES+=("$(basename "$dir")"); done
  fi
  # Declaration order, except that Interview exercises go last: an Interview's writes must not land in the
  # window of the memory meta-review being read (#2439 story 26).
  local name tasks=() interviews=()
  for name in "${NAMES[@]}"; do
    [[ -f "$EXERCISES/$name/exercise.json" ]] || fail "no exercise $name in $EXERCISES"
    if jq -e '.interview' "$EXERCISES/$name/exercise.json" > /dev/null; then interviews+=("$name"); else tasks+=("$name"); fi
  done
  NAMES=(${tasks[@]+"${tasks[@]}"} ${interviews[@]+"${interviews[@]}"})
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
  local providers
  providers="$(rows | jq -r .provider | sort -u)"
  if grep -qx openai <<< "$providers"; then
    vm 'test -s ~/.tidepool/codex/auth.json' \
      || fail "the rows name openai: log the VM's codex in first: limactl shell $BENCH_VM -- bash -lc 'CODEX_HOME=~/.tidepool/codex codex login --device-auth'"
  fi
  if grep -qx moonshot <<< "$providers"; then
    vm 'test -s ~/.tidepool/moonshot-api-key' \
      || fail "the rows name moonshot: put the key in the VM at ~/.tidepool/moonshot-api-key (mode 600)"
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
  # The loader at the board's commit rejects a malformed declaration now, not after an hour of board time.
  vm "cd ~/bench && $TSX check $(printf 'exercises/%s ' "${NAMES[@]}")"
}

# The registry's origin is a bare repo in the VM: the template seed, or the given URL#REF. One workspace per exercise, seeded here.
seed_registry() {
  if [[ -z "$REGISTRY" ]]; then
    vm 'source ~/bench/env && git init -q --bare ~/bench/registry.git && git clone -q ~/bench/registry.git "$TIDEPOOL_REGISTRY" && cd ~/tidepool && npm run -s init-registry > /dev/null'
  else
    vm "source ~/bench/env && git init -q --bare ~/bench/registry.git && git clone -q $(printf %q "${REGISTRY%#*}") \"\$TIDEPOOL_REGISTRY\" && cd \"\$TIDEPOOL_REGISTRY\" && git checkout -q $(printf %q "${REGISTRY##*#}") && git remote set-url origin ~/bench/registry.git && git push -q origin HEAD:main"
  fi
  # Each exercise's workspace is a git repo whose initial commit is its seed; main is its protected branch.
  local name ws yaml=""
  for name in "${NAMES[@]}"; do
    ws="$(decl '.task.workspace // .interview.workspace // empty' "$name")"
    [[ -n "$ws" ]] || continue
    vm "source ~/bench/env && w=\"\$TIDEPOOL_WORKSPACES_DIR/$ws\" && git init -q -b main \"\$w\" && cp -a ~/bench/exercises/$name/workspace/. \"\$w\"/ && git -C \"\$w\" add -A && git -C \"\$w\" commit -qm 'Seed $name'"
    yaml+="$ws:"$'\n'"  review_allowed_commands:"$'\n'"    - \"node --test\""$'\n'
  done
  REGISTRY_COMMIT="$(vm 'source ~/bench/env && cd "$TIDEPOOL_REGISTRY" && cat >> workspaces.yaml && git commit -qam "Benchmark workspaces" && git push -q origin HEAD:main && git rev-parse HEAD' <<< "$yaml")"
}

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS --fail-with-body -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@" "http://127.0.0.1:$PORT/api$path"
}

# A fresh token every start (the board keeps only its hash), and the board as a service so this script goes on.
start_board() {
  local notice
  notice="$(vm 'source ~/bench/env && cd ~/tidepool && npm run -s token')"
  TOKEN="$(awk '/token:/ { print $2 }' <<< "$notice")"
  vm 'systemd-run --user --unit tidepool-bench -p Delegate=yes -- bash -lc "source ~/bench/env && cd ~/tidepool && exec npm start"' > /dev/null
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
  spend_down
}

ROOTS=()
register_exercises() {
  local name body
  for name in "${NAMES[@]}"; do
    body="$(jq -c 'if .task then .task + {type: "work"} else {type: "interview", title, hypothesis: .interview.hypothesis, tier: .interview.tier, interview_targets: .interview.targets}
      + (.interview | {measured_work, workspace} | with_entries(select(.value != null))) end' "$EXERCISES/$name/exercise.json")"
    ROOTS+=("$(api POST /tasks -d "$body" | jq -r .id)")
    log "registered $name as ${ROOTS[${#ROOTS[@]} - 1]}"
  done
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

# No timeout, per exercise or overall: a human's wait is recorded, not failed (ADR 0298 決定6). Settlement comes in
# any order, so every root is read on every poll, through a retry if the human retried an Interview root.
wait_for_settlement() {
  local i open shown="" questions
  while :; do
    open=0
    for i in "${!ROOTS[@]}"; do
      ROOTS[i]="$(vm "source ~/bench/env && $TSX current-root \"\$TIDEPOOL_DB\" ${ROOTS[i]}")"
      settled "${ROOTS[i]}" || open=1
    done
    ((open)) || return 0
    questions="$(api GET /your-tasks | jq -r '.[] | "  \(.id)  \(.title)"')"
    if [[ "$questions" != "$shown" ]]; then
      log "waiting on the board; open questions (answer them in the WebUI):"
      printf '%s\n' "${questions:-  (none)}"
      shown="$questions"
    fi
    # re-armed every poll: a session window's reset drops it, and the post wakes the scheduler
    spend_down
    sleep 60
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
    vm "source ~/bench/env && git clone -q -b main \"\$TIDEPOOL_WORKSPACES_DIR/$ws\" ~/bench/check/$name && cd ~/bench/check/$name && export EXERCISE_DIR=~/bench/exercises/$name && $test" && rc=0 || rc=$?
    log "$name: expected-answer test exited $rc"
    TEST_EXITS+=("$rc")
  done
}

extract_record() {
  local input i table
  input="$(mktemp)"
  table="$(api GET /settings/execution | jq -c '.table | map(del(.quarantine_question_id))')"
  {
    jq -n --arg commit "$TIDEPOOL_COMMIT" --argjson pins "$CLI_PINS" --argjson rows "$table" --arg registry "$REGISTRY_COMMIT" --arg issue "$ISSUE_2437" \
      '{tidepool_commit: $commit, cli_pins: $pins, table_rows: $rows, registry_commit: $registry, issue_2437: $issue}'
    for i in "${!NAMES[@]}"; do
      jq -n --arg dir "exercises/${NAMES[i]}" --arg id "${ROOTS[i]}" --argjson exit "${TEST_EXITS[i]}" '{dir: $dir, task_id: $id, test_exit: $exit}'
    done
  } | jq -s '{config: .[0], exercises: .[1:]}' > "$input"
  limactl copy "$input" "$BENCH_VM:bench/input.json"
  rm -f "$input"
  vm "source ~/bench/env && cd ~/bench && $TSX run \"\$TIDEPOOL_DB\" \"\$TIDEPOOL_WORKER_LOGS\" input.json results"
  OUT="$RESULTS/$(date +%Y-%m-%d)-$LABEL"
  mkdir -p "$OUT"
  limactl copy "$BENCH_VM:bench/results/record.json" "$BENCH_VM:bench/results/summary.md" "$OUT/"
}

# Paused, then stopped: the state stays for the human to read (ADR 0298 決定7), and --serve brings it back paused.
stop_board() {
  api POST /pause -d '{"paused":true}' > /dev/null
  vm "systemctl --user stop $UNIT"
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
  check_credentials
  reset_state
  checkout_commit
  apply_cli_pins
  prepare_claude_cli
  copy_exercises
  seed_registry
  start_board
  configure_board
  register_exercises
  wait_for_settlement
  run_expected_tests
  extract_record
  stop_board
  log "Run record: $OUT"
}

# Guarded so run.test.sh can source this file and call main against its stubs (as scripts/mac-install.sh).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi
