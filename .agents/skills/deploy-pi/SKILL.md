---
name: deploy-pi
description: Deploy tidepool code changes to its production Raspberry Pi (masaki@100.78.52.97, tailnet), verify the deploy, and troubleshoot a stuck deploy or a board that stops picking up tasks. Invoke explicitly via /deploy-pi — do not self-trigger from conversational context (this skill takes real production actions: SSH, systemctl, git push).
disable-model-invocation: true
---

Deploys tidepool source (this repo) to its systemd-managed production instance on the Raspberry Pi. Covers the routine update-deploy path; first-time/new-Pi setup and troubleshooting are split into reference files (below) since they're needed rarely — read them only when the situation calls for it.

## Topology (read once, applies to every deploy)

- Pi: `masaki@100.78.52.97` (already on tailnet, SSH key auth)
- Source of truth: `/mnt/ssd/tidepool` on the Pi (git clone, exFAT — fine for git, weak for exec bits/native modules/symlinks)
- Runtime copy: `/opt/tidepool` (ext4) — `npm install`'d, what `tidepool.service` actually runs. Never edit here directly except for throwaway debugging (see troubleshooting.md); it's overwritten wholesale on every deploy.
- Sibling repo: `/mnt/ssd/tidepool-registry` (agents/authority/workspaces config, `TIDEPOOL_REGISTRY`) — separate GitHub repo, separate git history
- Service: `tidepool.service` (single systemd unit — WebUI + `/api` + `/mcp` + scheduler + agent spawning, all one process per ADR-0001)
- Secrets: `/etc/default/tidepool` (EnvironmentFile, 600 root:root, not in git — VAPID keys, `TIDEPOOL_REGISTRY` path, etc.) plus `/home/masaki/.tidepool/github-token` (600 masaki:masaki — the board's machine-user PAT, ADR 0024; read at runtime by the service user, so root:root here would fail closed)
- Public URL: `https://raspberrypi.tailc0084f.ts.net:8443` (tailnet-only `tailscale serve`, no Funnel — do not change this to Funnel without asking; it's a private single-user tool by design)
- `context-vault-mcp.service` / `context-vault-auth.service` also run on this Pi, independently, on different ports (8091/8092). A tidepool deploy must never touch them — always confirm they're still `active` after any tidepool work (the verify script below does this).

## Routine update deploy

The common case: source has changed, ship it.

**Push first.** The Pi pulls from GitHub (`origin main`), never from this dev machine directly — a commit made locally (including by this session) is invisible to the Pi until it's actually pushed. This is easy to miss: `git status` on the dev machine says "up to date" relative to its own `origin/main` remote-tracking ref, which only updates on a `push` or `fetch`, so a forgotten push doesn't look like a problem locally. Confirm and push before touching the Pi:

```bash
git log origin/main..HEAD --oneline   # anything listed here hasn't been pushed yet
git push origin main
```

Then deploy:

```bash
ssh masaki@100.78.52.97 "cd /mnt/ssd/tidepool && git pull -q origin main && sudo bash scripts/deploy-pi.sh"
```

`scripts/deploy-pi.sh` (committed in this repo's root) rsyncs `/mnt/ssd/tidepool` → `/opt/tidepool` (excluding `node_modules`, `.env*`, `data/`, `worker-logs/`, `board.sqlite` — these are runtime state, never wiped), runs `npm install` (full, including devDependencies — `tsx` runs the TS directly at runtime, there is no build step), installs the systemd unit if it changed, restarts `tidepool.service`, and self-verifies (`systemctl is-active` + a few seconds' grace). It exits non-zero and dumps `systemctl status` on failure.

If `tidepool-registry` also changed (agent definitions, authority profiles, workspaces), pull it too — it's a separate repo and separate clone:

```bash
ssh masaki@100.78.52.97 "cd /mnt/ssd/tidepool-registry && git pull -q origin main"
```

No service restart needed for a registry-only change — it's read fresh from disk at every task spawn (`loadRegistry`). It **is** read once at board boot to resolve the board's own default workspace (`main.ts`'s `workspaceConfig()`), so a registry change that removes/renames the board's own default workspace does need a `tidepool.service` restart to take effect for that specific path.

## After every deploy: verify

```bash
bash .agents/skills/deploy-pi/scripts/verify-deploy.sh
```

Checks: `tidepool.service` + both context-vault services are `active`; WebUI/API respond 200 over the tailnet URL; `/mcp` and the WebUI/API port are still `127.0.0.1`-only (never `0.0.0.0` — that's how MCP tool calls would leak onto the tailnet); tailscale serve config is intact; **`/mnt/ssd/tidepool`'s checked-out commit on the Pi matches this dev machine's local `HEAD`** (catches exactly the "looked healthy but was still running yesterday's code" failure — a service restart on unchanged/stale source passes every health check above while silently not shipping anything). Fails loud with the relevant `journalctl`/`ss`/`git log` output on any mismatch.

If it's the first deploy since a meaningful behavior change (scheduler, registry, worker spawn), also run the smoke test:

```bash
bash .agents/skills/deploy-pi/scripts/smoke-test.sh
```

Registers a real `work` task, forces immediate pickup (task registration alone does **not** trigger pickup — see troubleshooting.md's polling note), waits for the default agent (`tako`) to run it end-to-end via the real `claude` CLI, and prints the handoff doc. Takes ~30-60s and costs one real agent session — skip it for routine deploys that don't touch scheduler/registry/worker code.

The smoke-test task can't be deleted afterward (`events` table is append-only by DB trigger — intentional, not a bug). If it clutters the board, rename its title with a prefix instead of trying to delete it — see troubleshooting.md.

For changes that touch the **GitHub-facing** path (machine-user identity, PR creation, merge, commit authorship — issues #50/#53 territory), the sandbox smoke test isn't enough: see [references/board-e2e-test.md](references/board-e2e-test.md) for the full task → PR → merge E2E against the real `tidepool-registry` repo, including the identity assertions and the mandatory cleanup.

## First-time setup / new Pi

See [references/first-time-setup.md](references/first-time-setup.md) — cloning both repos, systemd unit, VAPID keys, `gh`/`claude` CLI install plus the interactive login step that only the user can do, tailscale serve, sandbox workspace git-init. Not needed for a routine deploy.

## Something's wrong

See [references/troubleshooting.md](references/troubleshooting.md) — covers: registry `authorityProfileSchema` crashes, the sandbox workspace needing to actually be a git repo, board pickup silently stuck (throttle fail-closed — the most likely culprit if a deploy looks healthy but nothing gets picked up), and generally-useful debugging commands (live journal follow, querying `board.sqlite` directly since the Pi has no `sqlite3` CLI, reproducing the exact systemd execution environment with `systemd-run`).
