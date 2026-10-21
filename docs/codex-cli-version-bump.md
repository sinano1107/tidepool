# Raising the pinned Codex CLI version

The board runs one verified `codex` CLI version per Harness, and the host stays on it (ADR 0186).
For Codex that version is `CODEX_APP_SERVER_VERSION` in `src/codex-app-server.ts`. Raising it is a
deliberate change that passes the conformance test first (ADR 0186 決定7). Do it in the Lima VM on
the Mac: the test needs a ChatGPT login, so CI cannot run it. Driving the VM is covered in
[machine-setup.md](agents/machine-setup.md#linux-devtest-in-the-lima-vm).

Run every step from the Mac, in this order. `<version>` is the CLI version you are moving to, as a
bare number (`0.151.0`).

## 1. Bring the VM checkout to `main`

Update the checkout and its dependencies, as in [Update Tidepool](mac-first-boot.md#update-tidepool):

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && git pull && npm install'
```

## 2. Install the new version in the VM

Unpack the npm platform package next to the current version and point `~/.local/bin/codex` at it.
Don't install it globally:

```bash
limactl shell tidepool -- bash -lc 'd=~/.local/share/codex/<version> && mkdir -p $d && cd $d && npm pack --silent @openai/codex@<version>-linux-arm64 && tar xzf openai-codex-<version>-linux-arm64.tgz --strip-components=3 package/vendor/aarch64-unknown-linux-musl && rm openai-codex-<version>-linux-arm64.tgz && ln -sfn $d/bin/codex ~/.local/bin/codex && ~/.local/bin/codex --version'
```

The old version stays in `~/.local/share/codex/`. To go back, point the link at its `bin/codex`.

## 3. Point the VM checkout's pin at the new version

The board refuses to pick up Codex work, and to read Codex usage, on a version other than
`CODEX_APP_SERVER_VERSION`. Change it in the VM checkout only:

```bash
limactl shell tidepool -- bash -lc 'sed -i "s/^export const CODEX_APP_SERVER_VERSION = .*/export const CODEX_APP_SERVER_VERSION = \"codex-cli <version>\";/" ~/tidepool/src/codex-app-server.ts'
```

Then take the feature snapshot again at the new version. Run the commands in the comment above
`CODEX_FEATURE_SNAPSHOT` in `src/codex-worker.ts` in the VM, and write the output into
`FEATURE_STATES` in the VM checkout. Without this, step 4's containment preflight fails on a
feature mismatch.

Keep both changes until step 8's PR merges, then put the files back with
`git -C ~/tidepool checkout src/codex-app-server.ts src/codex-worker.ts` before pulling.

## 4. Start the board and see the containment preflight hold

```bash
caffeinate -i -s limactl shell tidepool -- bash -lc '~/tidepool/scripts/vm-board.sh'
```

The board runs the Codex containment preflight at boot and on every pickup. It holds if no
"codex Harness containment is not established" question appears on the board. If that question
appears, its text names the surface the new CLI changed: the version, a skill, the hook, the
developer instructions, the AGENTS.md layer, or a feature. No later step needs the board.

If the board fails at boot on a database error, start this run on a fresh database as in
[the Claude handbook's step 3](claude-cli-version-bump.md#3-start-the-board-and-see-the-containment-probe-hold).

## 5. Run the interview-room canary

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/interview-room-canary.sh local'
```

Read the Codex rows. The deploy-pi skill explains how to read the verdict, in its
[interview-room canary](../.agents/skills/deploy-pi/SKILL.md) section.

## 6. Run the conformance test

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && CODEX_HOME=~/.tidepool/codex systemd-run --user --scope -p Delegate=yes -- npx tsx scripts/codex-cli-conformance.ts'
```

The test sends real output from the new CLI through the board's own Board calls and read
functions. It prints one row per surface as a Markdown table:

- `codex --version` and the App Server method and response schemas, checked by the board's
  compatibility check (ADR 0098 決定4)
- `account/rateLimits/read` read as usage numbers
- the account state read by the board's authentication reading
- the containment preflight (`checkCodexCapability`)
- every openai seed row's model in `model/list`, and a nonexistent model id read as a row
  refusal (ADR 0184 決定3)
- the efforts every non-hidden model advertises in `model/list`, against the five values of
  `EFFORT_LEVELS` in `src/effort.ts` (ADR 0216 決定1). `ultra` is not an effort (決定2). If the
  values differ, decide whether to change the vocabulary or split it per provider
- a request to `registry.npmjs.org`, listed in the allowlist, gets through, and a request to
  `example.org`, outside it, is refused with 403 `x-proxy-error: blocked-by-allowlist` (ADR 0256
  決定3). Both run `curl` inside `codex sandbox -P tidepool-work` with the permission profile the
  board gives a worker (`permissionConfig()`) plus `features.network_proxy=true`
- the AGENTS.md layer: with an AGENTS.md in a disposable `CODEX_HOME` and another in the
  workspace, `codex debug prompt-input -c project_doc_max_bytes=0` carries exactly one
  `# AGENTS.md instructions` heading. The containment preflight looks for this heading (ADR 0148).
  The board's own `CODEX_HOME` is not touched
- each openai seed row runs one minimal `codex exec --json` turn at this version, read by the
  worker's output reading as completed (ADR 0187 決定4)

The exit code is non-zero if any row is 不合格. It needs
the `Delegate=yes` scope for the same reason as the board: every Board call runs in its own
container.

**Not covered.** Two surfaces cannot be reproduced on demand, so they are unverified. Both are left
to the existing fail-closed handling (ADR 0186 決定7):

- A usage-cap interruption (429): the `turn.failed` line and the usage read after it (ADR 0261).
- An expired credential: `account/read` with no account, or the rate-limit read refused with
  `401 Unauthorized` (ADR 0127 決定2). The test only sees a working login.

## 7. Run the reader-cap canary

Check that Codex still takes a full-budget MCP response whole, once per openai seed row (ADR 0195
決定7). A missing middle or tail marker is 不合格. 観測なし is not an observation of the cap: fix
the cause in its detail and run the canary again:

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && CODEX_HOME=~/.tidepool/codex npx tsx scripts/reader-cap-canary.ts'
```

The canary also prints a Claude Code row. That row belongs to the
[Claude CLI version bump](claude-cli-version-bump.md).

## 8. Open the PR that changes the pinned version

Write `codex-cli <version>` into `CODEX_APP_SERVER_VERSION` and the snapshot from step 3 into
`FEATURE_STATES`, and paste the tables from steps 6 and 7 into the PR description.
