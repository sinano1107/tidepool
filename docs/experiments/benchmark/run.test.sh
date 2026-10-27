#!/usr/bin/env bash
# Tests for docs/experiments/benchmark/run.sh (#2441, #2503). Same shape as scripts/mac-install.test.sh: stubs record
# every external command, each case sources the harness in a fresh `bash -c` and calls main, and the summary is
# PASS/FAIL counts. PATH inside a case is the stub dir plus /usr/bin:/bin only, so no real Lima is reached —
# this Mac has real instances (`tidepool`, the gate board's `tidepool-board`) that a stray call would change.
# jq is the real /usr/bin/jq: the harness's JSON is part of what is pinned.
#
# Pinned at the command boundary: the order of a new run, the refusal while the gate board runs, the sequence
# registered one item at a time in its declared order (the next only after the previous root settled, through an
# Interview retry), registration stopping at a human step until it settles or the human types done / skip, the
# period_days post, a resume continuing from the first unprocessed item without deleting anything, nothing deleted
# after the extraction, and every VM command naming the benchmark instance.
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
# The VM's ~/bench is $CASE_DIR/bench: `limactl copy` and the harness's reads and writes of its files go there. A
# case's board is a set of files under $CASE_DIR/state. The poll number is how many times the harness has slept; a
# file's line N is what that root reads on poll N (the last line holds after it runs out):
#   status/<id>  todo | done (no landing yet) | landed | held | cancelled
#   type/<id>    work (default) | interview
#   board        what GET /tasks answers (default: one open land question)
# and by call rather than by poll (the last line holds after it runs out):
#   root/<id>           what `extract.ts current-root` prints for <id> (default: <id> itself; FAIL fails the call) —
#                       a poll may resolve a root twice
#   first-meta-review   what `extract.ts first-meta-review` prints (default: not started)
#   meta-review-status  what GET /settings/meta-review/status answers (default: both subjects have material)
#   position            what `extract.ts position` prints (default: nothing processed yet)
# and these switch a single failure on:
#   spend-down        ok | refuse, by poll
#   register-fails    present: POST /tasks answers 400
# $CASE_DIR/stdin is what the human types in the harness's terminal.

