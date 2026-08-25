# Tidepool first boot on a Mac

This covers a purely-local board on your own Apple Silicon Mac, ending with your first task
completed against a local `trial` workspace. The board itself runs inside a Linux VM on the Mac
(Lima, with its default Ubuntu template): macOS has no worker container mechanism that passes the
worker container contract, so the board uses the Linux one unchanged (ADR 0100). Budget about
30 minutes, plus the VM image download (941 MB).

## Prerequisites

On the Mac:

- An Apple Silicon Mac.
- Homebrew.
- Lima: `brew install lima`.

Everything else — Node, the `claude` CLI, `gh`, your git identity — is installed **inside the VM**
further down, not on the Mac.

## Create the VM

```bash
limactl start --name tidepool template:default
```

This document was measured with Lima 2.2.0, `claude` 2.1.243 and Node 22.23 — a newer Lima,
Ubuntu image or CLI is a reason to walk it again. The default template is Ubuntu 26.04 LTS with
4 CPUs, 4 GiB of memory and a 100 GiB disk, running
on Apple's Virtualization framework (`vmType: vz`). The first start downloads the image (941 MB);
later starts do not.

Open a shell in it:

```bash
limactl shell tidepool
```

### Every VM shell starts with `cd`

`limactl shell` opens in the same path as the Mac's current directory, and your Mac home is
mounted inside the VM at `/Users/<your-mac-username>` **read-only**. A shell that starts there
cannot write.

So begin every VM shell by moving to the VM's own home and checking where you landed:

```bash
cd && pwd
```

Expect `/home/<your-mac-username>.guest` — the VM's own disk. Never clone Tidepool or keep board
state under `/Users/...`.

## Install the tools inside the VM

```bash
sudo apt-get update && sudo apt-get install -y bubblewrap socat git curl build-essential python3 gh
```

Node 22, from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

The `claude` CLI:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

It installs into `~/.local/bin`: put `export PATH="$HOME/.local/bin:$PATH"` in your shell's
startup file and reopen the shell before the next step.

Then log `gh` in and set the git identity the VM will commit with:

```bash
gh auth login
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Choose HTTPS when `gh auth login` asks, and let it authenticate git for you (`gh auth setup-git`
does the same afterwards) — the clones below use HTTPS, and the VM has no SSH key of yours.

## Let the worker sandbox nest a user namespace

Ubuntu 24.04 and later restrict unprivileged user namespaces by default, and the worker's file
sandbox needs them. Both halves of that restriction have to come off (measured on 26.04) — run
these in the VM once; they survive reboots:

```bash
echo "kernel.apparmor_restrict_unprivileged_userns = 0" | sudo tee /etc/sysctl.d/60-tidepool.conf && sudo sysctl --system
sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/ && sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict
```

The two fail differently. Skip the second line and the board still starts and still picks the task
up, but every Bash command the worker runs dies with
`apply-seccomp: … nested userns is capability-restricted …`; the worker cannot use `git`, so it
raises a question saying so and the task stops there — nothing warns you in advance, because the
board's sandbox probe passes on that host. Skip the first line instead and the probe itself fails
(`bwrap: setting up uid map: Permission denied`), so the board stops pickup with a containment
question.

Verify:

```bash
sysctl -n kernel.apparmor_restrict_unprivileged_userns
sudo aa-status | grep -cE '^\s+(bwrap|unpriv_bwrap)$'
bwrap --ro-bind / / --dev /dev -- /bin/true; echo $?
socat -V >/dev/null; echo $?
```

Expect `0` from each: the restriction is off, the `bwrap` profiles are not loaded, and both
sandbox halves run.

## Clone Tidepool and install

In the VM's own home:

```bash
git clone https://github.com/sinano1107/tidepool.git ~/tidepool
cd ~/tidepool
npm install
```

## Trust the checkout in Claude Code

**Inside the VM**, from the checkout you just made:

```bash
cd ~/tidepool && pwd && claude
```

Check that `pwd` printed the `/home/…` path, not `/Users/…`. Then, in `claude`: accept
"Yes, I trust this folder", run `/login` and finish the browser login, dismiss any what's-new
screen so the prompt is visible, and quit.

The `/login` here is the VM's own — the login on your Mac is not copied into the VM, and the
board's worker sessions and the board's own calls all run on this one.

Trust the checkout on the Mac instead of in the VM, or skip this step, and the board starts but
never picks anything up: its usage check stops at the trust dialog, which the board reads as a
fail-closed throttle. The WebUI shows "usage check unavailable" and cannot tell you that trust is
the cause.

## Environment file: `~/.tidepool/env`

In the VM's home:

```bash
mkdir -p ~/.tidepool
cat > ~/.tidepool/env <<'EOF'
export TIDEPOOL_REGISTRY="$HOME/tidepool-registry"
export TIDEPOOL_DB="$HOME/.tidepool/board.sqlite"
export TIDEPOOL_WORKER_LOGS="$HOME/.tidepool/worker-logs"
EOF
```

`$HOME` is the VM's home, so the database, the worker logs and the workspaces all live on the VM's
own disk rather than on the read-only mount of your Mac home.

Run `source ~/.tidepool/env` in every VM shell that runs `init-registry` or starts the board.

## Prepare the registry

In the VM, with `~/.tidepool/env` sourced, create an empty private repository with your own GitHub
credentials, then clone it to `$TIDEPOOL_REGISTRY`:

```bash
gh repo create YOUR_GITHUB_LOGIN/tidepool-registry --private
git clone https://github.com/YOUR_GITHUB_LOGIN/tidepool-registry.git "$TIDEPOOL_REGISTRY"
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

