# Tidepool first boot on a Mac

This covers a purely-local board on your own Apple Silicon Mac, ending with your first task
completed against a local `trial` workspace. The board itself runs inside a Linux VM on the Mac
(Lima, with its default Ubuntu template): macOS has no worker container mechanism that passes the
worker container contract, so the board uses the Linux one unchanged (ADR 0100). Budget about
30 minutes, most of it the VM image download (941 MB).

## What you need

- An Apple Silicon Mac.
- [Homebrew](https://brew.sh).
- A GitHub account.
- A Claude subscription.

Node, the `claude` CLI, `gh` and your git identity all live **inside the VM**. Nothing but Lima
is installed on the Mac, and nothing below asks you to open a shell in the VM until stage two.

This document was measured with Lima 2.2.0, Lima's default Ubuntu 26.04 image and `claude` 2.1.243
— a newer Lima, Ubuntu image or CLI is a reason to walk it again.

## Run the installer

On the Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/sinano1107/tidepool/main/scripts/mac-install.sh | bash
```

It installs Lima if you do not have it, creates the VM and shows the provisioning progress, then
walks you through the two logins and prepares your registry. It stops early with a message if
your Mac cannot run the board. If it is interrupted — a closed terminal, a login you did not
finish — run the same command again: every step checks its own state and continues from there.
It is also safe to run on a finished setup as a "check my setup" command.

### The two logins

The installer pauses twice, each time giving you a URL to open in your Mac's browser:

1. `gh auth login` — authorizes the VM's `gh` against your GitHub account (it also shows a
   one-time code to enter on that page).
2. `claude auth login` — logs the VM's `claude` in with your Claude subscription.

Both are the **VM's own** logins. Whatever you are logged into on the Mac is not copied into the
VM, and these are what the board's worker sessions and the board's own calls run on.

Everything after them is automatic: the checkout is trusted in Claude Code, your git identity is
taken from your GitHub account, and a private `tidepool-registry` repository is created and seeded.

## Start the board

The installer prints this line when it finishes. Run it from the **Mac**:

```bash
caffeinate -i -s limactl shell tidepool -- bash -lc '~/tidepool/scripts/vm-board.sh'
```

Run it in the foreground. `caffeinate` keeps the Mac from idle-sleeping while the board runs
(`-s` only holds while on AC power); closing the lid still sleeps the machine.

The WebUI is at `http://127.0.0.1:4589` in the Mac's browser — Lima forwards the VM's loopback
ports to the Mac's loopback. First boot prints a one-time bootstrap URL that sets the WebUI
credential in your browser — open that URL first. See
[docs/human-surface-credential.md](human-surface-credential.md) for how to rotate it if you lose
it.

To stop the board, from the Mac:

```bash
limactl shell tidepool -- systemctl --user stop tidepool-board.scope
```

That ends everything the board was running — the board itself and anything still inside a worker
container — and the `limactl shell` and `caffeinate` on the Mac end with it.

## Update Tidepool

Updating is your decision, never a side effect of starting the VM. When you want the current
`main`, stop the board and run:

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && git pull && npm install'
```

## Checklist

In a second terminal on the Mac, with the board still running:

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4589/api/tasks
```
Expect `401` — the API rejects unauthenticated requests.

```bash
lsof -nP -iTCP:4589 -iTCP:4590 -sTCP:LISTEN
```
Expect `limactl` holding both ports, on `127.0.0.1` only — that is Lima's forward, not the board.

```bash
limactl shell tidepool -- ss -ltnp | grep -E ':4589|:4590'
```
Expect `node` on `127.0.0.1:4589` and `127.0.0.1:4590`, and nothing on `0.0.0.0` or `*`.

```bash
limactl shell tidepool -- systemctl --user is-active tidepool-board.scope
```
Expect `active`.

```bash
limactl shell tidepool -- bash -lc 'source ~/.tidepool/env && \
  test -n "$TIDEPOOL_REGISTRY" && \
  test -n "$TIDEPOOL_DB" && \
  test -n "$TIDEPOOL_WORKER_LOGS" && \
  echo "required Tidepool environment is set"'
```
Expect `required Tidepool environment is set`.

## Create a trial workspace

In the WebUI, open the **Settings** tab and add a workspace with:

```text
Mode: `create`
Name: `trial`
```

Submit the form. This creates a fresh, purely-local Git checkout with an empty initial commit;
it does not touch GitHub. Leave `sandbox` untouched as the blank local workspace the registry
seeded.

## First task

In the WebUI, open the **Register** tab (Source: `manual`), click **use the plain form**, fill in
the fields below, set **Workspace** to `trial`, and press **Register**. Leaving Workspace as
`(default workspace)` means `sandbox`, so select `trial` explicitly:

```text
Title: Create the trial README
Purpose: Create README.md with this one-sentence description: "A scratch workspace for trying out Tidepool."
Completion criteria: README.md exists and contains that sentence.
```

Completion criteria are what the worker checks itself, so keep them to things it can see in the
workspace — not to what happens on the board afterwards. For your next tasks, the text box on the
same screen takes a description in your own words and **Draft fields** turns it into these fields.

What you should see: the task is picked up, the worker finishes, and a merge question titled
`land completed task: Create the trial README` appears for you to answer. The worker runs in a
bubblewrap sandbox inside a container the board makes per worker session in the VM — the installer
put both there, nothing more to do. If nothing is picked up, the WebUI shows why.

## Keeping the VM's login alive

The VM's `claude` login refreshes itself while the board keeps calling out, so a board you leave
running stays logged in. Its refresh token expires after 30 days unused, so a board stopped for
that long comes back to a dead login. The board is built to surface that as a question about the
Claude login rather than to stop silently (ADR 0100): log in again from the Mac with

```bash
limactl shell tidepool -- bash -lc 'claude auth login'
```

and answer that question.

## Stage two: a repository of your own

Everything above ran on a workspace that lives only on your Mac. This stage puts it on GitHub —
**a fresh, empty repository you create for the trial**, not one you already care about. The board
pushes as the `tidepool-board` GitHub App, never as you, and what it does to a repository is
narrow: it writes `task/<id>` branches and opens pull requests; it never writes to `main`
directly, and it merges only when you answer a merge question. Installing the App is per
repository and you can remove it at any time from https://github.com/settings/installations —
the board then stops on that workspace instead of carrying on silently.

This stage is the only one that needs a shell in the VM. Open one from the Mac with
`limactl shell tidepool` and start it with `cd ~/tidepool`: the shell opens in the Mac's current
directory, which is mounted read-only inside the VM, so nothing works until you move to the VM's
own home.

### Log the board in to GitHub

In the VM, from the checkout: add the token path to `~/.tidepool/env` — the **path** goes in the
file, never the token itself — and source it in every shell that starts the board:

```bash
echo 'export TIDEPOOL_GITHUB_TOKEN_FILE="$HOME/.tidepool/github-token"' >> ~/.tidepool/env
source ~/.tidepool/env
npm run github-login
```

A code and a URL are printed; open the URL, enter the code, and approve. The token lands in
`$TIDEPOOL_GITHUB_TOKEN_FILE` (mode 600). Re-run the same command if you ever revoke it.

### Create the trial repository and install the App on it

In the VM:

```bash
gh repo create YOUR_GITHUB_LOGIN/tidepool-trial --private
```

Leave it empty — no README. Then install the App on it **and on `tidepool-registry`**. Open:

https://github.com/apps/tidepool-board/installations/new

The page is titled "Install tidepool-board". If you belong to organizations it first asks where
to install — pick your own account. Then:

1. Select **Only select repositories**.
2. In the **Select repositories** dropdown, search for and add `tidepool-trial` and
   `tidepool-registry`.
3. Press the green **Install** button at the bottom.

To add a repository later, go to https://github.com/settings/installations, find
`tidepool-board`, press **Configure**, and add it under "Repository access".

**The registry one is not optional**: once the board is logged in, it reads the registry through the App as well, and a
registry without the App shows up at the next start as
`the GitHub token broker refused a token for …/tidepool-registry (HTTP 404: repo_unreachable)`
— the board starts, then stops picking up until you install the App and answer the question it
raises.

Stop the board and start it again with the command in "Start the board" so it picks up the new
environment file. The settings tab now shows "GitHub: logged in".

### Publish the trial

In the settings tab, open the `trial` workspace and use **Publish** with the clone URL
`https://github.com/YOUR_GITHUB_LOGIN/tidepool-trial.git`. The board pushes every branch the
trial already has — including the `task/…` branch from your first task — and records the
repository on the workspace. If the App is not installed on the repository, the publish is
refused with the install link and nothing lands; install and retry.

### Second task

Register another task on `trial` the same way as the first, selecting **Workspace** `trial`, for
example:

```text
Title: Add a usage section to the README
Purpose: README.md describes this workspace in one sentence. Add a "Usage" section below it with two short bullet points on how to register a task.
Completion criteria: README.md has a "Usage" heading followed by two bullet points.
```

What you should see this time: the worker finishes, a pull request opens on `tidepool-trial`
authored by `tidepool-board[bot]`, the board asks you a merge question, and answering it merges
the pull request. The commit's author is `tidepool` with the App's noreply address.

### Checklist

In the VM:

```bash
gh pr list --repo YOUR_GITHUB_LOGIN/tidepool-trial --state all --json author --jq '.[].author.login'
```
Expect `tidepool-board`.

```bash
curl -s -H "Authorization: Bearer $(cat ~/.tidepool/github-token)" \
  https://api.github.com/user/installations | grep -c tidepool-board
```
Expect `1` — the login works and the App is installed where you can reach it.

## Stage three (optional): an existing repository

The same mechanics apply to a repository you already work in. Add it to the App's installation
(https://github.com/settings/installations → `tidepool-board` → **Configure**; a repository you
do not administer needs its admin to install the App from the link above), then in the settings tab add
a workspace with **clone a repository** and its clone URL. The board refuses the registration with
the install link when the App is missing or you cannot push to the repository.

Use a dedicated clone: the board treats a workspace as its own during a task, and a checkout you
also edit by hand will end up quarantined. Nothing else changes — task branches, pull requests,
and a merge question you answer.