write_stubs() {
  cat > "$STUB_DIR/at_call" << 'STUB'
#!/bin/bash
# at_call FILE KEY DEFAULT: FILE's line for this call of KEY
mkdir -p "$CASE_DIR/calls"
n=$(($(cat "$CASE_DIR/calls/$2" 2> /dev/null || echo 0) + 1)); echo "$n" > "$CASE_DIR/calls/$2"
if [ -f "$1" ]; then
  total=$(wc -l < "$1")
  [ "$n" -le "$total" ] || n=$total
  sed -n "${n}p" "$1"
else
  echo "$3"
fi
STUB

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
      [ "$name" = tidepool-board ] && [ "$*" = "systemctl --user is-active --quiet tidepool-board.service" ] && exit $((1 - GATE_ACTIVE))
      exit 0
    fi
    cmd="$3"
    echo "vm($name) $cmd" >> "$CMD_LOG"
    case "$cmd" in
      "cat > ~/bench/env") cat > "$CASE_DIR/stdin.env" ;;
      *"cat >> workspaces.yaml"*) cat > "$CASE_DIR/stdin.workspaces.yaml" ;;
      *"rm -rf ~/bench && mkdir -p ~/bench/exercises"*) rm -rf "$CASE_DIR/bench" && mkdir -p "$CASE_DIR/bench/exercises" ;;
      "cat > ~/bench/state.json") cat > "$CASE_DIR/bench/state.json" ;;
      "test -f ~/bench/state.json") [ -f "$CASE_DIR/bench/state.json" ] || exit 1 ;;
      "cat ~/bench/state.json") cat "$CASE_DIR/bench/state.json" ;;
      "cat >> ~/bench/human-steps.jsonl") cat >> "$CASE_DIR/bench/human-steps.jsonl" ;;
      "cat ~/bench/human-steps.jsonl 2> /dev/null || true") cat "$CASE_DIR/bench/human-steps.jsonl" 2> /dev/null || true ;;
      "claude auth status --json") [ "$CLAUDE_LOGGED_IN" = 1 ] && echo '{"loggedIn": true}' || echo '{"loggedIn": false}' ;;
      *"git -C ~/tidepool rev-parse HEAD") echo tidepoolsha ;;
      *"claude-cli-version"*) printf '{"claude":"2.1.289","codex":"0.147.0"}' ;;
      *"remote set-url origin"*"git rev-parse HEAD") echo givensha ;;
      "test -s ~/.tidepool/codex/auth.json") exit $((1 - CODEX_LOGGED_IN)) ;;
      *"npm run -s token") printf '\n  token: TKN\n  hash stored in: /home/x/bench/api-token\n' ;;
      *"current-root"*)
        id="${cmd##* }"; root="$(at_call "$CASE_DIR/state/root/$id" "$id" "$id")"
        [ "$root" = FAIL ] && exit 1
        echo "$root" ;;
      *"extract.ts position"*)
        at_call "$CASE_DIR/state/position" position "$(jq -c '[.items[] | {root: null, outcome: null}]' "$CASE_DIR/bench/run.json")" ;;
      *"first-meta-review"*) at_call "$CASE_DIR/state/first-meta-review" first-meta-review '{"root":null,"settled":false}' ;;
      *"export EXERCISE_DIR"*) exit "$TEST_EXIT" ;;
      *"extract.ts run"*)
        out="$CASE_DIR/bench/$(tr -d '"' <<< "${cmd##* }")"
        mkdir -p "$out/sessions" && touch "$out/record.json" "$out/summary.md" "$out/sessions/root1.1.md" ;;
    esac
    ;;
  copy)
    echo "limactl copy $*" >> "$CMD_LOG"
    [ "$1" = -r ] && shift
    dest="${!#}"
    case "$dest" in tidepool-bench:*) dest="$CASE_DIR/${dest#tidepool-bench:}" ;; esac
    while [ $# -gt 1 ]; do
      src="$1"; shift
      case "$src" in tidepool-bench:*) src="$CASE_DIR/${src#tidepool-bench:}" ;; esac
      cp -R "$src" "$dest"
    done
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
    if [ -f "$CASE_DIR/state/register-fails" ]; then echo '{"error":"workspace bws is not in the registry"}'; exit 22; fi
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
  "GET /tasks") at_poll "$CASE_DIR/state/board" '[{"id":"root1","type":"work","status":"done","title":"Fix it"},{"id":"q1","type":"question","status":"todo","title":"land completed task: Fix it"}]' ;;
  "GET /settings/meta-review/status")
    at_call "$CASE_DIR/state/meta-review-status" meta-review-status \
      '{"memory":{"first_review":"not_started","material":3,"first_material_at":"2026-10-22T00:00:00Z"},"routing":{"first_review":"not_started","material":2,"first_material_at":"2026-10-22T00:00:00Z"}}' ;;
  "POST /spend-down")
    if [ "$(at_poll "$CASE_DIR/state/spend-down" ok)" = refuse ]; then echo '{"error":"window is resetting"}'; exit 22; fi
    echo '{}' ;;
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

# Three exercises; the default sequence declares the Interview first, so its position is the declaration's doing.
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
  cp -r "$EXERCISES/b-work" "$EXERCISES/c-work"
  sed -i '' 's/"Fix it"/"Fix more"/; s/"bws"/"cws"/' "$EXERCISES/c-work/exercise.json"
  sequence '{"exercise": "a-interview"}, {"exercise": "b-work"}'
}

# The case's run.json: its items, comma-separated.
sequence() { echo "{\"items\": [$1]}" > "$CASE_DIR/run.json"; }

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
  : > "$CASE_DIR/stdin"
  write_stubs
  write_exercises
  GATE_STATUS=""
  GATE_ACTIVE=0
  CLAUDE_LOGGED_IN=1
  CODEX_LOGGED_IN=1
  TEST_EXIT=0
  ARGS="--new"
}

