# Raising the pinned Claude CLI version

The board runs one verified `claude` CLI version per Harness, and the host stays on it (ADR 0186).
Raising that version is a deliberate change that passes the conformance test first (ADR 0186
決定7). Do it in the Lima VM on the Mac: the test needs a subscription login, so CI cannot run it.
Driving the VM is covered in [machine-setup.md](agents/machine-setup.md#linux-devtest-in-the-lima-vm).

Run every step from the Mac, in this order. `<version>` is the CLI version you are moving to.

## 1. Install the new version in the VM

```bash
limactl shell tidepool -- bash -lc '~/.local/bin/claude install <version> && ~/.local/bin/claude --version'
```

## 2. Start the board and see the containment probe hold

```bash
caffeinate -i -s limactl shell tidepool -- bash -lc '~/tidepool/scripts/vm-board.sh'
```

The board runs the containment probe at boot and on every pickup. It holds if no
"worker containment is not established — pickup is stopped" question appears on the board. If
that question appears, its text names the tools or settings the new CLI no longer honours. Keep the
board running for the next step.

## 3. Run the three canaries

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/containment-canary.sh local'
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/hook-canary.sh local'
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/tool-floor-canary.sh local'
```

The containment canary needs the board from step 2. The deploy-pi skill explains how to read each
canary's verdict: [containment](../.agents/skills/deploy-pi/SKILL.md#containment-canary-network-layer),
settings-floor and tool-floor.

## 4. Run the conformance test

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

**Not covered.** Two surfaces cannot be reproduced on demand, so they are unverified. Both are left
to the existing fail-closed handling (ADR 0186 決定7, ADR 0187 決定5):

- The 429 envelope: a usage-cap interruption (ADR 0104).
- The version-too-old refusal envelope (`api_error_code: claude_code_version_too_old`): a model
  that needs a CLI newer than the pinned version is usually not available at the time of the bump.
  If the field disappears, the session falls to an unreported exit (ADR 0145).

## 5. Open the PR that changes the pinned version

Change the pinned version and paste the table from step 4 into the PR description. The pin's single
location in the repo comes with #1276 (ADR 0186 決定5).
