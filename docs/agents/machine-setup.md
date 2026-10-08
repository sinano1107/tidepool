# Machine setup

The workflow's skills, including ponytail, are checked in under `.agents/skills/`. Claude Code uses `.claude/skills/` symlinks to the same files. A clone includes both providers' `ponytail-implementer` definitions under `.claude/agents/` and `.codex/agents/`.

## ponytail

ponytail used to be a plugin. A machine that still has it gets the ruleset injected by the plugin's hooks into every session and sub-agent — design steps included — on top of the repo-local skill. [workflow.md](./workflow.md#ponytail) defines when the skill applies.

**Claude Code** — nothing to do: `.claude/settings.json` sets `ponytail@ponytail` to `false`, and the project value overrides a user-level `true`. To drop a user-scope install anyway: `claude plugin uninstall ponytail@ponytail`.

**Codex** — there is no project-level override, so remove it on each machine:

```sh
codex plugin remove ponytail@ponytail
codex plugin marketplace remove ponytail
```

Then delete the `[hooks.state."ponytail@ponytail:…"]` tables from `~/.codex/config.toml` by hand — the CLI leaves them behind.

## Linux dev/test in the Lima VM

Worker-facing dev/test (containers, reclaim, Containment) — the contract suite and running
the board for real — happens on the Mac in the Lima VM, not on the Pi. Creating the VM and installing
its tools is [docs/mac-first-boot.md](../mac-first-boot.md); use that, don't repeat it here.

- Keep the checkout on the VM's own disk (`~/tidepool`) and `cd` right after `limactl shell`:
  the shell opens in the Mac's current directory, mounted read-only inside the VM.
- Anything that creates worker containers needs a `Delegate=yes` user scope; under a bare
  `limactl shell` session the board raises a cgroup EACCES question on every Harness and picks
  nothing up, and the canary stops at the preflight check.
  - Start the board with `scripts/vm-board.sh`, as in
    [Start the board](../mac-first-boot.md#start-the-board), not with a bare `npm start`. It runs in
    the foreground and stops when the `limactl shell` session ends — `setsid` / `nohup` don't keep
    it alive (ADR 0090 決定2).
  - Run the canary as
    `systemd-run --user --scope -p Delegate=yes -- npm run canary:container`.
- The VM covers what CI never runs — the contract suite, a real worker run, real CLI login — and
  `npm test` when a failure shows up on Linux but not on the Mac: CI reruns green and keeps no
  transcript, while the VM repeats it and takes instrumentation (#773).
- The Pi stays production-only: the real deploy (`docs/real-environment-trial.md`) and the contract
  suite re-run the deploy-pi skill does after a kernel / systemd / CLI update on the Pi (ADR 0099
  決定5 — that is production validation, not dev/test). Don't make checkouts there to test a change.

### Triage sweep base VM

`/triage-sweep` gives each sub-agent that needs Linux its own clone of `tidepool-sweep-base`, a
stopped copy of the `tidepool` VM. Lima cannot clone a running instance, hence the stopped base;
clones are copy-on-write on APFS, so they take no disk until they write, start in about 20 s, and
inherit the base's `claude` / `gh` logins.

Create it — and recreate it the same way when the base's CLIs or logins have gone stale — while
nothing is running in `tidepool`:

```zsh
limactl stop tidepool
limactl delete -f tidepool-sweep-base   # recreating only
limactl clone tidepool tidepool-sweep-base
limactl start tidepool
```
