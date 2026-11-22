#!/usr/bin/env bash
# scripts/head-repo-setup.sh — prepare a workspace's PR head repo, once per workspace (ADR 0395 決定6).
# Run it in the VM, from the checkout, while the board is running:
#
#   scripts/head-repo-setup.sh <workspace> <owner>
#
# <owner> is the organization the fork goes to. A repository owned by an organization may also be
# forked into your own account. GitHub calls run with your `gh` login; the board is reached at
# 127.0.0.1:$PORT (default 4589, as the board) with the board token (TIDEPOOL_API_TOKEN, or typed in — it is never stored).
#
# 各段は自分の状態を先に確かめる: 途中で止まれば続きから走り、済んだ段は何も変えない(mac-install.sh と同じ性質)。
# macOS の bash 3.2 でテストを走らせるので、3.2 で書く。

set -euo pipefail

BOARD="http://127.0.0.1:${PORT:-4589}"
ORG_NEW_URL="https://github.com/account/organizations/new"
APP_INSTALL_URL="https://github.com/apps/tidepool-board/installations/new"
FORK_PR_SECTION='"Fork pull request workflows in private repositories"'

log() { printf '\033[1;34m[head-repo]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
declared_is_fork() { [[ "$(lower "$DECLARED")" == "$(lower "$FORK")" ]]; }

# 入力が尽きたら set -e で黙って落ちず、続きから走れることを言って止まる
ask() {
  printf '%s ' "$1"
  read -r ANSWER || { echo; fail "stopped waiting for an answer. Run this again to continue from here."; }
}
wait_for_enter() { ask "Press Enter when done."; }

# JSON on stdin → the value of a JS expression over `j` (no jq in the VM; node runs the board).
json() {
  node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); const v = eval(process.argv[1]);
if (v !== undefined && v !== null) console.log(Array.isArray(v) ? v.join("\n") : String(v));' "$1"
}

# 盤面秘密は argv に載せない(同じ VM の ps に見える)—— curl の設定として stdin から渡す。STATUS と BODY を置く
board() {
  local out
  out="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
    | curl -sS -K - -X "$1" -H 'Content-Type: application/json' ${3:+--data "$3"} -w '\n%{http_code}' "$BOARD$2")" \
    || fail "the board is not reachable at $BOARD. Start it and run this again."
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
board_error() { printf '%s' "$BODY" | json 'j.error' 2> /dev/null || printf '%s' "$BODY"; }

read_board_token() {
  if [[ -n "${TIDEPOOL_API_TOKEN:-}" ]]; then
    TOKEN="$TIDEPOOL_API_TOKEN"
    return
  fi
  printf 'Board token (printed at the first boot; not stored): '
  read -rs TOKEN || { echo; fail "no board token given."; }
  echo
}

read_workspace() {
  board GET /api/workspaces
  [[ "$STATUS" == 200 ]] || fail "the board refused to list workspaces (HTTP $STATUS): $(board_error). Check the board token."
  local fields
  # a unit separator, not a tab: IFS whitespace would fold an empty head_repo away
  # an absent branch is main, as the board reads it
  fields="$(printf '%s' "$BODY" | WS="$WORKSPACE" json '((w) => w && [w.repo ?? "", w.head_repo ?? "", w.path ?? "", w.branch ?? "main"].join("\x1f"))(j.workspaces.find((w) => w.name === process.env.WS))')"
  [[ -n "$fields" ]] || fail "the board has no workspace named $WORKSPACE."
  IFS=$'\x1f' read -r REPO DECLARED CHECKOUT BRANCH <<< "$fields"
  [[ -n "$REPO" ]] || fail "workspace $WORKSPACE has no repository yet. Publish it first (Settings → Publish), then run this again."
  BASE="$(printf '%s' "$REPO" | sed -E 's#^(https://([^/@]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)##; s#/$##; s#\.git$##')"
  [[ "$BASE" =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$ ]] || fail "workspace $WORKSPACE's repository $REPO is not on GitHub."
}

