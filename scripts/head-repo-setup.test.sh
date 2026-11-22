#!/usr/bin/env bash
# Tests for scripts/head-repo-setup.sh (issue #3564). Same shape as scripts/mac-install.test.sh: stubs record every
# external command, each case runs the script in a fresh `bash -c` subprocess so its `set -e` is real, and the
# summary is PASS/FAIL counts. PATH inside each case is the stub dir plus /usr/bin:/bin, so no real `gh` or `curl`
# is ever reached. `node` (the script's JSON reader) is the real one, linked into the stub dir; `git` is the real
# one, reading a checkout the case builds.
#
# Pinned here: each stage's idempotence (a done stage changes nothing on a re-run, an interrupted run resumes),
# the stop conditions and the warnings. The real GitHub calls are exercised by the real-environment run (#3564).
#
# Run: bash scripts/head-repo-setup.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
NODE="$(command -v node)"

PASS=0
FAIL=0

assert_eq() {
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

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS=$((PASS + 1))
    echo "ok - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "not ok - $desc (expected output to contain [$needle])"
    echo "  --- actual ---"
    echo "$haystack" | sed 's/^/  /'
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    PASS=$((PASS + 1))
    echo "ok - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "not ok - $desc (expected output NOT to contain [$needle])"
    echo "  --- actual ---"
    echo "$haystack" | sed 's/^/  /'
  fi
}

# --- stubs -----------------------------------------------------------------
# Every stub appends its invocation to $CMD_LOG. State that a stage changes across one run (an organization created
# while the script waits, a setting fixed while it waits) flips after the first read, counted in a file. State the
# script also names (BASE_OWNER, OWNER_TYPE …) reaches the stubs as S_*: the script assigns its own, and an
# assignment to an inherited variable is exported to the stubs.

write_stubs() {
  cat > "$STUB_DIR/gh" << 'STUB'
#!/bin/bash
args="$*"
if [[ "$args" == *"--input -"* ]]; then args="$args <<< $(cat)"; fi
echo "gh $args" >> "$CMD_LOG"
runners() { if [[ "$1" == unreadable ]]; then echo "gh: Must have admin rights to Repository. (HTTP 403)" >&2; exit 1; fi; echo "$1"; }
count() { local n; n=$(($(cat "$CASE_DIR/$1" 2> /dev/null || echo 0) + 1)); echo "$n" > "$CASE_DIR/$1"; echo "$n"; }
case "$*" in
  "api repos/acme/widget --jq"*) printf '%s\n' "$S_BASE_OWNER" "$S_BASE_OWNER_TYPE" "$S_BASE_PRIVATE" ;;
  "api user --jq .login") echo "me" ;;
  "api users/"*)
    if [[ -z "$S_OWNER_TYPE" ]] || { [[ "$OWNER_APPEARS" == 1 ]] && [[ "$(count owner)" == 1 ]]; }; then
      echo "gh: Not Found (HTTP 404)" >&2; exit 1
    fi
    echo "$S_OWNER_TYPE" ;;
  "api repos/acme/widget/forks --paginate"*) [[ -z "$EXISTING_FORK" ]] || echo "$EXISTING_FORK" ;;
  "api -X POST repos/acme/widget/forks"*)
    if [[ -n "$FORK_ERROR" ]]; then echo "$FORK_ERROR" >&2; exit 1; fi
    echo "$FORK_CREATED" ;;
  "api repos/"*"/actions/permissions --jq .enabled") echo "$ACTIONS_ENABLED" ;;
  "api -X PUT repos/"*"/actions/permissions --input -") : ;;
  "api repos/acme/widget/actions/permissions/fork-pr-workflows-private-repos"*)
    if [[ "$SETTINGS_FIXED_AFTER_WAIT" == 1 ]] && [[ "$(count settings)" -gt 1 ]]; then echo "true false false"; else echo "$FORK_PR_SETTINGS"; fi ;;
  "api repos/acme/widget/contents/.github/workflows?ref=$S_BRANCH --jq"*)
    if [[ -z "$WORKFLOWS" ]]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    for f in $WORKFLOWS; do echo ".github/workflows/$f"; done ;;
  "api repos/acme/widget/contents/.github/workflows/"*"?ref=$S_BRANCH -H"*)
    f="${2##*/}"; f="${f%%\?*}"; printf '%s\n' "$(eval "echo \"\$WF_${f%%.*}\"")" ;;
  "api repos/acme/widget/actions/runners --jq .total_count") runners "$S_REPO_RUNNERS" ;;
  "api orgs/acme/actions/runners --jq .total_count") runners "$S_ORG_RUNNERS" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
