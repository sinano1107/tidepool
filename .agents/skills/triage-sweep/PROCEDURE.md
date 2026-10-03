# Triage sweep — one cluster

You triage a **cluster** of related tidepool issues, unattended. Nobody answers questions during the run: the maintainer reads what you post afterwards and moves the issues on from there. Take the cluster's issues one at a time, in the order given, and carry what you learn forward — the cluster exists so related issues get consistent judgements.

This is `/triage`'s per-issue evaluation with its maintainer checkpoints replaced by posting: where `/triage` recommends and waits, you post and label; where it grills, you post the questions the grilling would ask.

## Workspace

- **Worktree.** `git worktree add --detach "$(mktemp -d)/sweep" origin/main` (the parent has fetched), and investigate there — the main checkout belongs to other sessions and its branch moves under you. `git rev-parse --short HEAD` in the worktree is the **investigated SHA** every comment cites.
- **Throwaway tests.** Reproduce a claim with a test written in the worktree; it dies with the worktree. To run tests there, symlink the main checkout's `node_modules` into the worktree — or `npm ci` when `package-lock.json` differs between the two — and remove the link before removing the worktree.
- **Lima VM**, when the issue's subject only shows on Linux or in a real worker run (containers, reclaim, Containment, a real CLI — [machine-setup.md](../../../docs/agents/machine-setup.md#linux-devtest-in-the-lima-vm)):
  1. `limactl clone tidepool-sweep-base sweep-<issue> --start` — your own disposable VM. When the parent reported no base VM, the issue's outcome is **skipped**, reason "no tidepool-sweep-base".
  2. Get the code in: `git archive --format=tar.gz -o <tmp>/src.tar.gz HEAD` in the worktree, `limactl copy <tmp>/src.tar.gz sweep-<issue>:/tmp/`, extract under `/tmp/<issue>`, `npm ci` there.
  3. Put every guest-side command inside a quoted `bash -lc '…'` — an unquoted `~` expands on the Mac.
  4. Reach a board you start in the clone from inside the guest (`curl` within `limactl shell`). Lima forwards guest ports to the same port on the Mac, where clones running side by side collide.
  5. `limactl delete -f sweep-<issue>` when the issue is done.
- **Cleanup.** Remove the worktree (`git worktree remove --force <path>`) when the cluster is done.

## Per issue

### 1. Gather

Read the issue in full — `gh issue view <n> --json title,labels,body,comments`. Earlier triage comments, including earlier sweep comments, are settled ground: build on them and re-ask nothing they resolved.

Explore the code in the worktree in `CONTEXT.md`'s vocabulary, and read the ADRs in the area. Then two checks:

- **Redundancy** — search for an existing implementation of the asked-for behaviour by domain concept, not just the issue's wording. Note where you looked.
- **Prior rejection** — read `.out-of-scope/*.md` and note any that resembles the request.

Read the open issues this one links to and any you meet touching the same area. A sweep comment already on one of them is a judgement your own must agree with — or, when you find it wrong, name it and say why.

### 2. Verify

Check the claim before judging it. A bug: reproduce it from the code path or a throwaway test. A `needs-info` issue: make the observation it asks for, wherever the worktree or a VM clone can show it. An observation only a running board can give — production behaviour, whether something hurts over time — is not yours to make; it decides the outcome below.

### 3. Decide the outcome

Exactly one:

- **Agent Brief** — the record (ADRs, `CONTEXT.md`, the issue thread, your verification) settles everything an implementer needs. Write it in the format of `AGENT-BRIEF.md` in the sibling `triage` skill directory, under the comment's outcome heading in place of the brief's own `## Agent Brief` line. Next step: move to `ready-for-agent`.
- **Questions for grilling** — the brief would take a decision the record does not ground, or there is a fork with two or more viable options. This is where `/triage` would grill. Post what you established, then each question as

  ```
  ❓ **Q<n>** - **<title>**: <body>

  ➡️ <recommended answer>
  ```

  Next step: grill.
- **Findings** — a `needs-info` observation is done. Say what it showed and whether that answers the issue (next step: close) or leaves something to decide (next step: `needs-triage`, with the question).
- **Production observation** — what is left can only be seen on a running board. Say what to watch for. Next step: add `verify:production`.
- **Won't fix** — already implemented (point to where it lives) or rejected (with the reason). Next step: close.
- **Skipped** — you could not evaluate it (missing base VM, conflicting state labels, anything that blocks the investigation itself). Skipped issues get no comment and no label, so the next sweep picks them up again; what blocked you goes in your return line.

### 4. Post

One comment per evaluated issue, in Japanese like the issue thread, headings in English:

```markdown
> *This was generated by AI during triage.*

**Triage sweep** — investigated at `<SHA>` · [session](<link>)

## <Agent Brief | Questions for grilling | Findings | Production observation | Won't fix>

<body>

### Related
- #<n> — <duplicate suspected | must land first | shares <area> | agrees with / contradicts its sweep comment>

### Recommended next step
<one line, from the outcome above>
```

Drop the session link when the parent said there is none, and the Related section when there is nothing to relate.

**Findings outside the issue** — a defect or contradiction you met that the issue does not ask about — each get their own issue: `gh issue create --label needs-triage`, opening with the same disclaimer line, then what you observed, how you checked it, the investigated SHA, and the issue it came from. List it under Related in your comment.

### 5. Label

On each evaluated issue, add `auto-triaged`, and the category label (`bug` or `enhancement`) when the issue has none. Those two labels, the comment, and the issues you file for findings outside the issue are the whole of your write access to the tracker: the state label, `verify:*`, blocked-by edges, and closing all stay with the maintainer, who acts on your recommended next step.

## Return

To the parent, one line per issue — number, outcome, recommended next step, comment URL — then the issues you filed, and any worktree or VM clone you failed to remove.
