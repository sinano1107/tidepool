# tidepool

**Stop babysitting your AI agents. Give them a task, a scope of what they may decide alone, and a way to ask you later.**

Delegating to an AI agent today means staying in the room: it asks a question, and nothing moves until you answer. tidepool treats an agent the way you would treat a new colleague. Each delegation says up front what the agent may decide on its own. Decisions inside that scope are logged in one line each; anything outside it becomes a *question* parked on a board — the agent moves on to other work, and you answer when you have time. Every decision stays on record, so you can object to one afterwards and the agent fixes forward.

## Before / After

**Before.** You hand a task to an agent and stay tied to the session. Each time it needs a judgment call you answer on the spot, or it stalls. You keep the state of parallel tasks in your head, and when work moves to another agent you explain the context again.

**After.** You register the task with a scope of decisions the agent may take alone. In-scope decisions land in the decision log; out-of-scope ones become questions on the board, and the agent keeps going on something else. In the morning you read the log, answer the questions, and object where needed. Parallel state and handoffs live on the board, not in your head.

## How it works

- **Everything is a task** — work, questions, and reviews share one model, so an escalation is just a small task assigned to you that blocks its parent.
- **Decision authority comes first.** Each agent carries an authority profile: what it may decide alone, whom it may delegate to. Escalating upward is never restricted — it is the safety valve.
- **Questions are asynchronous.** An agent that hits the edge of its authority registers a question and releases its slot. You answer later, from a phone if you like.
- **Decisions are on record.** Every in-scope decision is one line in the decision log. You skim it; an objection becomes a repair task for the same agent. No rollback — fix forward, and the objections feed back into authority tuning.
- **Review is read-only.** Reviewers never fix. Findings become repair tasks; improvement proposals become concrete diffs you approve.
- **Two MCP doors, never confused.** A worker session gets a tool surface bounded by its authority profile. Your own interactive agent (Claude Code, say) can work the board through a separate management MCP — as your hand, so every action it takes is attributed to you, not to an agent.

The vocabulary is defined in [`CONTEXT.md`](./CONTEXT.md); the reasoning behind each decision is in [`docs/adr/`](./docs/adr/README.md).

## How it differs

Dated comparison table: [`docs/landscape-2026-08.md`](./docs/landscape-2026-08.md).

- **Paperclip** lets agents run a company — org chart, budgets, action-level approval policies. tidepool keeps the human at the helm: authority is declared per delegation, and the record is what you steer by.
- **Vibe Kanban, Plane, Linear, and the kanban-for-agents tools** put a card in a "waiting for you" column when an agent needs an answer — and that agent sits idle until you get to it. In tidepool the question becomes its own task, the agent that asked it is released to pick up other work, and the answer is applied when the parent resumes. Waiting costs you nothing and the agent nothing.
- **Ruflo** and swarm orchestrators accelerate a session you are sitting in. tidepool is for work you hand over and walk away from.

## Status

Pre-release, **0.x** — interfaces change without notice.

What runs today: tasks are executed inside a git repository (the task's repository can be purely local) by CLI agents — Claude Code now, with the board designed to stay agent-agnostic. Decision authority, asynchronous questions, the decision log with objections, read-only review, and the morning triage flow are implemented. Periodic meta-review and long-term memory are not yet.

The goal is any organisation's work, not only software. Today's constraint is "the work lives in a git repository", not "the work is code".

## Getting started

A purely local board on an Apple Silicon Mac, first task completed in about 30 minutes with one command: [`docs/mac-first-boot.md`](./docs/mac-first-boot.md). You need an Apple Silicon Mac, Homebrew, a GitHub account and a Claude subscription. The board runs in a Linux VM the installer creates, so Node, the `claude` CLI and `gh` go inside the VM — nothing but Lima is installed on the Mac.

## Roadmap

- **Existing trackers as the entry point** — Plane, Linear, GitHub Issues as where tasks come from, with tidepool supplying authority, questions, and the decision record. The built-in board stays as the reference implementation.
- **More agent backends** — Codex and other CLI agents as workers alongside Claude Code.
- **Human-approved memory** — agents remember only what an objection taught and a human approved, not everything they saw.

## Contributing

Issues and pull requests are welcome. Code, agent-facing text, and the public docs are English; ADRs, `CONTEXT.md`, and commit messages are often Japanese. Contributors will be asked to sign a lightweight CLA (being set up, see [#438](https://github.com/sinano1107/tidepool/issues/438)).

## License

Apache-2.0 — see [`LICENSE`](./LICENSE). Copyright 2026 Masaki Cho.

## Why "tidepool"

Tasks swell in like the tide and drain out as they settle. What stays behind condenses: objections evaporate up into review and come back down as concrete changes to an agent's authority and instructions — a pool that tunes itself.

A tidepool is also its own small ecosystem. Each agent lives in it the way a creature does — different species, different niches, none of them in charge — and it is the environment, not a supervisor, that shapes how each one works: authority widens where decisions hold up and narrows where objections pile in. The agents do the work; the pool does the tuning.