read_base() {
  local info
  info="$(gh api "repos/$BASE" --jq '.owner.login, .owner.type, .private')" || fail "could not read $BASE with your gh login."
  { read -r BASE_OWNER; read -r BASE_OWNER_TYPE; read -r BASE_PRIVATE; } <<< "$info"
  LOGIN="$(gh api user --jq .login)"
}

# OWNER_TYPE: User / Organization、まだ無ければ空
lookup_owner() {
  local out
  if out="$(gh api "users/$OWNER" --jq .type 2>&1)"; then
    OWNER_TYPE="$out"
  elif [[ "$out" == *"HTTP 404"* ]]; then
    OWNER_TYPE=""
  else
    fail "could not look up $OWNER on GitHub: $out"
  fi
}

# Stage 1, and the stop conditions on where the fork may go.
ensure_owner() {
  if [[ "$(lower "$OWNER")" == "$(lower "$BASE_OWNER")" ]]; then
    fail "$OWNER owns $BASE, and GitHub cannot fork a repository into its own owner. Choose another organization."
  fi
  lookup_owner
  if [[ "$OWNER_TYPE" == User ]]; then
    [[ "$BASE_OWNER_TYPE" == Organization ]] \
      || fail "$BASE is owned by a personal account, so its fork must go to an organization, not to the account $OWNER."
    [[ "$(lower "$OWNER")" == "$(lower "$LOGIN")" ]] \
      || fail "a fork can go to your own account ($LOGIN) or an organization, not to another person's account $OWNER."
    return
  fi
  log "Use an organization that holds only head repos: an organization's secrets can reach the workflows of a fork it owns."
  while [[ -z "$OWNER_TYPE" ]]; do
    log "The organization $OWNER does not exist yet. Create it at $ORG_NEW_URL with the name $OWNER (the free plan is enough)."
    wait_for_enter
    lookup_owner
  done
}

# Stage 2. GitHub renames a fork whose name is taken (`widget-1`), so the name comes from GitHub's answer.
ensure_fork() {
  FORK="$(gh api "repos/$BASE/forks" --paginate --jq ".[] | select(.owner.login | ascii_downcase == \"$(lower "$OWNER")\") | .full_name")" \
    || fail "could not list the forks of $BASE."
  FORK="${FORK%%$'\n'*}"
  if [[ -n "$FORK" ]]; then
    log "$FORK is already a fork of $BASE."
    return
  fi
  log "Forking $BASE into $OWNER."
  local out
  if [[ "$OWNER_TYPE" == Organization ]]; then
    out="$(gh api -X POST "repos/$BASE/forks" -f "organization=$OWNER" --jq .full_name 2>&1)" || fork_refused "$out"
  else
    out="$(gh api -X POST "repos/$BASE/forks" --jq .full_name 2>&1)" || fork_refused "$out"
  fi
  FORK="$out"
  log "Created the fork $FORK."
}

fork_refused() {
  if [[ "$1" == *"HTTP 403"* || "$1" == *"forking is disabled"* ]]; then
    fail "GitHub refused to fork $BASE ($1). For a private repository of an organization, the organization must allow forking of private repositories (members_can_fork_private_repositories: organization Settings → Member privileges → Repository forking), then the repository must allow it (allow_forking: repository Settings → General → Allow forking). Turn them on and run this again."
  fi
  fail "GitHub refused to fork $BASE into $OWNER: $1"
}

# Stage 3. The installation is not readable with a gh login: a missing one surfaces when the board checks the
# declaration (stage 7), which reads the fork with the App's token.
ensure_app() {
  if declared_is_fork; then
    log "$FORK is already the declared head repo, so the tidepool-board App is installed on it."
    return
  fi
  log "Install the tidepool-board GitHub App on $OWNER: open $APP_INSTALL_URL, choose $OWNER, and select $FORK (or All repositories)."
  log "It asks for Administration: read, which the board uses to check the fork pull request settings of private repositories."
  wait_for_enter
}

