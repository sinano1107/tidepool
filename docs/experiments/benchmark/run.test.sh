#!/usr/bin/env bash
# Tests for docs/experiments/benchmark/run.sh (#2441). Same shape as scripts/mac-install.test.sh: stubs record
# every external command, each case sources the harness in a fresh `bash -c` and calls main, and the summary is
# PASS/FAIL counts. PATH inside a case is the stub dir plus /usr/bin:/bin only, so no real Lima is reached —
# this Mac has real instances (`tidepool`, the gate board's `tidepool-board`) that a stray call would change.
# jq is the real /usr/bin/jq: the harness's JSON is part of what is pinned.
#
# Pinned at the command boundary: the order of a default run, the refusal while the gate board runs, the
# Interview exercise registered last, the wait without a timeout and in any settlement order (through an
# Interview retry), nothing deleted after the extraction, and every VM command naming the benchmark instance.
#
# Run: bash docs/experiments/benchmark/run.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "ok - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "not ok - $desc"
    echo "  --- expected ---"
    echo "$expected" | sed 's/^/  /'
    echo "  --- actual ---"
    echo "$actual" | sed 's/^/  /'
  fi
}

# --- stubs ------------------------------------------------------------------
# A case's board is a set of files under $CASE_DIR/state. The poll number is how many times the harness has
# slept; a file's line N is what that root reads on poll N (the last line holds after it runs out):
#   status/<id>  todo | done (no landing yet) | landed | held | cancelled
#   type/<id>    work (default) | interview
#   root/<id>    what `extract.ts current-root` prints for <id> (default: <id> itself)

write_stubs() {
  cat > "$STUB_DIR/at_poll" << 'STUB'
#!/bin/bash
# at_poll FILE DEFAULT: FILE's line for the current poll
poll=$(($(wc -l < "$CASE_DIR/sleeps") + 1))
if [ -f "$1" ]; then
  total=$(wc -l < "$1")
  [ "$poll" -le "$total" ] || poll=$total
  sed -n "${poll}p" "$1"
else
  echo "$2"
fi
STUB

  cat > "$STUB_DIR/limactl" << 'STUB'
#!/bin/bash
sub="$1"; shift
case "$sub" in
  list)
    echo "limactl list $*" >> "$CMD_LOG"
    name="${!#}"
    if [ "$name" = "tidepool-board" ]; then [ -n "$GATE_STATUS" ] && echo "$GATE_STATUS"; else echo Running; fi
    ;;
  shell)
    name="$1"; shift; shift # --
    if [ "$1" != bash ]; then
      echo "vm($name) $*" >> "$CMD_LOG"
      [ "$name" = tidepool-board ] && [ "$*" = "systemctl --user is-active --quiet tidepool-board.scope" ] && exit $((1 - GATE_ACTIVE))
      exit 0
    fi
    cmd="$3"
    echo "vm($name) $cmd" >> "$CMD_LOG"
    case "$cmd" in
      "cat > ~/bench/env") cat > "$CASE_DIR/stdin.env" ;;
      *"cat >> workspaces.yaml"*) cat > "$CASE_DIR/stdin.workspaces.yaml" ;;
    esac
    case "$cmd" in
      "claude auth status --json") [ "$CLAUDE_LOGGED_IN" = 1 ] && echo '{"loggedIn": true}' || echo '{"loggedIn": false}' ;;
      *"git -C ~/tidepool rev-parse HEAD") echo tidepoolsha ;;
      *"claude-cli-version"*) printf '{"claude":"2.1.289","codex":"0.147.0"}' ;;
      *"Benchmark workspaces"*) echo registrysha ;;
      *"npm run -s token") printf '\n  token: TKN\n  hash stored in: /home/x/bench/api-token\n' ;;
      *"current-root"*) id="${cmd##* }"; at_poll "$CASE_DIR/state/root/$id" "$id" ;;
      *"export EXERCISE_DIR"*) exit "$TEST_EXIT" ;;
    esac
    ;;
  copy)
    echo "limactl copy $*" >> "$CMD_LOG"
    [ "${!#}" = "tidepool-bench:bench/input.json" ] && cp "$1" "$CASE_DIR/input.json"
    case "${!#}" in */) touch "${!#}record.json" "${!#}summary.md" ;; esac
    ;;
  *) echo "limactl $sub $*" >> "$CMD_LOG" ;;