# Sets $rc, $output and $log; main runs as a bare command in its own bash so its `set -e` is real.
run_harness() {
  output=$(env PATH="$STUB_DIR:/usr/bin:/bin" HOME="$CASE_DIR" CMD_LOG="$CMD_LOG" CASE_DIR="$CASE_DIR" \
    BENCH_SEQUENCE="$CASE_DIR/run.json" BENCH_RESULTS="$CASE_DIR/results" GATE_STATUS="$GATE_STATUS" GATE_ACTIVE="$GATE_ACTIVE" \
    CLAUDE_LOGGED_IN="$CLAUDE_LOGGED_IN" CODEX_LOGGED_IN="$CODEX_LOGGED_IN" TEST_EXIT="$TEST_EXIT" SCRIPT_DIR="$SCRIPT_DIR" \
    bash -c "set -euo pipefail; source \"\$SCRIPT_DIR/run.sh\"; main $ARGS" < "$CASE_DIR/stdin" 2>&1) && rc=0 || rc=$?
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
    -e 's/^limactl copy -r tidepool-bench:bench\/exercises .*/copy-back/' \
    -e 's/^limactl copy -r .*\/([^/ ]*) tidepool-bench:bench\/exercises\/$/copy \1/' \
    -e 's/^limactl copy .*run.json tidepool-bench:bench\/run.json$/copy-sequence/' \
    -e 's/^vm\([^)]*\) .*extract.ts check .*/check/' \
    -e 's/^vm\([^)]*\) .*init-registry.*/registry-seed/' \
    -e 's/^vm\([^)]*\) .*Benchmark workspaces.*/registry-workspaces/' \
    -e 's/^vm\([^)]*\) .*git init -q -b main .*Seed (.*)'"'"'$/workspace \1/' \
    -e 's/^vm\([^)]*\) cat > ~\/bench\/state.json/save-state/' \
    -e 's/^vm\([^)]*\) test -f ~\/bench\/state.json/has-state/' \
    -e 's/^vm\([^)]*\) cat ~\/bench\/state.json/read-state/' \
    -e 's/^vm\([^)]*\) .*npm run -s token/token/' \
    -e 's/^vm\([^)]*\) loginctl enable-linger.*/linger/' \
    -e 's/^vm\([^)]*\) test -s ~\/.tidepool\/codex.*/codex-login/' \
    -e 's/^vm\([^)]*\) systemd-run .*/board-start/' \
    -e 's/^curl GET [^ ]* \/pause.*/board-ready/' \
    -e 's/^curl POST [^ ]* \/settings\/display-language.*/display-language/' \
    -e 's/^curl POST [^ ]* \/settings\/execution.*/table-row/' \
    -e 's/^curl POST [^ ]* \/settings\/meta-review .*/period-days/' \
    -e 's/^curl GET [^ ]* \/settings\/meta-review\/status.*/meta-review-status/' \
    -e 's/^curl POST [^ ]* \/spend-down.*/spend-down/' \
    -e 's/^vm\([^)]*\) .*extract.ts position.*/position/' \
    -e 's/^vm\([^)]*\) .*extract.ts first-meta-review.*/first-meta-review/' \
    -e 's/^vm\([^)]*\) cat >> ~\/bench\/human-steps.jsonl/record-step/' \
    -e 's/^vm\([^)]*\) cat ~\/bench\/human-steps.jsonl.*/read-steps/' \
    -e 's/^curl POST [^ ]* \/tasks .*"title":"([^"]*)".*/register \1/' \
    -e 's/^vm\([^)]*\) .*current-root .* ([^ ]*)$/current-root \1/' \
    -e 's/^curl GET [^ ]* \/tasks\/([^/ ]*)\/events.*/events \1/' \
    -e 's/^curl GET [^ ]* \/tasks\/([^/ ]*) *$/status \1/' \
    -e 's/^curl GET [^ ]* \/tasks *$/board-tasks/' \
    -e 's/^vm\([^)]*\) .*export EXERCISE_DIR.*/expected-test/' \
    -e 's/^curl GET [^ ]* \/settings\/execution.*/read-table/' \
    -e 's/^limactl copy .* tidepool-bench:bench\/input.json$/copy-input/' \
    -e 's/^vm\([^)]*\) .*extract.ts run .*/extract/' \
    -e 's/^limactl copy -r tidepool-bench:bench\/results\/.*/copy-results/' \
    -e 's/^curl POST [^ ]* \/pause .*"paused":false.*/unpause/' \
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

# The steps before the first line matching $1 (an extended regex over the step names).
steps_before() { steps | awk -v stop="$1" '$0 ~ stop { exit } { print }'; }

input_json() { jq -c "${1:-.}" "$CASE_DIR/bench/input.json"; }

# --- a new run ------------------------------------------------------------------
# The Interview is declared first and waits one poll; the work exercise is registered only after it settled.

reset_case
printf 'interview\n' > "$CASE_DIR/state/type/root1"
printf 'todo\ndone\n' > "$CASE_DIR/state/status/root1"
# An earlier run today under the same label left a session file the new record does not name
mkdir -p "$CASE_DIR/results/$(date +%Y-%m-%d)-run/sessions" && touch "$CASE_DIR/results/$(date +%Y-%m-%d)-run/sessions/stale.md"
run_harness
check "new run: exits 0" "0" "$rc"
check "new run: runs the whole sequence in order (CLI pins after the checkout move, the exercises in declared order, the next registered only after the previous settled)" "gate-vm-status
vm-status
claude-login
git-identity
reset
env-file
checkout
read-commit
cli-pins
trust
copy a-interview
copy b-work
copy-sequence
check
registry-seed
workspace b-work
registry-workspaces
save-state
linger
token
board-start
board-ready
display-language
spend-down
position
register Interview the standard tier
current-root root1
status root1
board-tasks
spend-down
sleep
current-root root1
status root1
current-root root1
register Fix it
current-root root2
status root2
events root2
current-root root2
expected-test
read-table
read-steps
copy-input
extract
copy-results
pause
board-stop" "$(steps)"
check "new run: every limactl call names the benchmark instance, except the two reads of the gate VM" "tidepool-board" \
  "$(instances | grep -vx tidepool-bench | sort -u)"
check "new run: the gate VM is only read (its status and its board unit), never changed" "limactl list --format {{.Status}} tidepool-board" \
  "$(grep 'tidepool-board' <<< "$log" | grep -v '^vm(tidepool-board) systemctl --user is-active')"
check "new run: every API call goes to the benchmark board's port, not the gate board's 4589" "http://127.0.0.1:4700" \
  "$(sed -nE 's/^curl [A-Z]+ ([^ ]*) .*/\1/p' <<< "$log" | sort -u)"
check "new run: nothing runs on the Mac that belongs in the VM (git, npm, node) and nothing is timed out" "" \
  "$(grep -E '^(git|npm|node|npx|brew|timeout) ' <<< "$log" || true)"
check "new run: the board's state lives under ~/bench, on a port other than the gate board's" "export TIDEPOOL_REGISTRY=\$HOME/bench/registry TIDEPOOL_DB=\$HOME/bench/board.sqlite TIDEPOOL_WORKER_LOGS=\$HOME/bench/worker-logs
export TIDEPOOL_WORKSPACES_DIR=\$HOME/bench/workspaces TIDEPOOL_API_TOKEN_FILE=\$HOME/bench/api-token
export PORT=4700 MCP_PORT=4701 PATH=\$HOME/.local/bin:\$PATH" "$(cat "$CASE_DIR/stdin.env")"
check "new run: one registry workspace per exercise that names one" "bws:
  review_allowed_commands:
    - \"node --test\"" "$(cat "$CASE_DIR/stdin.workspaces.yaml")"
check "new run: what a resume needs and the board does not hold is saved under ~/bench" \
  '{"tidepool_commit":"tidepoolsha","cli_pins":{"claude":"2.1.289","codex":"0.147.0"},"registry_commit":"template@tidepoolsha","label":"run"}' \
  "$(jq -c . "$CASE_DIR/bench/state.json")"
check "new run: the sequence is copied next to its exercises" "$(cat "$CASE_DIR/run.json")" "$(cat "$CASE_DIR/bench/run.json")"
check "new run: the extraction gets the configuration, the root ids and test exits in sequence order, and the human steps" \
  '{"config":{"tidepool_commit":"tidepoolsha","cli_pins":{"claude":"2.1.289","codex":"0.147.0"},"table_rows":[{"provider":"anthropic","tier":"standard","model":"claude-opus-5-5","effort":"high","price_in":5,"price_out":25}],"registry_commit":"template@tidepoolsha"},"exercises":[{"dir":"exercises/a-interview","task_id":"root1","test_exit":null},{"dir":"exercises/b-work","task_id":"root2","test_exit":0}],"human_steps":[]}' \
  "$(input_json)"
check "new run: nothing deletes the run's state after the extraction" "" \
  "$(sed -n '/extract.ts run/,$p' <<< "$log" | grep -E 'rm -rf|reset-failed' || true)"
check "new run: the record lands in results/<date>-<label> and its path is printed" "1" \
  "$(grep -c "Run record: $CASE_DIR/results/$(date +%Y-%m-%d)-run" <<< "$output")"
check "new run: the whole results directory reaches the host, session files included and the last same-label run's gone" "./record.json ./sessions/root1.1.md ./summary.md" \
  "$(cd "$CASE_DIR/results/$(date +%Y-%m-%d)-run" && find . -type f | sort | xargs)"
check "new run: prints where to open the WebUI" "1" "$(grep -c 'http://127.0.0.1:4700/auth?token=TKN' <<< "$output")"

# period_days from the sequence is set before the first registration.
reset_case
echo '{"period_days": 1, "items": [{"exercise": "b-work"}]}' > "$CASE_DIR/run.json"
run_harness
check "period_days: posted to the board's meta-review settings before anything is registered" "0 period-days" \
  "$rc $(steps_before '^register' | grep -x period-days)"
check "period_days: the post carries the declared value" '1' \
  "$(grep -c 'curl POST http://127.0.0.1:4700 /settings/meta-review {"period_days":1}' <<< "$log")"

reset_case
run_harness
check "no period_days: the board's period is left alone" "" "$(steps | grep -x period-days || true)"

# --- the gate board ------------------------------------------------------------

reset_case
GATE_STATUS=Running
GATE_ACTIVE=1
run_harness
check "gate running: exits non-zero" "1" "$rc"
check "gate running: says how to stop it" "1" "$(grep -c 'systemctl --user stop tidepool-board$' <<< "$output")"
check "gate running: no call reaches the benchmark VM" "gate-vm-status
gate-board-unit" "$(steps)"

reset_case
GATE_STATUS=Running
GATE_ACTIVE=0
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

# Two work exercises: the second is registered only once the first has landed, two polls in.
reset_case
sequence '{"exercise": "b-work"}, {"exercise": "c-work"}'
printf 'todo\ntodo\nlanded\n' > "$CASE_DIR/state/status/root1"
run_harness
check "serial: exits 0" "0" "$rc"
check "serial: the second exercise is registered after the first root landed, not before" "2 1" \
  "$(steps_before '^register Fix more$' | grep -c '^sleep$') $(steps | grep -c '^register Fix more$')"

reset_case
sequence '{"exercise": "b-work"}'
printf 'todo\ntodo\ndone\ndone\nlanded\n' > "$CASE_DIR/state/status/root1"
run_harness
check "landing: exits 0" "0" "$rc"
check "landing: polls until the root has landed" "4" "$(grep -c '^sleep' <<< "$log")"
check "landing: no expected test or extraction before the last poll" "" \
  "$(steps | awk '/^sleep$/ { last = NR } { line[NR] = $0 } END { for (i = 1; i < last; i++) print line[i] }' | grep -E '^(expected-test|extract)$' || true)"
check "landing: a root done but not yet landed keeps the run waiting (read on polls 3, 4 and 5)" "3" \
  "$(grep -c 'curl GET http://127.0.0.1:4700 /tasks/root1/events' <<< "$log")"

# A held land question settles the root too: the human declined to land, and the tests then read main as it is.
reset_case
sequence '{"exercise": "b-work"}'
printf 'held\n' > "$CASE_DIR/state/status/root1"
TEST_EXIT=1
run_harness
check "held land question: the run settles and records the failing test" "0 1" "$rc $(input_json '.exercises[0].test_exit')"

# The human retries the Interview root mid-wait: the old root reads cancelled, current-root names the new one.
reset_case
sequence '{"exercise": "a-interview"}'
printf 'interview\n' > "$CASE_DIR/state/type/root1"
printf 'todo\ncancelled\n' > "$CASE_DIR/state/status/root1"
printf 'root1\nroot9\n' > "$CASE_DIR/state/root/root1"
printf 'interview\n' > "$CASE_DIR/state/type/root9"
printf 'todo\ntodo\ntodo\ndone\n' > "$CASE_DIR/state/status/root9"
run_harness
check "Interview retry: exits 0" "0" "$rc"
check "Interview retry: keeps waiting on the new root, not the cancelled old one" "3" "$(grep -c '^sleep' <<< "$log")"
check "Interview retry: the old root is not read again once the retry is seen" "1" "$(grep -c 'curl GET http://127.0.0.1:4700 /tasks/root1 *$' <<< "$log")"
check "Interview retry: the extraction gets the new root's id" '"root9"' "$(input_json '.exercises[0].task_id')"

# Hours of waiting meet transient failures: spend-down refused after a window reset, a current-root read that fails.
reset_case
sequence '{"exercise": "b-work"}'
printf 'todo\ntodo\nlanded\n' > "$CASE_DIR/state/status/root1"
printf 'FAIL\nroot1\n' > "$CASE_DIR/state/root/root1"
printf 'ok\nrefuse\nok\n' > "$CASE_DIR/state/spend-down"
run_harness
check "transient failures in the wait: the run still settles and extracts" '0 "root1"' "$rc $(input_json '.exercises[0].task_id')"
check "transient failures in the wait: the open questions are listed once" "1" "$(grep -c 'land completed task: Fix it' <<< "$output")"

# The retry lands between the two reads of one poll: current-root still names the old root, which then reads
# cancelled. The cancelled root must not count as settled while the re-read names its successor.
reset_case
sequence '{"exercise": "a-interview"}'
printf 'interview\n' > "$CASE_DIR/state/type/root1"
printf 'todo\ncancelled\n' > "$CASE_DIR/state/status/root1"
printf 'root1\nroot1\nroot9\n' > "$CASE_DIR/state/root/root1"
printf 'interview\n' > "$CASE_DIR/state/type/root9"
printf 'done\n' > "$CASE_DIR/state/status/root9"
run_harness
check "retry between the reads: exits 0" "0" "$rc"
check "retry between the reads: the cancelled old root does not end the wait" "2" "$(grep -c '^sleep' <<< "$log")"
check "retry between the reads: the extraction gets the new root's id" '"root9"' "$(input_json '.exercises[0].task_id')"

# The first spend-down, while the board is configured, is refused: the run goes on to register its exercises.
reset_case
sequence '{"exercise": "b-work"}'
printf 'refuse\nok\n' > "$CASE_DIR/state/spend-down"
run_harness
check "spend-down refused at configuration: the run registers and completes" "0 1" "$rc $(grep -c '^curl POST [^ ]* /tasks ' <<< "$log")"

# A step after the board started fails: the board is paused and stopped, and its state stays.
reset_case
sequence '{"exercise": "b-work"}'
touch "$CASE_DIR/state/register-fails"
run_harness
check "failing register: exits non-zero" "1" "$((rc != 0))"
check "failing register: the board is still paused and stopped" "pause
board-stop" "$(steps | tail -2)"
check "failing register: nothing deletes the state once the board is up" "" \
  "$(sed -n '/systemd-run/,$p' <<< "$log" | grep -E 'rm -rf|reset-failed' || true)"

# An Interview that targets openai needs the Codex login, checked before anything is reset.
reset_case
CODEX_LOGGED_IN=0
sed -i '' 's/"provider": "anthropic"/"provider": "openai"/' "$EXERCISES/a-interview/exercise.json"
run_harness
check "Interview targets openai without a Codex login: stops before the reset" "1 codex-login" "$((rc != 0)) $(steps | tail -1)"

# A given registry is recorded by the commit of its ref, not by the commit the harness adds on top.
reset_case
sequence '{"exercise": "b-work"}'
ARGS="--new --registry https://example.com/registry.git#v1"
run_harness
check "given registry: the record names its ref's commit" '0 "givensha"' "$rc $(input_json .config.registry_commit)"

# --- human steps ------------------------------------------------------------------

# (a) The first memory meta-review: the human is prompted, and the next exercise waits for the review the human
# started and everything under it to settle.
reset_case
sequence '{"exercise": "b-work"}, {"human": "first_meta_review", "subject": "memory"}, {"exercise": "c-work"}'
printf '%s\n' '{"root":null,"settled":false}' '{"root":"mr1","settled":false}' '{"root":"mr1","settled":true}' > "$CASE_DIR/state/first-meta-review"
run_harness
check "first meta-review: exits 0" "0" "$rc"
check "first meta-review: prompts the human with the subject and the door" "1" "$(grep -c "press 'Start first memory meta-review'" <<< "$output")"
check "first meta-review: the next exercise is registered only after the review and everything under it settled" \
  "register Fix it
current-root root1
status root1
events root1
current-root root1
meta-review-status
first-meta-review
sleep
board-tasks
spend-down
first-meta-review
sleep
board-tasks
spend-down
first-meta-review
record-step
register Fix more" "$(steps | sed -n '/^register Fix it$/,/^register Fix more$/p')"
check "first meta-review: the step is recorded as done, waiting on the review's root" \
  '{"item":1,"human":"first_meta_review","subject":"memory","outcome":"done","waited_on":"mr1"}' \
  "$(input_json '.human_steps[0] | del(.prompted_at, .finished_at)')"

# (a) with the door closed: no material for routing yet, so the step is recorded and passed without waiting.
reset_case
sequence '{"exercise": "b-work"}, {"human": "first_meta_review", "subject": "routing"}, {"exercise": "c-work"}'
echo '{"memory":{"first_review":"not_started","material":3,"first_material_at":"x"},"routing":{"first_review":"not_started","material":0,"first_material_at":null}}' > "$CASE_DIR/state/meta-review-status"
run_harness
check "closed door: exits 0 without prompting or waiting" "0 0 0" \
  "$rc $(grep -c 'Start first' <<< "$output" || true) $(grep -c '^sleep' <<< "$log" || true)"
check "closed door: recorded apart from a human skip" '{"item":1,"human":"first_meta_review","subject":"routing","outcome":"door_closed","waited_on":null}' \
  "$(input_json '.human_steps[0] | del(.prompted_at, .finished_at)')"

# (b) Free text: the run waits for the human's done, then for the board to have no unsettled task.
reset_case
sequence '{"exercise": "b-work"}, {"human": "step", "instructions": "Object to the write row of the memory meta-review"}, {"exercise": "c-work"}'
printf 'not yet\ndone\n' > "$CASE_DIR/stdin"
printf '%s\n' '[{"id":"r1","type":"work","status":"in_progress","title":"repair: x"}]' '[{"id":"r1","type":"work","status":"done","title":"repair: x"}]' > "$CASE_DIR/state/board"
run_harness
check "free-text step: exits 0" "0" "$rc"
check "free-text step: prints the instructions" "1" "$(grep -c 'Object to the write row of the memory meta-review' <<< "$output")"
check "free-text step: after done, the next exercise waits for the board's open task to settle" "1 1" \
  "$(steps_before '^register Fix more$' | grep -c '^sleep$') $(steps | grep -c '^register Fix more$')"
check "free-text step: recorded as done, having waited on the board" '{"item":1,"human":"step","outcome":"done","waited_on":"board"}' \
  "$(input_json '.human_steps[0] | del(.prompted_at, .finished_at)')"

# The control run: the human types skip at both human steps, and the run flows to the end with the skips recorded.
reset_case
sequence '{"exercise": "b-work"}, {"human": "first_meta_review", "subject": "memory"}, {"human": "step", "instructions": "Object to it"}, {"exercise": "c-work"}'
printf 'skip\nskip\n' > "$CASE_DIR/stdin"
ARGS="--new --label control"
run_harness
check "control run: exits 0 and extracts" "0 1" "$rc $(steps | grep -c '^extract$')"
check "control run: both human steps recorded as the human's skip, waiting on nothing" \
  '[{"item":1,"human":"first_meta_review","subject":"memory","outcome":"human_skip","waited_on":null},{"item":2,"human":"step","outcome":"human_skip","waited_on":null}]' \
  "$(input_json '.human_steps | map(del(.prompted_at, .finished_at))')"
check "control run: no poll was waited out" "0" "$(grep -c '^sleep' <<< "$log" || true)"
check "control run: the record lands under its label" "1" "$(grep -c "Run record: $CASE_DIR/results/$(date +%Y-%m-%d)-control" <<< "$output")"

# --- resume -----------------------------------------------------------------------
# The VM holds a run that stopped in the middle: the first exercise registered (as root7) and settled, the free-text
# step done, the first meta-review started by the human but not settled, the last exercise not registered.

reset_case
sequence '{"exercise": "b-work"}, {"human": "step", "instructions": "Object to it"}, {"human": "first_meta_review", "subject": "memory"}, {"exercise": "c-work"}'
mkdir -p "$CASE_DIR/bench"
cp -R "$EXERCISES" "$CASE_DIR/run.json" "$CASE_DIR/bench/"
echo '{"tidepool_commit":"oldsha","cli_pins":{"claude":"2.1.289","codex":"0.147.0"},"registry_commit":"template@oldsha","label":"week1"}' > "$CASE_DIR/bench/state.json"
echo '{"item":1,"human":"step","outcome":"done","prompted_at":"2026-10-21T00:00:00Z","finished_at":"2026-10-21T01:00:00Z","waited_on":"board"}' > "$CASE_DIR/bench/human-steps.jsonl"
echo '[{"root":"root7","outcome":null},{"root":null,"outcome":"done"},{"root":"mr1","outcome":null},{"root":null,"outcome":null}]' > "$CASE_DIR/state/position"
printf '%s\n' '{"root":"mr1","settled":false}' '{"root":"mr1","settled":true}' > "$CASE_DIR/state/first-meta-review"
ARGS=""
run_harness
check "resume: exits 0" "0" "$rc"
check "resume: restarts the board without resetting, checking out, seeding or configuring it, unpauses it, and continues from the first unprocessed item" "gate-vm-status
vm-status
has-state
read-state
copy-back
claude-login
git-identity
linger
token
board-start
board-ready
unpause
position
current-root root7
status root7
events root7
current-root root7
first-meta-review
sleep
board-tasks
spend-down
first-meta-review
record-step
register Fix more
current-root root1
status root1
events root1
current-root root1
expected-test
read-table
read-steps
copy-input
extract
copy-results
pause
board-stop" "$(steps)"
check "resume: neither the done step nor the started meta-review is prompted again" "0" \
  "$(grep -cE 'Object to it|Start first' <<< "$output" || true)"
check "resume: nothing is deleted" "" "$(grep -E 'rm -rf|reset-failed' <<< "$log" || true)"
check "resume: the extraction gets the run's own configuration and every exercise and human step" \
  '{"commit":"oldsha","tasks":["root7","root1"],"steps":[1,2]}' \
  "$(input_json '{commit: .config.tidepool_commit, tasks: [.exercises[].task_id], steps: [.human_steps[].item]}')"
check "resume: the record lands under the run's label" "1" "$(grep -c "Run record: $CASE_DIR/results/$(date +%Y-%m-%d)-week1" <<< "$output")"

# No run in the VM: a resume stops and says how to start one, and nothing is created or reset.
reset_case
ARGS=""
run_harness
check "resume without a run: exits non-zero and says to pass --new" "1 1" "$((rc != 0)) $(grep -c -- '--new' <<< "$output")"
check "resume without a run: stops at the check" "gate-vm-status
vm-status
has-state" "$(steps)"

# A configuration option without --new would be ignored by a resume: refused before anything is touched.
reset_case
ARGS="--label control"
run_harness
check "configuration without --new: refused before any call" "1 1 " "$((rc != 0)) $(grep -c 'add --new' <<< "$output") $(steps)"

# --- summary ----------------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