STUB

  # The board. The secret arrives as curl config on stdin; it is kept out of $CMD_LOG and written to its own file.
  cat > "$STUB_DIR/curl" << 'STUB'
#!/bin/bash
cat > "$CASE_DIR/curl-config"
method="" data="" url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X) method="$2"; shift ;;
    --data) data="$2"; shift ;;
    -H | -w | -K) shift ;;
    -*) : ;;
    *) url="$1" ;;
  esac
  shift
done
echo "curl $method ${url#http://127.0.0.1:}${data:+ $data}" >> "$CMD_LOG"
if [[ "$method" == GET ]]; then
  printf '%s\n200' "$WORKSPACES_JSON"
  exit 0
fi
n=$(($(cat "$CASE_DIR/patch" 2> /dev/null || echo 0) + 1))
echo "$n" > "$CASE_DIR/patch"
case "$(echo "$PATCH_ANSWERS" | cut -d' ' -f"$n")" in
  409) printf '%s\n409' '{"error":"These changes need confirmation: head_repo_set","confirm_required":true,"dangerous_values":["head_repo_set"]}' ;;
  200) printf '{}\n200' ;;
  502) printf '%s\n502' '{"error":"The head repo reef/widget of workspace trial was saved, but these task branches were not sent to it: task/abc (rejected)","saved":true}' ;;
  400) printf '%s\n400' '{"error":"head repo reef/widget must be a fork of acme/widget."}' ;;
esac
STUB
}

# --- case setup ------------------------------------------------------------

CASE_N=0
reset_case() {
  CASE_N=$((CASE_N + 1))
  CASE_DIR="$WORK_DIR/case$CASE_N"
  STUB_DIR="$CASE_DIR/bin"
  CMD_LOG="$CASE_DIR/cmd.log"
  mkdir -p "$STUB_DIR"
  : > "$CMD_LOG"
  ln -s "$NODE" "$STUB_DIR/node"

  ARGS="trial reef"
  INPUT=""
  TOKEN_ENV="TIDEPOOL_API_TOKEN=s3cret-board-token"
  BASE_OWNER="acme"
  BASE_OWNER_TYPE="User"
  BASE_PRIVATE="true"
  OWNER_TYPE="Organization"
  OWNER_APPEARS=0
  EXISTING_FORK=""
  FORK_CREATED="reef/widget"
  FORK_ERROR=""
  ACTIONS_ENABLED="true"
  FORK_PR_SETTINGS="true false false"
  SETTINGS_FIXED_AFTER_WAIT=0
  WORKFLOWS=""
  BRANCH=""
  REPO_RUNNERS=0
  ORG_RUNNERS=0
  DECLARED=""
  CHECKOUT=""
  PATCH_ANSWERS="409 200"
}

# A board checkout whose task branches are (or are not) copied under refs/remotes/head-repo/ —
# the copies the board writes only for task branches it sent to the head repo.
make_checkout() {
  CHECKOUT="$CASE_DIR/checkout"
  git init -q -b main "$CHECKOUT"
  git -C "$CHECKOUT" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
  git -C "$CHECKOUT" branch task/abc
  if [[ "$1" == sent ]]; then git -C "$CHECKOUT" update-ref refs/remotes/head-repo/task/abc task/abc; fi
}