From the **Mac**, not from a VM shell:

```bash
caffeinate -i -s limactl shell tidepool -- bash -lc 'source ~/.tidepool/env && cd ~/tidepool && exec systemd-run --user --scope --unit tidepool-board -p Delegate=yes -- npm start'
```

Run this in the foreground. `systemd-run --user --scope` with `-p Delegate=yes` hands the board a
cgroup subtree of its own for its worker containers — without it the board refuses to pick
anything up and names `Delegate=yes` in the reason. `caffeinate` keeps the Mac from idle-sleeping
while the board runs (`-s` only holds while on AC power); closing the lid still sleeps the machine.

The WebUI is at `http://127.0.0.1:4589` in the Mac's browser — Lima forwards the VM's loopback
ports to the Mac's loopback. First boot prints a one-time bootstrap URL that sets the WebUI
credential in your browser — open that URL first. See
[docs/human-surface-credential.md](human-surface-credential.md) for how to rotate it if you lose
it.

To stop the board, from the Mac:

```bash
limactl shell tidepool -- systemctl --user stop tidepool-board.scope
```

That ends everything in the scope — the board and anything still inside a worker container — and
the `limactl shell` and `caffeinate` on the Mac end with it.

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
bubblewrap sandbox inside a container the board makes per worker session in the VM — both already
installed above, nothing more to do. If nothing is picked up, the WebUI shows why; "usage check unavailable"
means the trust step above was skipped or was done on the Mac instead of in the VM — redo it in
the VM and restart the board.

## Keeping the VM's login alive

The VM's `claude` login refreshes itself while the board keeps calling out, so a board you leave
running stays logged in. Its refresh token expires after 30 days unused, so a board stopped for
that long comes back to a dead login. The board is built to surface that as a question about the
Claude login rather than to stop silently (ADR 0100): run `/login` again inside the VM
(`cd ~/tidepool && claude`) and answer that question.

## Stage two: a repository of your own

Everything above ran on a workspace that lives only on your Mac. This stage puts it on GitHub —
**a fresh, empty repository you create for the trial**, not one you already care about. The board
pushes as the `tidepool-board` GitHub App, never as you, and what it does to a repository is
narrow: it writes `task/<id>` branches and opens pull requests; it never writes to `main`
directly, and it merges only when you answer a merge question. Installing the App is per
repository and you can remove it at any time from https://github.com/settings/installations —
the board then stops on that workspace instead of carrying on silently.

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
