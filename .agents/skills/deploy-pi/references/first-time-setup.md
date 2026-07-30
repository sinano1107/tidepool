# First-time setup / new Pi

Only needed once per Pi (or when bootstrapping a fresh clone after wiping `/mnt/ssd`). For a routine deploy, use the main SKILL.md workflow instead.

`PI=masaki@100.78.52.97` below.

## 1. Clone repos onto `/mnt/ssd` (exFAT — fine for git, source-of-truth only)

Requires `gh` to be installed and authenticated first (step 4) — plain `git clone` over HTTPS will fail with `could not read Username for 'https://github.com'` since there's no credential helper configured yet.

```bash
ssh $PI "cd /mnt/ssd && gh repo clone sinano1107/tidepool tidepool && gh repo clone sinano1107/tidepool-registry tidepool-registry && mkdir -p tidepool-workspaces/sandbox"
```

## 2. `sandbox` workspace must be an actual git repo

`workspaces.yaml` calls it "no repo, safe to wipe" but that's about disposability, not literal absence — `ensureTaskBranch`/`releaseTree` (branch discipline, `src/workspace.ts`) run real `git branch`/`checkout`/`commit` against it. Without an initial commit on `main`, the very first pickup fails and quarantines the workspace.

```bash
ssh $PI "cd /mnt/ssd/tidepool-workspaces/sandbox && git init -q -b main && git config user.name tidepool && git config user.email tidepool@board && echo '# sandbox' > README.md && git add README.md && git commit -q -m 'init sandbox workspace'"
```

## 3. Point `tidepool-registry`'s `workspaces.yaml` at Pi paths

`workspaces.yaml` says explicitly "paths are host-specific — adjust them in each clone (Mac for development, the Pi in production)". Edit `sandbox.path` and `registry.path` to `/mnt/ssd/tidepool-workspaces/sandbox` and `/mnt/ssd/tidepool-registry` respectively, then commit and push from wherever it's easiest to edit (doesn't have to be on the Pi).

Also check `authority/*.yaml` conforms to the current `authorityProfileSchema` in `src/registry.ts` — see troubleshooting.md's first entry if this is unfamiliar; the schema has changed shape at least once (issue #41) and an out-of-date registry clone will crash the board at boot.

## 4. Install and authenticate `gh` / `claude` CLIs

```bash
ssh $PI "sudo apt-get install -y gh"
ssh $PI "sudo npm install -g @anthropic-ai/claude-code"   # sudo required, /usr/lib/node_modules needs root
```

Both need an **interactive browser login** — cannot be done non-interactively by an agent. Two options:

- Ask the user to run `gh auth login` and `claude` (first launch) themselves over their own SSH session.
- Or drive the device-flow yourself: run `ssh $PI "gh auth login --hostname github.com --git-protocol https --web"` in the **background** (it blocks polling for authorization), read its output for the one-time code + URL, relay both to the user, and let them authorize in their browser. Check completion with `gh auth status`.

**After `gh auth login` succeeds, run `gh auth setup-git` too** — without it, `git push`/`pull` over HTTPS still fails even though `gh` itself is authenticated (the credential helper isn't wired into git's config until this runs).

Note the split since issue #50 / ADR 0024: this human `gh auth` only serves the **deploy tooling** (the `git pull` on `/mnt/ssd/tidepool` and `/mnt/ssd/tidepool-registry`). The **board's own** GitHub operations (push / PR / merge / issue / registry push) run as the machine user via `TIDEPOOL_GITHUB_TOKEN_FILE` (step 5) and work with the human logged out.

**Also trust the board's own cwd once, interactively** (issue #81 / ADR-0028): the hourly usage throttle scrapes `/usage` from an *interactive* `claude --safe-mode` session run in `/opt/tidepool`, and the interactive TUI shows a folder-trust gate ("Is this a project you trust?") plus one-time onboarding modals that block the input prompt until dismissed. Once, as masaki: `ssh $PI`, then `cd /opt/tidepool && claude`, accept "Yes, I trust this folder", dismiss any what's-new/onboarding modal, and quit. This persists in `~/.claude.json` (`projects["/opt/tidepool"].hasTrustDialogAccepted: true`, home-side — survives redeploy, since deploy only rsyncs `/opt/tidepool`). Skip it and the board silently fails the throttle closed (`checkUsage` times out → null) and picks up nothing — see troubleshooting.md's first entry. (A dismissed what's-new can re-appear after a `claude` update; same one-time fix.)

## 4b. Worker sandbox dependencies (bubblewrap + socat)

Every worker session runs its Bash inside the CLI's own sandbox (issue #60 / ADR 0033), and the board **refuses to pick up any agent task** on a host where that sandbox can't start — it halts board-wide and stands a Confirmation question instead. On Linux the sandbox needs both:

```bash
ssh $PI "sudo apt-get install -y bubblewrap socat"
```

`bwrap` being installed is not sufficient — it must actually run. Unprivileged user namespaces (or an AppArmor profile restricting them) can block it on a host where the package is present. Verify with the real thing:

```bash
ssh $PI "bwrap --ro-bind / / --dev /dev -- /bin/true; echo bwrap=\$?; socat -V >/dev/null; echo socat=\$?"
```