run_setup() {
  write_stubs
  chmod +x "$STUB_DIR"/gh "$STUB_DIR"/curl
  local workspaces
  workspaces="{\"workspaces\":[{\"name\":\"other\",\"repo\":\"https://github.com/acme/other.git\"},{\"name\":\"trial\",\"repo\":\"https://github.com/acme/widget.git\",\"protected\":false${BRANCH:+,\"branch\":\"$BRANCH\"}${DECLARED:+,\"head_repo\":\"$DECLARED\"}${CHECKOUT:+,\"path\":\"$CHECKOUT\"}}],\"workspacesBaseDir\":{\"path\":\"/x\",\"source\":\"default\"}}"
  output=$(printf '%b' "$INPUT" | env -i \
    PATH="$STUB_DIR:/usr/bin:/bin" HOME="$CASE_DIR" CASE_DIR="$CASE_DIR" CMD_LOG="$CMD_LOG" SCRIPT_DIR="$SCRIPT_DIR" \
    S_BASE_OWNER="$BASE_OWNER" S_BASE_OWNER_TYPE="$BASE_OWNER_TYPE" S_BASE_PRIVATE="$BASE_PRIVATE" \
    S_OWNER_TYPE="$OWNER_TYPE" OWNER_APPEARS="$OWNER_APPEARS" EXISTING_FORK="$EXISTING_FORK" \
    FORK_CREATED="$FORK_CREATED" FORK_ERROR="$FORK_ERROR" ACTIONS_ENABLED="$ACTIONS_ENABLED" \
    FORK_PR_SETTINGS="$FORK_PR_SETTINGS" SETTINGS_FIXED_AFTER_WAIT="$SETTINGS_FIXED_AFTER_WAIT" \
    WORKFLOWS="$WORKFLOWS" S_BRANCH="${BRANCH:-main}" S_REPO_RUNNERS="$REPO_RUNNERS" S_ORG_RUNNERS="$ORG_RUNNERS" WF_target="on: pull_request_target" WF_after="on:
  workflow_run:" WF_runner="runs-on: self-hosted" WF_plain="on: pull_request" \
    WORKSPACES_JSON="$workspaces" PATCH_ANSWERS="$PATCH_ANSWERS" ${TOKEN_ENV} \
    bash -c "set -euo pipefail; source \"\$SCRIPT_DIR/head-repo-setup.sh\"; main $ARGS" 2>&1) && rc=0 || rc=$?
  log="$(cat "$CMD_LOG")"
}

# --- fresh: every stage acts ------------------------------------------------
# The whole order pinned as one log: org check, fork, Actions off, private settings read, workflows read,
# declaration answered with a confirmation.

