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

**Also trust the board's own cwd once, interactively** (issue #81 / ADR-0028): the hourly usage throttle scrapes `/usage` from an *interactive* `claude --safe-mode` session run in `/opt/tidepool`, and the interactive TUI shows a folder-trust gate ("Is this a project you trust?") plus one-time onboarding modals that block the input prompt until dismissed. Once, as masaki: `ssh $PI`, then `cd /opt/tidepool && claude`, accept "Yes, I trust this folder", dismiss any what's-new/onboarding modal, and quit. This persists in `~/.claude.json` (`projects["/opt/tidepool"].hasTrustDialogAccepted: true`, home-side — survives redeploy, since deploy only rsyncs `/opt/tidepool`). Skip it and the board silently fails the throttle closed (`checkUsage` times out → null) and picks up nothing — see troubleshooting.md's first entry. (A dismissed what's-new can re-appear after a `claude` update; same one-time fix.)

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
EOF
sudo chmod 600 /etc/default/tidepool && sudo chown root:root /etc/default/tidepool'
```

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
