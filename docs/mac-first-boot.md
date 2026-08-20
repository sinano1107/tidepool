# Tidepool first boot on a Mac

This covers a purely-local board on your own Apple Silicon Mac, ending with your first task
completed against the local `sandbox` workspace. Budget about 30 minutes.

## Prerequisites

- An Apple Silicon Mac.
- Node 22.x.
- The `claude` CLI installed and logged in (`/login`).
- The `gh` CLI logged in (`gh auth login`).
- `git config user.name` and `git config user.email` set.
- SSH access to GitHub — the registry repo below is cloned over SSH.

## Clone Tidepool and install

```bash
git clone git@github.com:sinano1107/tidepool.git
cd tidepool
npm install
```

If `npm install` fails while compiling native modules, install the Xcode Command Line Tools
(`xcode-select --install`) and rerun it.

## Trust the checkout in Claude Code

Run `claude` once from inside the checkout, accept "Yes, I trust this folder", dismiss any
what's-new screen so the prompt is visible, then quit:

```bash
claude
```

Skip this and the board starts but never picks anything up: the WebUI shows "usage check
unavailable" and cannot tell you that trust is the cause.

## Environment file: `~/.tidepool/env`

```bash
mkdir -p ~/.tidepool
cat > ~/.tidepool/env <<'EOF'
export TIDEPOOL_REGISTRY="$HOME/tidepool-registry"
export TIDEPOOL_DB="$HOME/.tidepool/board.sqlite"
export TIDEPOOL_WORKER_LOGS="$HOME/.tidepool/worker-logs"
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
(`-s` only holds while on AC power); closing the lid still sleeps the machine.

The WebUI is at `http://127.0.0.1:4589`. First boot prints a one-time bootstrap URL that sets the
WebUI credential in your browser — open that URL first. See
[docs/human-surface-credential.md](human-surface-credential.md) for how to rotate it if you lose
it.

## Checklist

In a second terminal, with the board still running:

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4589/api/tasks
```
Expect `401` — the API rejects unauthenticated requests.

```bash
lsof -nP -iTCP:4589 -iTCP:4590 -sTCP:LISTEN
```
Expect both ports listening only on `127.0.0.1`.

## First task

In the WebUI, open the **Register** tab (Source: `manual`), click **use the plain form**, fill in
the fields below and press **Register**:

```text
Title: Resolve the README TODO
Purpose: README.md has a TODO line asking for a one-sentence description of this workspace. Replace that line with: "A scratch workspace for trying out Tidepool."
Completion criteria: README.md contains that sentence and no longer contains the word TODO.
```

Completion criteria are what the worker checks itself, so keep them to things it can see in the
workspace — not to what happens on the board afterwards. For your next tasks, the text box on the
same screen takes a description in your own words and **Draft fields** turns it into these fields.

What you should see: the task is picked up, the worker finishes, and a merge question appears for
you to answer. The worker sandbox uses macOS's built-in `sandbox-exec` — nothing to install. If
nothing is picked up, the WebUI shows why; "usage check unavailable" means the trust step above
was skipped — redo it and restart the board.

## Own repository

Adding your own GitHub repository as a workspace waits on issue #392. Until that lands, stay on the local `sandbox` workspace from this
guide.