esac
exit 0
STUB

  cat > "$STUB_DIR/curl" << 'STUB'
#!/bin/bash
method=GET body="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
path="${url#http://127.0.0.1:4700/api}"
echo "curl $method ${url%%/api*} $path $body" >> "$CMD_LOG"
case "$method $path" in
  "POST /tasks")
    n=$(($(cat "$CASE_DIR/registered" 2> /dev/null || echo 0) + 1)); echo "$n" > "$CASE_DIR/registered"
    echo "{\"id\":\"root$n\"}" ;;
  "GET /tasks/"*"/events")
    id="${path#/tasks/}"; id="${id%/events}"
    case "$(at_poll "$CASE_DIR/state/status/$id" landed)" in
      landed) echo '[{"kind":"task_registered"},{"kind":"local_merge_executed"}]' ;;
      held) echo '[{"kind":"local_merge_held"}]' ;;
      *) echo '[{"kind":"task_registered"}]' ;;
    esac ;;
  "GET /tasks/"*)
    id="${path#/tasks/}"
    status="$(at_poll "$CASE_DIR/state/status/$id" landed)"
    case "$status" in landed | held) status=done ;; esac
    echo "{\"id\":\"$id\",\"status\":\"$status\",\"type\":\"$(at_poll "$CASE_DIR/state/type/$id" work)\"}" ;;
  "GET /your-tasks") echo '[{"id":"q1","title":"land completed task: Fix it"}]' ;;
  "GET /settings/execution") echo '{"table":[{"provider":"anthropic","tier":"standard","model":"claude-opus-5-5","effort":"high","price_in":5,"price_out":25,"quarantine_question_id":null}]}' ;;
  *) echo '{}' ;;
esac
STUB

  cat > "$STUB_DIR/sleep" << 'STUB'