reset_case
OWNER_APPEARS=1
INPUT='\n\ny\n'
run_setup
assert_eq "fresh: exits 0" "0" "$rc"
assert_eq "fresh: runs every stage in order" "curl GET 4589/api/workspaces
gh api repos/acme/widget --jq .owner.login, .owner.type, .private
gh api user --jq .login
gh api users/reef --jq .type
gh api users/reef --jq .type
gh api repos/acme/widget/forks --paginate --jq .[] | select(.owner.login | ascii_downcase == \"reef\") | .full_name
gh api -X POST repos/acme/widget/forks -f organization=reef --jq .full_name
gh api repos/reef/widget/actions/permissions --jq .enabled
gh api -X PUT repos/reef/widget/actions/permissions --input - <<< {\"enabled\":false}
gh api repos/acme/widget/actions/permissions/fork-pr-workflows-private-repos --jq [.run_workflows_from_fork_pull_requests, .send_write_tokens_to_workflows, .send_secrets_and_variables] | map(tostring) | join(\" \")
gh api repos/acme/widget/contents/.github/workflows?ref=main --jq .[].path
gh api repos/acme/widget/actions/runners --jq .total_count
curl PATCH 4589/api/workspaces/trial {\"head_repo\":\"reef/widget\"}
curl PATCH 4589/api/workspaces/trial {\"head_repo\":\"reef/widget\",\"confirm\":true}" "$log"
assert_contains "fresh: opens the organization creation page" "https://github.com/account/organizations/new" "$output"
assert_contains "fresh: recommends an organization only for head repos" "an organization's secrets can reach the workflows of a fork it owns" "$output"
assert_contains "fresh: opens the App installation page for the organization" "https://github.com/apps/tidepool-board/installations/new, choose reef" "$output"
assert_contains "fresh: shows the board's reasons before confirming" "head_repo_set" "$output"
assert_contains "fresh: reports the task branches sent" "the board sent its task branches there" "$output"
assert_not_contains "fresh: the board secret never reaches a command line" "s3cret-board-token" "$log"
assert_contains "fresh: the board secret reaches curl as config" "Authorization: Bearer s3cret-board-token" "$(cat "$CASE_DIR/curl-config")"

# GitHub renames a fork whose name is taken: the declaration carries the name GitHub answered (story 7).
reset_case
FORK_CREATED="reef/widget-1"
INPUT='\ny\n'
run_setup
assert_eq "renamed fork: exits 0" "0" "$rc"
assert_contains "renamed fork: Actions are disabled on the renamed fork" "gh api -X PUT repos/reef/widget-1/actions/permissions" "$log"
assert_contains "renamed fork: declares the renamed fork" '{"head_repo":"reef/widget-1","confirm":true}' "$log"

# Without TIDEPOOL_API_TOKEN the secret is typed in.
reset_case
TOKEN_ENV=""
INPUT='typed-secret\n\ny\n'
run_setup
assert_eq "typed token: exits 0" "0" "$rc"
assert_contains "typed token: asks for the board token" "Board token" "$output"
assert_contains "typed token: the typed secret reaches curl as config" "Authorization: Bearer typed-secret" "$(cat "$CASE_DIR/curl-config")"
assert_not_contains "typed token: the typed secret never reaches a command line" "typed-secret" "$log"

# --- re-run on a finished setup ---------------------------------------------

reset_case
EXISTING_FORK="Reef/Widget"
DECLARED="reef/widget"
ACTIONS_ENABLED="false"
make_checkout sent
run_setup
assert_eq "re-run: exits 0" "0" "$rc"
for mutating in "-X POST" "-X PUT" "curl PATCH"; do
  assert_not_contains "re-run: does not run [$mutating]" "$mutating" "$log"
done
assert_not_contains "re-run: does not wait for the App installation" "installations/new" "$output"
assert_not_contains "re-run: does not wait for the organization" "organizations/new" "$output"
assert_not_contains "re-run: does not ask anything" "Press Enter" "$output"
assert_contains "re-run: reports the head repo as declared" "every task branch is on it" "$output"

# --- resume after an interruption -------------------------------------------

# Stopped after the fork: the fork is found, not made again, and the rest runs.
reset_case
EXISTING_FORK="reef/widget"
INPUT='\ny\n'
run_setup
assert_eq "resume after fork: exits 0" "0" "$rc"
assert_not_contains "resume after fork: does not fork again" "-X POST" "$log"
assert_contains "resume after fork: disables Actions" "gh api -X PUT repos/reef/widget/actions/permissions" "$log"
assert_contains "resume after fork: declares" '{"head_repo":"reef/widget","confirm":true}' "$log"

# Stopped at a 502: the declaration is saved, but a task branch was not sent — the copy is missing, so the
# re-run declares the same value again (the board's resend is idempotent).
reset_case
EXISTING_FORK="reef/widget"
DECLARED="reef/widget"
ACTIONS_ENABLED="false"
make_checkout unsent
INPUT='y\n'
run_setup
assert_eq "resume unsent: exits 0" "0" "$rc"
assert_contains "resume unsent: declares the same value again" '{"head_repo":"reef/widget","confirm":true}' "$log"
assert_not_contains "resume unsent: does not wait for the App installation again" "installations/new" "$output"

reset_case
EXISTING_FORK="reef/widget"
DECLARED="reef/widget"
ACTIONS_ENABLED="false"
make_checkout unsent
INPUT='n\n'
run_setup
assert_eq "resume unsent, declined: exits non-zero" "1" "$rc"
assert_contains "resume unsent, declined: says the declaration stays and what was not sent" "reef/widget stays the declared head repo, but the task branches it lacks were not sent" "$output"

# A 502 with saved:true in the same run: the human fixes the cause and the same value is sent again, confirmed.
reset_case
PATCH_ANSWERS="409 502 200"
INPUT='\ny\n\n'
run_setup
assert_eq "502 saved: exits 0" "0" "$rc"
assert_contains "502 saved: shows which task branches were not sent" "task/abc (rejected)" "$output"
assert_eq "502 saved: resends the confirmed value" '2' "$(grep -c '"confirm":true' <<< "$log")"

# The private settings are wrong: guided, waited for, read again.
reset_case
FORK_PR_SETTINGS="true true false"
SETTINGS_FIXED_AFTER_WAIT=1
BASE_OWNER_TYPE="Organization"
INPUT='\n\ny\n'
run_setup
assert_eq "private settings: exits 0" "0" "$rc"
assert_contains "private settings: names the repository page" "https://github.com/acme/widget/settings/actions" "$output"
assert_contains "private settings: keeps write tokens off" 'keep OFF "Send write tokens to workflows from fork pull requests"' "$output"
assert_contains "private settings: an organization's base needs the organization's policy first" "https://github.com/organizations/acme/settings/actions" "$output"
assert_contains "private settings: names the organization policy refusal" "Policy is forbidden by entity owner" "$output"
assert_eq "private settings: reads the settings again after the wait" "2" "$(grep -c 'fork-pr-workflows-private-repos' <<< "$log")"
assert_not_contains "private settings: never writes them" "-X PUT repos/acme/widget" "$log"

reset_case
BASE_PRIVATE="false"
INPUT='\ny\n'
run_setup
assert_eq "public base: exits 0" "0" "$rc"
assert_not_contains "public base: does not read the fork PR settings" "fork-pr-workflows-private-repos" "$log"

# --- warnings ---------------------------------------------------------------

reset_case
WORKFLOWS="target.yml after.yml runner.yml plain.yml"
INPUT='\ny\n'
run_setup
assert_eq "warnings: do not stop the run" "0" "$rc"
assert_contains "warnings: pull_request_target" ".github/workflows/target.yml uses pull_request_target" "$output"
assert_contains "warnings: workflow_run" ".github/workflows/after.yml uses workflow_run" "$output"
assert_contains "warnings: self-hosted runner" ".github/workflows/runner.yml uses a self-hosted runner" "$output"
assert_not_contains "warnings: a plain workflow is not warned about" "plain.yml uses" "$output"
assert_contains "warnings: the declaration still runs" "curl PATCH" "$log"

# The workflows are read on the workspace's protected branch, not the repository's default branch.
reset_case
BRANCH="trunk"
WORKFLOWS="target.yml"
INPUT='\ny\n'
run_setup
assert_eq "workspace branch: exits 0" "0" "$rc"
assert_contains "workspace branch: lists the workflows on it" "contents/.github/workflows?ref=trunk" "$log"
assert_contains "workspace branch: reads each workflow on it" "contents/.github/workflows/target.yml?ref=trunk" "$log"

# Registered runners: a custom label or a runner group does not say self-hosted in the workflow.
reset_case
BASE_OWNER_TYPE="Organization"
REPO_RUNNERS=2
ORG_RUNNERS=unreadable
INPUT='\ny\n'
run_setup
assert_eq "runners: warnings do not stop the run" "0" "$rc"
assert_contains "runners: warns about the repository's registered runners" "acme/widget has 2 self-hosted runner(s) registered" "$output"
assert_contains "runners: an unreadable organization list is a warning that it could not be checked" "could not list the self-hosted runners of the organization acme" "$output"
assert_contains "runners: the declaration still runs" "curl PATCH" "$log"

reset_case
INPUT='\ny\n'
run_setup
assert_not_contains "runners: a personal base has no organization runners to list" "orgs/acme/actions/runners" "$log"
assert_not_contains "runners: none registered, nothing warned" "self-hosted runner(s)" "$output"

# The board's port follows PORT, as the board does.
reset_case
TOKEN_ENV="TIDEPOOL_API_TOKEN=s3cret-board-token PORT=4700"
INPUT='\ny\n'
run_setup
assert_contains "port: reaches the board on PORT" "curl GET 4700/api/workspaces" "$log"

# --- stop conditions --------------------------------------------------------
# Each stops before any fork, prompt or declaration.

stops_before_changes() {
  assert_eq "$1: exits non-zero" "1" "$rc"
  assert_not_contains "$1: does not fork" "-X POST" "$log"
  assert_not_contains "$1: does not declare" "curl PATCH" "$log"
  assert_not_contains "$1: asks nothing" "Press Enter" "$output"
}

reset_case
ARGS="trial acme"
run_setup
stops_before_changes "same owner"
assert_contains "same owner: says why" "acme owns acme/widget, and GitHub cannot fork a repository into its own owner" "$output"

reset_case
ARGS="trial me"
OWNER_TYPE="User"
run_setup
stops_before_changes "personal base to an account"
assert_contains "personal base to an account: says the fork must go to an organization" "owned by a personal account, so its fork must go to an organization" "$output"

reset_case
BASE_OWNER_TYPE="Organization"
OWNER_TYPE="Organization"
FORK_ERROR="gh: forking is disabled (HTTP 403)"
run_setup
assert_eq "forking disabled: exits non-zero" "1" "$rc"
assert_contains "forking disabled: names the organization setting" "members_can_fork_private_repositories" "$output"
assert_contains "forking disabled: names the repository setting" "allow_forking" "$output"
assert_not_contains "forking disabled: does not go on" "actions/permissions" "$log"

# Any 403 from the fork names both settings, whatever GitHub's wording.
reset_case
BASE_OWNER_TYPE="Organization"
FORK_ERROR="gh: Resource not accessible by personal access token (HTTP 403)"
run_setup
assert_eq "fork 403: exits non-zero" "1" "$rc"
assert_contains "fork 403: names the organization setting" "members_can_fork_private_repositories" "$output"
assert_contains "fork 403: names the repository setting" "allow_forking" "$output"

# A base owned by an organization may be forked into your own account (no organization parameter).
reset_case
ARGS="trial me"
BASE_OWNER_TYPE="Organization"
OWNER_TYPE="User"
INPUT='\ny\n'
run_setup
assert_eq "org base to your account: exits 0" "0" "$rc"
assert_contains "org base to your account: forks without an organization" "gh api -X POST repos/acme/widget/forks --jq .full_name" "$log"
assert_not_contains "org base to your account: does not recommend an organization" "organization that holds only head repos" "$output"

reset_case
PATCH_ANSWERS="400"
INPUT='\n'
run_setup
assert_eq "board refuses the value: exits non-zero" "1" "$rc"
assert_contains "board refuses the value: prints the board's reason" "must be a fork of acme/widget" "$output"

reset_case
INPUT='\nn\n'
run_setup
assert_eq "declined confirmation: exits non-zero" "1" "$rc"
assert_eq "declined confirmation: does not resend with confirm" "0" "$(grep -c '"confirm":true' <<< "$log" || true)"

# Input ends while waiting (a closed terminal): the run stops with a message, and a re-run continues.
reset_case
OWNER_TYPE=""
run_setup
assert_eq "no input: exits non-zero" "1" "$rc"
assert_contains "no input: says how to continue" "Run this again to continue" "$output"
assert_not_contains "no input: does not fork" "-X POST" "$log"

# --- summary ---------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