Both must print `0`. This is one half of the check the board runs at boot and before every pickup (`checkSandboxCapability`); the other half is the board probing its own human surface for a 401 (issue #154 — see §5b). A `0/0` here means the fs half will not halt the board; the credential half needs §5b done too. On the production Pi (aarch64, kernel 6.6.51+rpt) both pass out of the box: `max_user_namespaces` is non-zero and there is no `apparmor_restrict_unprivileged_userns` knob. If `bwrap` fails on a future host, that is the known problem from ADR 0033's investigation — an AppArmor profile is needed; **ask the user before applying one.**

## 5. systemd unit + secrets

The unit (`systemd/tidepool.service`) is committed in this repo and installed by `scripts/deploy-pi.sh`. `/etc/default/tidepool` (the `EnvironmentFile`) is **not** in git — create it by hand on first setup:

```bash
ssh $PI 'sudo tee /etc/default/tidepool > /dev/null <<EOF
PORT=4589
MCP_PORT=4590
TIDEPOOL_REGISTRY=/mnt/ssd/tidepool-registry
TIDEPOOL_WORKSPACE=sandbox
TIDEPOOL_DB=/opt/tidepool/data/board.sqlite
TIDEPOOL_WORKER_LOGS=/opt/tidepool/worker-logs
TIDEPOOL_VAPID_SUBJECT=mailto:<owner-email>
TIDEPOOL_VAPID_PUBLIC_KEY=<generated>
TIDEPOOL_VAPID_PRIVATE_KEY=<generated>
TIDEPOOL_GITHUB_TOKEN_FILE=/home/masaki/.tidepool/github-token
TIDEPOOL_PUBLIC_ORIGINS=https://raspberrypi.tailc0084f.ts.net:8443
EOF
sudo chmod 600 /etc/default/tidepool && sudo chown root:root /etc/default/tidepool'
```

**`TIDEPOOL_PUBLIC_ORIGINS` must be set before the board's first boot** (issue #153 / ADR 0036). Cookies are per-origin, so the board has to know the URLs it is published at — it cannot derive them. First boot issues the token and prints one bootstrap URL per known origin, once; boot without this set and only the loopback URL is printed, and the phone's way in is gone until you rotate (which throws away the token you just issued).

## 5b. The board's credential (issue #153 / ADR 0036)

The human surface — WebUI, `/api`, and the management MCP mounted there — is guarded by one board secret. There is nothing to create here: the **first boot issues it and prints it to the journal once**, and the board keeps only the hash (`~/.tidepool/api-token`, mode 600). It cannot be shown again.

```bash
ssh $PI 'journalctl -u tidepool.service --no-pager | grep -A6 "a board token was issued"'
```

Save the token where you keep secrets, then open the printed bootstrap URL once per origin per device. Issue, rotation, recovery ordering, and **the management MCP's re-registration** all live in one place — [docs/human-surface-credential.md](../../../../docs/human-surface-credential.md). That doc is the canonical procedure; it is deliberately not copied here, because rotation happens independently of deploys and two copies would drift.

One operational constraint from ADR 0036 worth repeating: **do not configure the management MCP on a host that runs workers.** Its bearer header lives in plaintext in that host's `~/.claude.json`, and until #151 lands a `work`-profile worker's `Read` tool has no path floor to stop it being read.

**The GitHub machine-user token file** (issue #50 / ADR 0024) is a second, separate secrets file — the board's `tidepool-bot` PAT, read by the node process at runtime and injected per call into `gh`/`git` child envs. Unlike `/etc/default/tidepool`, it is read by the **service user** (`masaki`), not by PID1 — `root:root` would fail closed (unreadable → GitHub features off), and permissions wider than `600` are refused by `loadGitHubAuth` for the same fail-closed result. Create it as masaki:

```bash
ssh $PI 'mkdir -p ~/.tidepool && umask 077 && printf "%s\n" "<the PAT>" > ~/.tidepool/github-token'
```

Same terminal discipline as the VAPID key above: write it straight in, verify with `test -f` / `stat -c %a`, never print it back.

Generate the VAPID pair with `npx --yes web-push generate-vapid-keys` (run once on the Pi, `/opt/tidepool` must already exist — run this after the first `scripts/deploy-pi.sh`). `600 root:root` is correct and sufficient even though the service runs as `User=masaki` — systemd (PID1, root) reads `EnvironmentFile` before dropping privileges to spawn the process, so the running user never needs read access to the file itself.

**Never `cat`/echo the private key to a terminal you don't control** — write it straight into the heredoc above and confirm success with `wc -l` / `test -f`, not by printing the file back.

## 6. First deploy + service start

```bash
ssh $PI "sudo bash /mnt/ssd/tidepool/scripts/deploy-pi.sh"
ssh $PI "sudo systemctl daemon-reload && sudo systemctl enable --now tidepool.service"
```

## 7. tailscale serve (tailnet-only, no Funnel)

```bash
ssh $PI "sudo tailscale serve --bg --https=8443 http://127.0.0.1:4589"
```

Pick a port that doesn't collide with whatever else is already served (check `sudo tailscale serve status` first). Confirm the existing Funnel entry for other services (e.g. context-vault) is untouched afterward.

## 8. Run the verify + smoke-test scripts

See the main SKILL.md — same scripts as a routine deploy, just more informative the first time since nothing has been proven to work yet.