#!/bin/bash
echo "sleep $*" >> "$CMD_LOG"
echo "$*" >> "$CASE_DIR/sleeps"
STUB

  # Tripwires: the harness drives these only inside the VM, never on the Mac.
  for tool in git npm node npx brew timeout; do
    printf '#!/bin/bash\necho "%s $*" >> "$CMD_LOG"\n' "$tool" > "$STUB_DIR/$tool"
  done
  chmod +x "$STUB_DIR"/*
}

# Two exercises whose names sort the Interview first, so "Interview last" is the harness's doing.
write_exercises() {
  mkdir -p "$EXERCISES/a-interview" "$EXERCISES/b-work/workspace"
  cat > "$EXERCISES/a-interview/exercise.json" << 'JSON'
{"title": "Interview the standard tier", "readings": ["interview"],
 "interview": {"hypothesis": "sonnet does the standard tier's work", "tier": "standard",
               "targets": [{"provider": "anthropic", "model": "claude-sonnet-5-5", "effort": "high"}]}}
JSON
  cat > "$EXERCISES/b-work/exercise.json" << 'JSON'
{"title": "Fix it", "readings": ["work"], "test": "node --test expected.test.js",
 "task": {"title": "Fix it", "purpose": "p", "completion_criteria": "c", "workspace": "bws", "tier": "standard", "assignee": "tako"}}
JSON
}

CASE_N=0
reset_case() {
  CASE_N=$((CASE_N + 1))
  CASE_DIR="$WORK_DIR/case$CASE_N"
  STUB_DIR="$CASE_DIR/bin"
  CMD_LOG="$CASE_DIR/cmd.log"
  EXERCISES="$CASE_DIR/exercises"
  mkdir -p "$STUB_DIR" "$CASE_DIR/state/status" "$CASE_DIR/state/type" "$CASE_DIR/state/root"
  : > "$CMD_LOG"
  : > "$CASE_DIR/sleeps"
  write_stubs
  write_exercises
  GATE_STATUS=""
  GATE_ACTIVE=0
  CLAUDE_LOGGED_IN=1
  TEST_EXIT=0
  ARGS=""
}

# Sets $rc, $output and $log; main runs as a bare command in its own bash so its `set -e` is real.
run_harness() {
  output=$(env PATH="$STUB_DIR:/usr/bin:/bin" HOME="$CASE_DIR" CMD_LOG="$CMD_LOG" CASE_DIR="$CASE_DIR" \
    BENCH_EXERCISES="$EXERCISES" BENCH_RESULTS="$CASE_DIR/results" GATE_STATUS="$GATE_STATUS" GATE_ACTIVE="$GATE_ACTIVE" \
    CLAUDE_LOGGED_IN="$CLAUDE_LOGGED_IN" TEST_EXIT="$TEST_EXIT" SCRIPT_DIR="$SCRIPT_DIR" \
    bash -c "set -euo pipefail; source \"\$SCRIPT_DIR/run.sh\"; main $ARGS" < /dev/null 2>&1) && rc=0 || rc=$?
  log="$(cat "$CMD_LOG")"
}

# The log as one step name per line, consecutive repeats folded — the order is what is pinned, not the wording.
steps() {
  sed -E \
    -e 's/^limactl list .*tidepool-board$/gate-vm-status/' \
    -e 's/^vm\(tidepool-board\) systemctl .*/gate-board-unit/' \
    -e 's/^limactl list .*/vm-status/' \
    -e 's/^vm\([^)]*\) claude auth status.*/claude-login/' \
    -e 's/^vm\([^)]*\) git config --global.*/git-identity/' \
    -e 's/^vm\([^)]*\) systemctl --user stop tidepool-bench 2.*/reset/' \
    -e 's/^vm\([^)]*\) cat > ~\/bench\/env/env-file/' \
    -e 's/^vm\([^)]*\) cd ~\/tidepool && git fetch.*/checkout/' \
    -e 's/^vm\([^)]*\) git -C ~\/tidepool rev-parse HEAD/read-commit/' \
    -e 's/^vm\([^)]*\) .*claude-cli-version.*/cli-pins/' \
    -e 's/^vm\([^)]*\) .*prepare-claude-cli.*/trust/' \
    -e 's/^limactl copy -r .*\/([^/ ]*) tidepool-bench:bench\/exercises\/$/copy \1/' \
    -e 's/^vm\([^)]*\) .*extract.ts check .*/check/' \
    -e 's/^vm\([^)]*\) .*init-registry.*/registry-seed/' \
    -e 's/^vm\([^)]*\) .*Benchmark workspaces.*/registry-workspaces/' \
    -e 's/^vm\([^)]*\) .*git init -q -b main .*Seed (.*)'"'"'$/workspace \1/' \
    -e 's/^vm\([^)]*\) .*npm run -s token/token/' \
    -e 's/^vm\([^)]*\) systemd-run .*/board-start/' \
    -e 's/^curl GET [^ ]* \/pause.*/board-ready/' \
    -e 's/^curl POST [^ ]* \/settings\/display-language.*/display-language/' \
    -e 's/^curl POST [^ ]* \/settings\/execution.*/table-row/' \
    -e 's/^curl POST [^ ]* \/spend-down.*/spend-down/' \
    -e 's/^curl POST [^ ]* \/tasks .*"title":"([^"]*)".*/register \1/' \
    -e 's/^vm\([^)]*\) .*current-root .* ([^ ]*)$/current-root \1/' \
    -e 's/^curl GET [^ ]* \/tasks\/([^/ ]*)\/events.*/events \1/' \
    -e 's/^curl GET [^ ]* \/tasks\/([^/ ]*) *$/status \1/' \
    -e 's/^curl GET [^ ]* \/your-tasks.*/questions/' \
    -e 's/^vm\([^)]*\) .*export EXERCISE_DIR.*/expected-test/' \
    -e 's/^curl GET [^ ]* \/settings\/execution.*/read-table/' \
    -e 's/^limactl copy .* tidepool-bench:bench\/input.json$/copy-input/' \
    -e 's/^vm\([^)]*\) .*extract.ts run .*/extract/' \
    -e 's/^limactl copy tidepool-bench:bench\/results\/.*/copy-results/' \
    -e 's/^curl POST [^ ]* \/pause.*/pause/' \
    -e 's/^vm\([^)]*\) systemctl --user stop tidepool-bench$/board-stop/' \
    -e 's/^sleep .*/sleep/' \
    <<< "$log" | uniq
}

