---
name: triage-sweep
description: Triage the newest N needs-triage / needs-info issues unattended — related issues clustered, clusters investigated in parallel sub-agents, each issue left with a comment — a brief, grilling questions, findings, or a test-only PR pinning a verdict — and the auto-triaged label for the human to act on.
disable-model-invocation: true
argument-hint: "<N>"
---

# Triage sweep

`/triage`'s per-issue evaluation, run without the maintainer in the loop and stopped where the maintainer's judgement starts. Every issue it evaluates ends on `auto-triaged` with a comment; moving the state label is the maintainer's step ([triage-labels.md](../../../docs/agents/triage-labels.md)).

`$ARGUMENTS` is N, the number of issues to process this run.

## 1. Check the session

- **ponytail.** A brief is spec writing — deciding, not building ([workflow.md](../../../docs/agents/workflow.md)). If the ponytail ruleset is in your context, stop and ask the user to relaunch with `claude-design`: the `SubagentStart` hook would carry the mode into every sub-agent this run spawns.
- **Session link.** Read `CLAUDE_CODE_BRIDGE_SESSION_ID` from the environment. When it is set, the link is `https://claude.ai/code/<that id>` — the page shows the sub-agents' transcripts too, so this one link covers the whole run. When it is unset (Remote Control off, or another provider), the comments go out without a link.
- **Effort.** Sub-agents inherit the session's effort. If `$CLAUDE_EFFORT` is below `medium`, ask the user to run `/effort medium` before going on.
- **Fetch.** `git fetch origin main` once here; every sub-agent branches its worktree from `origin/main`.
- **Base VM.** Note whether `limactl list` shows `tidepool-sweep-base` ([machine-setup.md](../../../docs/agents/machine-setup.md#triage-sweep-base-vm)); pass that to every sub-agent.

## 2. Pick the issues

List open issues carrying `needs-triage` or `needs-info`, drop any carrying `auto-triaged` or `verify:production`, sort by number descending, and take the first N. Fewer than N left means the queue is drained — take what there is.

## 3. Cluster

Read each picked issue in full (`gh issue view <n> --json title,labels,body,comments`). Group them into **clusters**: two issues share a cluster when they share a subject, touch the same code area or ADR, or when one's outcome is an input to the other's — a duplicate, or a dependency nobody has drawn as blocked-by. An issue related to nothing is a cluster of one.

The cluster is how consistency is bought: one sub-agent judges related issues in sequence, so it cannot contradict itself across them, while unrelated clusters run in parallel. When unsure, merge — a wrong merge costs wall-clock, a wrong split costs contradicting judgements.

Print the clusters to the user — issue numbers and a one-line reason each — then go on without waiting.

## 4. Dispatch

One general-purpose sub-agent per cluster on Opus 5.5 (`model: opus`), at most four running at once; start the next as one returns. The main tier is enough: every outcome is read by the maintainer before anything moves. Each prompt carries:

- the absolute path of [PROCEDURE.md](PROCEDURE.md) (this skill's base directory + `PROCEDURE.md`), with the instruction to read it first and follow it;
- the cluster's issue numbers, newest first, and the reason they were grouped;
- the session link, or the fact that there is none;
- whether `tidepool-sweep-base` exists.

After dispatching, end your turn. Each sub-agent's report arrives as its own message; act on "start the next" and on step 5 only from those.

## 5. Report

When every sub-agent has returned, print one table — issue, outcome, recommended next step, comment URL — then the issues the sub-agents filed and the Pin PRs they opened, then anything a sub-agent reports it could not clean up (a worktree, a VM clone), with the command that removes it.