# Stage 4. A fork's own workflows would run on the board's pushes.
ensure_actions_disabled() {
  local enabled
  enabled="$(gh api "repos/$FORK/actions/permissions" --jq .enabled)" || fail "could not read the Actions settings of $FORK."
  if [[ "$enabled" == false ]]; then
    log "Actions are already disabled on $FORK."
    return
  fi
  log "Disabling Actions on $FORK."
  printf '{"enabled":false}' | gh api -X PUT "repos/$FORK/actions/permissions" --input - > /dev/null \
    || fail "could not disable Actions on $FORK."
}

# Stage 5. A private repository runs no fork PR workflow until told to, and must not send them credentials.
ensure_fork_pr_settings() {
  if [[ "$BASE_PRIVATE" != true ]]; then
    log "$BASE is public: workflows from fork pull requests get a read-only token and no secrets, so there is nothing to set."
    return
  fi
  local settings
  while :; do
    settings="$(gh api "repos/$BASE/actions/permissions/fork-pr-workflows-private-repos" \
      --jq '[.run_workflows_from_fork_pull_requests, .send_write_tokens_to_workflows, .send_secrets_and_variables] | map(tostring) | join(" ")')" \
      || fail "could not read the fork pull request workflow settings of $BASE."
    if [[ "$settings" == "true false false" ]]; then
      log "$BASE runs workflows from fork pull requests without write tokens or secrets."
      return
    fi
    if [[ "$BASE_OWNER_TYPE" == Organization ]]; then
      log "First, in https://github.com/organizations/$BASE_OWNER/settings/actions under $FORK_PR_SECTION, allow \"Run workflows from fork pull requests\". Until the organization allows it, the repository cannot turn it on (GitHub answers \"Policy is forbidden by entity owner\")."
    fi
    log "In https://github.com/$BASE/settings/actions under $FORK_PR_SECTION:"
    log "  turn ON  \"Run workflows from fork pull requests\" (otherwise CI never reports and every PR becomes a question),"
    log "  keep OFF \"Send write tokens to workflows from fork pull requests\" and \"Send secrets and variables to workflows from fork pull requests\" (the board does not land while either is on)."
    wait_for_enter
  done
}

# Stage 6. Warnings only: these forms run outside what a fork PR is limited to, and the board does not check them.
warn_workflows() {
  local paths path content
  if ! paths="$(gh api "repos/$BASE/contents/.github/workflows?ref=$BRANCH" --jq '.[].path' 2>&1)"; then
    if [[ "$paths" == *"HTTP 404"* ]]; then
      log "$BASE has no workflows."
    else
      warn "could not read the workflows of $BASE ($paths). Check them yourself for pull_request_target, workflow_run and self-hosted runners."
    fi
    return
  fi
  while read -r path; do
    content="$(gh api "repos/$BASE/contents/$path?ref=$BRANCH" -H 'Accept: application/vnd.github.raw')" || { warn "could not read $path."; continue; }
    if grep -q 'pull_request_target' <<< "$content"; then
      warn "$path uses pull_request_target: it runs with $BASE's write token and secrets on a fork PR, and gives them to any PR code it checks out."
    fi
    if grep -q 'workflow_run' <<< "$content"; then
      warn "$path uses workflow_run: it runs with $BASE's write token and secrets after another workflow, and gives them to any fork PR content it uses."
    fi
    if grep -q 'self-hosted' <<< "$content"; then
      warn "$path uses a self-hosted runner: a fork PR's workflow runs on your own machine."
    fi
  done <<< "$paths"
}