# Every limactl call's instance, one per line: shell names it first, list last, copy as `instance:path`.
instances() {
  sed -nE -e 's/^vm\(([^)]*)\).*/\1/p' -e 's/^limactl list .* ([^ ]*)$/\1/p' -e 's/^limactl copy .* ([^ :]*):[^ ]*$/\1/p' \
    -e 's/^limactl copy (-r )?([^ :]*):.*/\2/p' <<< "$log"
}

# --- the default run ----------------------------------------------------------
# One poll where the work root still waits on its land question, then everything settled.

reset_case
printf 'done\nlanded\n' > "$CASE_DIR/state/status/root1"
printf 'interview\n' > "$CASE_DIR/state/type/root2"
printf 'todo\ndone\n' > "$CASE_DIR/state/status/root2"
run_harness
check "default: exits 0" "0" "$rc"
check "default: runs the whole sequence in order (CLI pins after the checkout move, Interview registered last)" "gate-vm-status
vm-status
claude-login
git-identity
reset
env-file
checkout
read-commit
cli-pins
trust
copy b-work
copy a-interview
check
registry-seed
registry-workspaces
workspace b-work
token
board-start
board-ready
display-language
spend-down
register Fix it
register Interview the standard tier
current-root root1
status root1
events root1
current-root root2
status root2
questions
spend-down
sleep
current-root root1
status root1
events root1
current-root root2
status root2
expected-test
read-table
copy-input
extract
copy-results
pause
board-stop" "$(steps)"
check "default: every limactl call names the benchmark instance, except the two reads of the gate VM" "tidepool-board" \
  "$(instances | grep -vx tidepool-bench | sort -u)"
check "default: the gate VM is only read (its status and its board unit), never changed" "limactl list --format {{.Status}} tidepool-board" \
  "$(grep 'tidepool-board' <<< "$log" | grep -v '^vm(tidepool-board) systemctl --user is-active')"
check "default: every API call goes to the benchmark board's port, not the gate board's 4589" "http://127.0.0.1:4700" \
  "$(sed -nE 's/^curl [A-Z]+ ([^ ]*) .*/\1/p' <<< "$log" | sort -u)"
check "default: nothing runs on the Mac that belongs in the VM (git, npm, node) and nothing is timed out" "" \
  "$(grep -E '^(git|npm|node|npx|brew|timeout) ' <<< "$log" || true)"
check "default: the board's state lives under ~/bench, on a port other than the gate board's" "export TIDEPOOL_REGISTRY=\$HOME/bench/registry TIDEPOOL_DB=\$HOME/bench/board.sqlite TIDEPOOL_WORKER_LOGS=\$HOME/bench/worker-logs
export TIDEPOOL_WORKSPACES_DIR=\$HOME/bench/workspaces TIDEPOOL_API_TOKEN_FILE=\$HOME/bench/api-token
export PORT=4700 MCP_PORT=4701 PATH=\$HOME/.local/bin:\$PATH" "$(cat "$CASE_DIR/stdin.env")"
check "default: one registry workspace per exercise that names one" "bws:
  review_allowed_commands:
    - \"node --test\"" "$(cat "$CASE_DIR/stdin.workspaces.yaml")"
check "default: the extraction gets the configuration, the root ids and the test exits" \
  '{"config":{"tidepool_commit":"tidepoolsha","cli_pins":{"claude":"2.1.289","codex":"0.147.0"},"table_rows":[{"provider":"anthropic","tier":"standard","model":"claude-opus-5-5","effort":"high","price_in":5,"price_out":25}],"registry_commit":"registrysha","issue_2437":"undecided"},"exercises":[{"dir":"exercises/b-work","task_id":"root1","test_exit":0},{"dir":"exercises/a-interview","task_id":"root2","test_exit":null}]}' \
  "$(jq -c . "$CASE_DIR/input.json")"
