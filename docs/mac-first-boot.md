# Tidepool first boot on a Mac

This document currently covers registry preparation. The remaining Mac host setup belongs to issue #364.

## Prepare the registry on a Mac

Decide the environment before starting. `TIDEPOOL_REGISTRY` is required; the other values below are the defaults shared by boot and initialization.

| Setting | Default |
| --- | --- |
| `TIDEPOOL_AGENT` | `tako` |
| `TIDEPOOL_AUDITOR` | `fugu` |
| `TIDEPOOL_WORKSPACE` | `sandbox` |
| `TIDEPOOL_WORKSPACES_DIR` | `~/tidepool-workspaces` |

Set the registry clone path and any overrides in the shell that will start Tidepool:

```bash
export TIDEPOOL_REGISTRY="$HOME/tidepool-registry"
# Optional overrides:
# export TIDEPOOL_WORKSPACES_DIR="$HOME/tidepool-workspaces"
# export TIDEPOOL_WORKSPACE="sandbox"
# export TIDEPOOL_AGENT="tako"
# export TIDEPOOL_AUDITOR="fugu"
```

Create an empty private repository with your own GitHub credentials, then clone it to that path:

```bash
gh repo create YOUR_GITHUB_LOGIN/tidepool-registry --private
git clone git@github.com:YOUR_GITHUB_LOGIN/tidepool-registry.git "$TIDEPOOL_REGISTRY"
```

From the Tidepool checkout, seed the empty remote and create the initial local workspace:

```bash
npm run init-registry
```

With the defaults, the command confirms:

```text
Registry seeded with agent "tako", auditor "fugu", and workspace "sandbox".
```

Keep the same environment and start the board:

```bash
npm start
```

Open the WebUI and register the task printed by the init command.

### First task example

```text
Title: Resolve the README TODO
Purpose: Replace the TODO in sandbox/README.md with a short description of this workspace.
Completion criteria: README.md contains the description and the task reaches the merge question.
```

The expected manual path is pickup, completion, then the merge question for the purely-local workspace.

When you are ready to use your own repository, add it from the WebUI workspace registration screen using the clone entrance.