# A runner with a custom label or in a runner group does not say self-hosted in the workflow: list the registered ones too.
warn_runners() {
  warn_runners_at "repos/$BASE" "$BASE"
  if [[ "$BASE_OWNER_TYPE" == Organization ]]; then warn_runners_at "orgs/$BASE_OWNER" "the organization $BASE_OWNER"; fi
}
warn_runners_at() {
  local count
  if ! count="$(gh api "$1/actions/runners" --jq .total_count 2>&1)"; then
    warn "could not list the self-hosted runners of $2 ($count). Check yourself whether any are registered."
  elif [[ "$count" != 0 ]]; then
    warn "$2 has $count self-hosted runner(s) registered: a fork PR's workflow that runs on one runs on your own machine."
  fi
}

# 盤面は送れたタスクブランチだけを refs/remotes/head-repo/task/* に写す(issue #3563)。checkout は読むだけ
# shortcut: a task branch made or advanced after the declaration has no copy until its task lands, so a re-run on a board
# in use asks to declare again (an idempotent resend); compare with the head repo's own refs if that prompt gets in the way.
all_task_branches_sent() {
  [[ -n "$CHECKOUT" ]] || return 1
  local sha branch
  while read -r sha branch; do
    [[ -z "$sha" ]] && continue
    [[ "$(git -C "$CHECKOUT" rev-parse -q --verify "refs/remotes/head-repo/$branch" || true)" == "$sha" ]] || return 1
  done <<< "$(git -C "$CHECKOUT" for-each-ref --format='%(objectname) %(refname:lstrip=2)' refs/heads/task/)"
}

# Stages 7 and 8: the declaration goes through the board's dangerous-value gate, and saving it sends the task branches.
declare_head_repo() {
  if declared_is_fork && all_task_branches_sent; then
    log "$FORK is the declared head repo of $WORKSPACE, and every task branch is on it."
    return
  fi
  local confirm=""
  while :; do
    board PATCH "/api/workspaces/$WORKSPACE" "{\"head_repo\":\"$FORK\"$confirm}"
    case "$STATUS" in
      200)
        log "Declared $FORK as the head repo of $WORKSPACE; the board sent its task branches there."
        return ;;
      409)
        [[ "$(printf '%s' "$BODY" | json 'j.confirm_required' 2> /dev/null || true)" == true ]] \
          || fail "the board refused the head repo: $(board_error)"
        log "The board asks you to confirm: $(board_error) ($(printf '%s' "$BODY" | json '(j.dangerous_values ?? []).join(", ")'))"
        ask "Declare $FORK as the head repo of $WORKSPACE? [y/N]"
        if [[ "$ANSWER" != y && "$ANSWER" != Y && "$ANSWER" != yes ]]; then
          ! declared_is_fork || fail "$FORK stays the declared head repo, but the task branches it lacks were not sent. Run this again to send them."
          fail "the head repo was not declared. Run this again to declare it."
        fi
        confirm=',"confirm":true' ;;
      502)
        [[ "$(printf '%s' "$BODY" | json 'j.saved' 2> /dev/null || true)" == true ]] || fail "the board could not save the head repo: $(board_error)"
        warn "$(board_error)"
        log "Fix what the message names; the board sends the remaining task branches again."
        wait_for_enter ;;
      400) fail "the board refused $FORK as the head repo: $(board_error)" ;;
      *) fail "the board answered HTTP $STATUS: $(board_error)" ;;
    esac
  done
}

main() {
  [[ $# -eq 2 ]] || fail "usage: scripts/head-repo-setup.sh <workspace> <owner> (the organization the fork goes to)"
  WORKSPACE="$1"
  OWNER="$2"
  [[ "$OWNER" =~ ^[A-Za-z0-9-]+$ ]] || fail "$OWNER is not a GitHub account or organization name."
  read_board_token
  read_workspace
  read_base
  ensure_owner
  ensure_fork
  ensure_app
  ensure_actions_disabled
  ensure_fork_pr_settings
  warn_workflows
  warn_runners
  declare_head_repo
  log "Done: $WORKSPACE lands task branches from $FORK."
}

# scripts/head-repo-setup.test.sh が source して stub の上で main を呼ぶ
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
