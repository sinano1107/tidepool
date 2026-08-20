# Tidepool first boot on a Mac

This covers stage 1: a purely-local board on your own Apple Silicon Mac, ending with your first
task completed against the local `sandbox` workspace. Budget about 30 minutes.

## Prerequisites

- An Apple Silicon Mac.
- Node 22.x (see `.nvmrc`).
- The `claude` CLI installed and logged in — run `/login` inside it once. Do not use
  `claude setup-token`; that form is for unattended hosts, not your own machine.
- The `gh` CLI logged in (`gh auth login`).
- `git config user.name` and `git config user.email` set.
- SSH access to GitHub — the registry repo below is cloned over SSH.

## Clone Tidepool and install

```bash
git clone git@github.com:sinano1107/tidepool.git
cd tidepool
npm install
```

## Trust the checkout in Claude Code

Run `claude` once from inside the checkout, accept "Yes, I trust this folder", then quit:

```bash
claude
```

The board scrapes `/usage` from an interactive `claude` session run in this same directory; an
untrusted folder makes that scrape fail closed, and the board picks up nothing without saying why.

## Environment file: `~/.tidepool/env`

```bash
mkdir -p ~/.tidepool
cat > ~/.tidepool/env <<'EOF'
export TIDEPOOL_REGISTRY="$HOME/tidepool-registry"
export TIDEPOOL_DB="$HOME/.tidepool/board.sqlite"
export TIDEPOOL_WORKER_LOGS="$HOME/.tidepool/worker-logs"

# Optional overrides:
# export TIDEPOOL_WORKSPACES_DIR="$HOME/tidepool-workspaces"
# export TIDEPOOL_WORKSPACE="sandbox"
# export TIDEPOOL_AGENT="tako"
# export TIDEPOOL_AUDITOR="fugu"
EOF
```

Run `source ~/.tidepool/env` in every shell that runs `init-registry` or starts the board.

## Prepare the registry

With `~/.tidepool/env` sourced, create an empty private repository with your own GitHub
credentials, then clone it to `$TIDEPOOL_REGISTRY`:

```bash
gh repo create YOUR_GITHUB_LOGIN/tidepool-registry --private
git clone git@github.com:YOUR_GITHUB_LOGIN/tidepool-registry.git "$TIDEPOOL_REGISTRY"
```

From the Tidepool checkout, seed the empty remote and create the initial local workspace:

```bash
npm run init-registry
```

With the defaults, the command confirms:

```text
Registry seeded with agent "tako", auditor "fugu", and workspace "sandbox".
```

## Start the board

From the Tidepool checkout, with the same environment sourced:

```bash
caffeinate -i -s npm start
```

Run this in the foreground. `caffeinate` keeps the Mac from idle-sleeping while the board runs
(`-s` only holds while on AC power); closing the lid still sleeps the machine. There is no
launchd unit for this stage.

First boot prints a one-time bootstrap URL for the WebUI credential — open it. See
[docs/human-surface-credential.md](human-surface-credential.md) for how to rotate it if you lose
it.

## Checklist

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4589/api/tasks
```
Expect `401` — the API rejects unauthenticated requests.

```bash
lsof -nP -iTCP:4589 -iTCP:4590 -sTCP:LISTEN
```
Expect both ports listening only on `127.0.0.1`.

```bash
env | grep ^TIDEPOOL_
```
Expect `TIDEPOOL_REGISTRY`, `TIDEPOOL_DB`, and `TIDEPOOL_WORKER_LOGS` to be listed.

## First task

Open the WebUI and register the task printed by the init command:

```text
Title: Resolve the README TODO
Purpose: Replace the TODO in sandbox/README.md with a short description of this workspace.
Completion criteria: README.md contains the description and the task reaches the merge question.
```

The expected manual path is pickup, completion, then the merge question for the purely-local
workspace. The worker sandbox uses macOS's built-in `sandbox-exec` — nothing to install. If
pickup stalls, the WebUI shows the halt reason.

## Own repository

Adding your own GitHub repository as a workspace waits on issue #392 (moving the board's GitHub
identity to a GitHub App). Until that lands, stay on the local `sandbox` workspace from this
guide.

## Feedback

Send feedback to the Slack `#tidepool` channel — note the time and where you got stuck.
