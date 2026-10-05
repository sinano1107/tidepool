# Raising the pinned Claude CLI version

The board runs one verified `claude` CLI version per Harness, and the host stays on it (ADR 0186).
Raising that version is a deliberate change that passes the conformance test first (ADR 0186
決定7). Do it in the Lima VM on the Mac: the test needs a subscription login, so CI cannot run it.
Driving the VM is covered in [machine-setup.md](agents/machine-setup.md#linux-devtest-in-the-lima-vm).

Run every step from the Mac, in this order. `<version>` is the CLI version you are moving to.

First bring the VM checkout to the current `main` with its dependencies, as in
[Update Tidepool](mac-first-boot.md#update-tidepool):

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && git pull && npm install'
```

## 1. Install the new version in the VM

```bash
limactl shell tidepool -- bash -lc '~/.local/bin/claude install <version> && ~/.local/bin/claude --version'
```

## 2. Point the VM checkout's pin at the new version

The board refuses to pick up work on a version other than the one `~/tidepool/claude-cli-version`
names. Change it in the VM checkout only:

```bash
limactl shell tidepool -- bash -lc 'echo <version> > ~/tidepool/claude-cli-version'
```

A VM restart installs whatever version this file names. Keep the change until step 6's PR merges,
then put the file back with `git -C ~/tidepool checkout claude-cli-version` before pulling.

## 3. Start the board and see the containment probe hold

```bash
caffeinate -i -s limactl shell tidepool -- bash -lc '~/tidepool/scripts/vm-board.sh'
```

The board runs the containment probe at boot and on every pickup. It holds if no
"claude-code Harness containment is not established" question appears on the board. If that
question appears, its text names the tools or settings the new CLI no longer honours, or the
mismatch between the pinned version and `claude --version`. Keep the board running for the next
step.

If the board fails at boot on a database error (e.g. `SqliteError: NOT NULL constraint failed`),
the database `~/.tidepool/env` points at was written by an older checkout. Don't delete it; start
this run on a fresh database instead:

```bash
caffeinate -i -s limactl shell tidepool -- bash -lc 'source ~/.tidepool/env && export TIDEPOOL_DB=~/.tidepool/version-bump-<version>.sqlite PATH="$HOME/.local/bin:$PATH" && cd ~/tidepool && exec systemd-run --user --scope --unit tidepool-board -p Delegate=yes -- npm start'
```

## 4. Run the three canaries

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/containment-canary.sh local'
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/hook-canary.sh local'
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/tool-floor-canary.sh local'
```

The containment canary needs the board from step 3. The deploy-pi skill explains how to read each
canary's verdict: [containment](../.agents/skills/deploy-pi/SKILL.md#containment-canary-network-layer),
settings-floor and tool-floor.

## 5. Run the conformance test

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && systemd-run --user --scope -p Delegate=yes -- npx tsx scripts/claude-cli-conformance.ts'
```

The test sends real output from the new CLI through the board's own Board calls and read
functions. It prints one row per surface as a Markdown table:

- the init line (`tools` / `mcp_servers` / `memory_paths` / `skills`), taken with the containment
  probe's flags
- the result line's `usage`
- a nonexistent model id read as a row refusal (404)
- the usage screen read as numbers
- one draft-client call and one translation-client call
- each anthropic seed row (ADR 0187 決定4) runs one minimal turn at this version, judged by the
  board's own model probe

The exit code is non-zero if any row is 不合格. It needs the `Delegate=yes` scope for the same reason
as the board: every Board call runs in its own container.

Then check that the MCP readers still take a full-budget response whole (ADR 0195 決定7): Claude Code
once, and Codex once per openai seed row. A missing middle or tail marker is 不合格:

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && CODEX_HOME=~/.tidepool/codex npx tsx scripts/reader-cap-canary.ts'
```

**Not covered.** Two surfaces cannot be reproduced on demand, so they are unverified. Both are left
to the existing fail-closed handling (ADR 0186 決定7, ADR 0187 決定5):

- The 429 envelope: a usage-cap interruption (ADR 0104).
- The version-too-old refusal envelope (`api_error_code: claude_code_version_too_old`): a model
  that needs a CLI newer than the pinned version is usually not available at the time of the bump.
  If the field disappears, the session falls to an unreported exit (ADR 0145).

## 6. Open the PR that changes the pinned version

Write the new version into `claude-cli-version` at the repo root and paste both tables from step 5
into the PR description.

If the new version brings a new model family, add its prefix to `FAMILY_PREFIXES` in
`src/claude-model-alias.ts`; if the family ranks above the current top, also move `TOP_FAMILY` to
it. Until then, its rows cannot serve agents that have an advisor (ADR 0200 決定6).