check "default: nothing deletes the run's state after the extraction" "" \
  "$(sed -n '/extract.ts run/,$p' <<< "$log" | grep -E 'rm -rf|reset-failed' || true)"
check "default: the record lands in results/<date>-<label> and its path is printed" "1" \
  "$(grep -c "Run record: $CASE_DIR/results/$(date +%Y-%m-%d)-run" <<< "$output")"
check "default: prints where to open the WebUI" "1" "$(grep -c 'http://127.0.0.1:4700/auth?token=TKN' <<< "$output")"

# --- the gate board ------------------------------------------------------------

reset_case
GATE_STATUS=Running
GATE_ACTIVE=1
run_harness
check "gate running: exits non-zero" "1" "$rc"
check "gate running: says how to stop it" "1" "$(grep -c 'systemctl --user stop tidepool-board.scope' <<< "$output")"
check "gate running: no call reaches the benchmark VM" "gate-vm-status
gate-board-unit" "$(steps)"

reset_case
GATE_STATUS=Running
GATE_ACTIVE=0
printf 'interview\n' > "$CASE_DIR/state/type/root2"
run_harness
check "gate VM up but its board stopped: the run goes on" "0" "$rc"

# --- credentials ----------------------------------------------------------------

reset_case
CLAUDE_LOGGED_IN=0
run_harness
check "claude logged out: exits non-zero" "1" "$rc"
check "claude logged out: stops before the reset, so the last run's state stays" "gate-vm-status
vm-status
claude-login" "$(steps)"

# --- the wait -------------------------------------------------------------------
# Settlement comes in any order: the later root settles first and the earlier one stays open for polls.

reset_case
cp -r "$EXERCISES/b-work" "$EXERCISES/c-work"
sed -i '' 's/"Fix it"/"Fix more"/; s/"bws"/"cws"/' "$EXERCISES/c-work/exercise.json"
ARGS="b-work c-work"
printf 'todo\ntodo\ndone\ndone\nlanded\n' > "$CASE_DIR/state/status/root1"
printf 'landed\n' > "$CASE_DIR/state/status/root2"
run_harness
check "reverse settlement: exits 0" "0" "$rc"
check "reverse settlement: polls until the earlier root too has landed" "4" "$(grep -c '^sleep' <<< "$log")"
check "reverse settlement: no expected test or extraction before the last poll" "" \
  "$(steps | awk '/^sleep$/ { last = NR } { line[NR] = $0 } END { for (i = 1; i < last; i++) print line[i] }' | grep -E '^(expected-test|extract)$' || true)"
check "reverse settlement: a root done but not yet landed keeps the run waiting (read on polls 3, 4 and 5)" "3" \
  "$(grep -c 'curl GET http://127.0.0.1:4700 /tasks/root1/events' <<< "$log")"

# A held land question settles the root too: the human declined to land, and the tests then read main as it is.
reset_case
ARGS="b-work"
printf 'held\n' > "$CASE_DIR/state/status/root1"
TEST_EXIT=1
run_harness
check "held land question: the run settles and records the failing test" "0 1" \
  "$rc $(jq -r '.exercises[0].test_exit' "$CASE_DIR/input.json")"

# The human retries the Interview root mid-wait: the old root reads cancelled, current-root names the new one.
reset_case
printf 'interview\n' > "$CASE_DIR/state/type/root2"
printf 'todo\ncancelled\n' > "$CASE_DIR/state/status/root2"
printf 'root2\nroot3\n' > "$CASE_DIR/state/root/root2"
printf 'interview\n' > "$CASE_DIR/state/type/root3"
printf 'todo\ntodo\ntodo\ndone\n' > "$CASE_DIR/state/status/root3"
run_harness
check "Interview retry: exits 0" "0" "$rc"
check "Interview retry: keeps waiting on the new root, not the cancelled old one" "3" "$(grep -c '^sleep' <<< "$log")"
check "Interview retry: the old root is not read again once the retry is seen" "1" "$(grep -c 'curl GET http://127.0.0.1:4700 /tasks/root2 *$' <<< "$log")"
check "Interview retry: the extraction gets the new root's id" "root3" "$(jq -r '.exercises[1].task_id' "$CASE_DIR/input.json")"

# --- summary ----------------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
