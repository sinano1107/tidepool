# Machine setup

Everything the workflow calls is vendored under `.agents/skills/`, so a clone has it — except ponytail, which is a plugin, and the shell that decides which mode a session starts in. Both live outside this repo. Set them up once per machine.

## ponytail

**Claude Code** — `.claude/settings.json` declares the marketplace and enables the plugin, so a fresh clone picks it up. Nothing to do.

**Codex** — enable it on the Codex side. Codex discovers skills from `.agents/skills` and can disable them in `~/.codex/config.toml`, but has no per-repository way to require one, so the repo cannot declare this for you.

## Design and build sessions

The workflow runs ponytail off while deciding and `full` while building (see [workflow.md](./workflow.md)). Which one a session gets is decided at launch, by `PONYTAIL_DEFAULT_MODE`: the plugin's `SessionStart` hook re-reads it on every `startup`, `resume`, `clear`, and `compact`.

**Ponytail's own default is `full`** (`DEFAULT_MODE` in the plugin's `hooks/ponytail-config.js`, as of 4.9.0), so without the line below, grilling sessions run with ponytail on and argue you out of options before you have weighed them. A `defaultMode` in `~/.config/ponytail/config.json` takes precedence over that built-in, and the environment variable takes precedence over both — which is why setting it in the shell is enough, whatever the config file says.

```zsh
# Ponytail off unless a build session asks for it
export PONYTAIL_DEFAULT_MODE=off

claude-design() { PONYTAIL_DEFAULT_MODE=off  command claude "$@"; }
claude-build()  { PONYTAIL_DEFAULT_MODE=full command claude "$@"; }
codex-design()  { PONYTAIL_DEFAULT_MODE=off  command codex  "$@"; }
codex-build()   { PONYTAIL_DEFAULT_MODE=full command codex  "$@"; }
```

Grill and spec in a design session; ticket and build in a build one.

## Linux dev/test in the Lima VM

Worker-facing dev/test (worker containers, reclaim, Containment) — the contract suite and running
the board for real — happens on the Mac in the Lima VM, not on the Pi. Creating the VM and installing
its tools is [docs/mac-first-boot.md](../mac-first-boot.md); use that, don't repeat it here.

- Keep the checkout on the VM's own disk (`~/tidepool`) and `cd` right after `limactl shell` —
  see mac-first-boot's "Every VM shell starts with `cd`" for why.
- Run `npm run canary:container` under a `Delegate=yes` user scope
  (`systemd-run --user --scope -p Delegate=yes -- npm run canary:container`); a bare `limactl shell`
  session stops at the preflight check.
- `npm test` already runs on Linux in CI, so there's no need to run it in the VM too — the VM is
  for what CI doesn't cover: the contract suite, a real worker run, real CLI login.
- The Pi stays production-only: the real deploy (`docs/real-environment-trial.md`) and the contract
  suite re-run the deploy-pi skill does after a kernel / systemd / CLI update on the Pi (ADR 0099
  決定5 — that is production validation, not dev/test). Don't make checkouts there to test a change.

## If you skip this

Nothing breaks loudly. A design session with ponytail on still works — it just keeps steering you toward the smallest thing that could work, during the step where the point is to consider the alternatives first. That is why the grilling and spec steps are told to flag it (workflow.md), rather than the repo trying to enforce it.
