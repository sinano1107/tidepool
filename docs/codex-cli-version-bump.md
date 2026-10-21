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
`FEATURE_STATES` in the VM checkout. Without this, step 5's containment preflight fails on a
feature mismatch.

Keep both changes until step 9's PR merges, then put the files back with
`git -C ~/tidepool checkout src/codex-app-server.ts src/codex-worker.ts` before pulling.

## 4. Re-read the Codex source

Two premises are checked by machine only in part or not at all, so read them in the source of the
new version: the `openai/codex` repository at the tag `rust-v<version>`, under `codex-rs/`. There is
no local checkout of it; read it on GitHub. Write the result of each read into step 9's PR
description.

**Model metadata, at its worst values** (ADR 0255 決定3). The backend sets the metadata values at
runtime and can change them in the middle of a session, so the pin fixes only which fields are
read, never their values. List every field of `ModelInfo` and every place that reads it. For each
field, take the most open value it can hold and read what that opens, and whether a floor that does
not depend on metadata covers it: the hook gate, the permission profile, or the sandbox (決定2).
The first baseline is the 0.147.0 enumeration in
[#760](https://github.com/sinano1107/tidepool/issues/760#issuecomment-6161684306); after that, the
previous bump's PR. Start from the difference against the baseline: fields added, and fields whose
readers changed. In the PR, list every field, what its worst value opens, and the floor that covers
it. Name any opened surface without a floor.

**Features that `apply_map` skips** (ADR 0135 決定4). `=false` does not reach a feature that the
vendor's `apply_map` skips by a hand-written list before `disable()`. `UNSETTABLE_FEATURES` in
`src/codex-worker.ts` copies that list. Machines catch only part of a change. A name added to the
list fails the type of `CODEX_FEATURE_SNAPSHOT` only if its default is `true`, because then it shows
up as `true` in step 3's snapshot. A name taken off the list fails nothing. Read the list at the
new version, update `UNSETTABLE_FEATURES` in the VM checkout if it moved, and put the list as
read, with what changed, in the PR.

## 5. Start the board and see the containment preflight hold

```bash
caffeinate -i -s limactl shell tidepool -- bash -lc '~/tidepool/scripts/vm-board.sh'
```

The board runs the Codex containment preflight at boot and on every pickup. It holds if no
"codex Harness containment is not established" question appears on the board. If that question
appears, its text names the surface the new CLI changed: the version, a skill, the hook, the
developer instructions, the AGENTS.md layer, or a feature. No later step needs the board.

If the board fails at boot on a database error, start this run on a fresh database as in
[the Claude handbook's step 3](claude-cli-version-bump.md#3-start-the-board-and-see-the-containment-probe-hold).

## 6. Run the interview-room canary

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && bash .agents/skills/deploy-pi/scripts/interview-room-canary.sh local'
```

Read the Codex rows. The deploy-pi skill explains how to read the verdict, in its
[interview-room canary](../.agents/skills/deploy-pi/SKILL.md) section.

## 7. Run the conformance test

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
- skill closure (ADR 0259 決定2・3): in a workspace with flat, nested, symlinked and ancestor
  skills, a skill in a disposable `CODEX_HOME`, and two unreadable `SKILL.md` files, the board's
  own enumeration and observation close every skill. `codex exec` with the worker's flags is
  pointed at a fake Responses endpoint, and its first request is captured twice: without the
  board's `skills.config` every readable skill's marker is in it, and with it no skill is listed
  at all (no `(file: …)` locator, so bundled skills count too). `errors[]` of `skills/list` names
  exactly the two unreadable files, which appear in neither `skills[]` nor a request (#1972). The
  exec uses the disposable `CODEX_HOME`, and the row fails if any request to the fake endpoint
  carries an `Authorization` header
- each openai seed row runs one minimal `codex exec --json` turn at this version, read by the
  worker's output reading as completed (ADR 0187 決定4)

The exit code is non-zero if any row is 不合格. It needs
the `Delegate=yes` scope for the same reason as the board: every Board call runs in its own
container.

**Not covered.** Two surfaces cannot be reproduced on demand, so they are unverified. Both are left
to the existing fail-closed handling (ADR 0186 決定7):

- A usage-cap interruption (429): the `turn.failed` line and the usage read after it (ADR 0261).
- An expired credential: `account/read` with no account, or the rate-limit read refused with
  `401 Unauthorized` (ADR 0127 決定1・2). The test only sees a working login.

## 8. Run the reader-cap canary

Check that Codex still takes a full-budget MCP response whole, once per openai seed row (ADR 0195
決定7). A missing middle or tail marker is 不合格. 観測なし is not an observation of the cap: fix
the cause in its detail and run the canary again:

```bash
limactl shell tidepool -- bash -lc 'cd ~/tidepool && export PATH="$HOME/.local/bin:$PATH" && CODEX_HOME=~/.tidepool/codex npx tsx scripts/reader-cap-canary.ts'
```

The canary also prints a Claude Code row. That row belongs to the
[Claude CLI version bump](claude-cli-version-bump.md).

## 9. Open the PR that changes the pinned version

Write `codex-cli <version>` into `CODEX_APP_SERVER_VERSION` and the snapshot from step 3 into
`FEATURE_STATES`, with any change to `UNSETTABLE_FEATURES` from step 4. In the PR description,
put the two reads from step 4 and paste the tables from steps 7 and 8.

## Premises that depend on the pin

The board's Codex code relies on these properties of the pinned CLI: its `-c` keys, CLI flags,
App Server methods and output shapes. Each is checked where the last column says. A premise
nothing checks is left to the board's fail-closed handling.

| Premise | ADR | Where it is checked |
| --- | --- | --- |
| `codex features list` matches `CODEX_FEATURE_SNAPSHOT` under the board's `-c` lines | ADR 0135 決定1, ADR 0108 追記 (#532) | The snapshot (step 3), then the containment preflight (step 5) |
| `--version` and the `account/read`, `account/rateLimits/read` and `model/list` request and response schemas | ADR 0098 決定4 | Conformance row `--version / App Server schema` (step 7) |
| Usage and the account state read from the App Server | ADR 0098 決定4, ADR 0127 決定1・2 | Conformance rows `usage` and `authentication` (step 7). An expired credential is not checked |
| An App Server in a fresh empty cwd reads no project layer | ADR 0206 決定1 | The containment preflight: a project hook would break the exact hook registration match |
| Every openai seed row's model is in `model/list`, and an unknown id reads as a row refusal | ADR 0184 決定3, ADR 0187 決定4 | Conformance row `model/list → openai seed rows` (step 7) |
| The `exec --json` events: `turn.completed` with usage, and `turn.failed` | ADR 0187 決定4, ADR 0261 | Conformance seed rows (step 7). The 429 `turn.failed` of a usage cap is not checked |
| `turn.completed.usage` always carries `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` and `output_tokens` (codex fills `cache_write_input_tokens` with a serde default) | #2410 | Conformance seed rows (step 7) |
| A turn that received no usage report writes an all-zero `turn.completed.usage` (`Usage::default()`), which the board reads as missing | #2426 | Conformance seed rows (step 7): the worker's usage normalization fails them |
| `turn.completed.usage` sums the parent thread's turn sampling responses only: subagent (child thread) consumption, remote compaction V2 calls and the websocket prewarm are not in it, and V1 compaction (`remote_compaction_v2=false`) gets 404 from the ChatGPT backend | ADR 0297 決定1 (#2427, #2430) | Not checked: it needs a model run that compacts and spawns a subagent. #2430's comment has the run |
| The worker's exec flags: `--ask-for-approval never`, `exec --json --ephemeral --ignore-user-config --ignore-rules --strict-config --dangerously-bypass-hook-trust` | ADR 0098 決定3 | Conformance row `skill closure` runs them without `--dangerously-bypass-hook-trust`; the seed rows run part of them (step 7) |
| Every spawn `-c` key parses under `--strict-config` | ADR 0142 決定1 | The containment preflight (step 5) |
| The hook gate's registration and the `hooks/list` shape | ADR 0130 決定3 (#734) | The containment preflight (step 5) |
| The PreToolUse hook's stdin carries `agent_id` only for a subagent | ADR 0130 決定1 | Not checked: which call it selects cannot be observed without a model call (決定3) |
| `mcp_servers.tidepool.default_tools_approval_mode="approve"` takes effect | ADR 0129 決定1 | Not checked |
| `developer_instructions` is the board's layer above the task | ADR 0124 決定4 | The containment preflight's developer marker (step 5) |
| The permission profile keys and `codex sandbox -P` | ADR 0256 決定3 | Conformance domain rows (step 7) and the containment preflight (step 5) |
| An allowlisted domain is reached and an unlisted one is refused with 403 | ADR 0256 決定3 | Conformance rows `allowed domain reached` and `unlisted domain → 403 blocked-by-allowlist` (step 7) |
| Codex takes a full-budget MCP response whole | ADR 0195 決定7 | Reader-cap canary (step 8) |
| The models advertise exactly the board's effort vocabulary | ADR 0216 決定1 | Conformance row `effort vocabulary` (step 7) |
| Only the global AGENTS.md layer is read, under `project_doc_max_bytes=0` | ADR 0148, #890 | Conformance row `AGENTS.md layer` (step 7) and the containment preflight (step 5) |
| The ambient instruction entrances stay closed | ADR 0156 決定1 | The containment preflight (step 5) |
| `agents.max_concurrent_threads_per_session` takes effect whatever the multi-agent version | ADR 0134 決定3 | The key parses (step 5); its effect is not checked |
| `skills/list` returns every skill `exec` loads, and a path's `enabled=false` closes it | ADR 0259 決定2・3, #1972 | Conformance row `skill closure` (step 7) |
| `agents.default_subagent_model` does not reach a worker from outside the board's `CODEX_HOME` | ADR 0287 決定4 | Not checked |
| The `ModelInfo` fields that are read, at their worst values | ADR 0255 決定3 | The source re-read (step 4) |
| The names `apply_map` skips | ADR 0135 決定4 | The source re-read (step 4); a name added to the list also fails the snapshot's type if its default is `true` |
| The Interview root's floor holds for Codex | ADR 0273 決定2 (#2197) | Interview-room canary (step 6) |
