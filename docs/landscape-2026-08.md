# Landscape: boards and orchestrators for AI agents (2026-08-22)

A dated snapshot taken while writing the README (issue #437, ADR 0095). Star counts and feature claims were checked against each project's own README/docs on the date above and will drift; the axis each project sits on is the part meant to last.

Columns: (a) decision authority declared per agent or delegation, (b) asynchronous escalation — the agent asks, keeps working, the human answers later, (c) audit of *decisions* (not just events or transcripts), (d) read-only review with fix-forward. ✓ present, ~ partial, ✗ not documented.

| Project | What it is | ★ | Lock-in | a | b | c | d |
|---|---|---|---|---|---|---|---|
| [Paperclip](https://github.com/paperclipai/paperclip) | Control plane for a "company of agents": org chart, budgets, heartbeats, approval gates | 79k | none (Claude, Codex, Cursor, Gemini, …) | ✓ action-level approval policies | ~ approval inbox (approves actions, not Q&A) | ✓ "every decision explained" | ✓ |
| [Ruflo](https://github.com/ruvnet/ruflo) (ex-claude-flow) | Execution harness + memory layer for Claude Code / Codex; swarms run inside your session; no board or queue | 69k | Claude Code / Codex | ✗ | ✗ | ✗ | ~ |
| [Plane](https://github.com/makeplane/plane) | Linear/Jira alternative; agents invoked by @mention on a work item, Agent Runs with `awaiting`/elicitation, REST + webhooks + MCP (runs in Beta, AGPL-3.0) | 57k | none | ~ OAuth scopes only | ✓ | ~ activity feed | ✓ |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Web kanban + worktrees + inline diff comments (community-maintained since 2026-04) | 28k | none (10+) | ✗ | ✗ | ✗ | ✓ |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | Desktop workspace; columns derived from session/PR/CI/review facts | 9.7k | none (26) | ✗ | ~ "Needs you" column | ✗ | ✓ |
| [ccpm](https://github.com/automazeio/ccpm) | PRD → epic → GitHub issues, parallel worktrees | 8.3k | none | ✗ | ✗ | ~ | ~ |
| [Emdash](https://github.com/generalaction/emdash) | Desktop agentic environment with Linear/Jira intake | 5.5k | none (34) | ✗ | ✗ | ✗ | ✓ |
| [Bernstein](https://github.com/sipyourdrink-ltd/bernstein) | Deterministic (no-LLM) scheduler; HMAC-chained audit receipts | 950 | none (49) | ✗ | ✗ | ✓ of events, not decisions | ~ |
| [Kandev](https://github.com/kdlbs/kandev) | Self-hosted kanban; human gates per workflow step; ACP | 670 | none (21+, ACP) | ~ per step | ✗ | ✗ | ✓ |
| [Kanban Code](https://github.com/langwatch/kanban-code) | Desktop board; card = Claude session + worktree | 310 | Claude Code | ✗ | ~ "Waiting" column, session blocked | ✗ | ✓ |
| [5dive](https://github.com/5dive-ai/5dive) | Agents as Linux users; Telegram tap-to-answer | new | none | ~ OS isolation tiers (capability, not decision) | ✓ | ✗ | ✗ |
| Claude Code Agent Teams | Lead + teammates with a shared task list | — | Claude Code | ~ per-teammate permission mode cannot be set at spawn; lead approves plans autonomously | ✗ synchronous | ✗ | ~ |
| [Superpowers](https://github.com/obra/superpowers) | Methodology-as-skills: brainstorm → plan → subagent implementation → two-stage review | 276k | none | ~ sign-off checkpoints | ✗ | ✗ | ✓ |
| Linear for Agents (and other tracker-native agents) | Agents delegated to inside an existing tracker | — | — | OAuth scopes + free-text instructions | ✓ elicitation activity | ✗ | ✓ |

## Reading

- Model-agnostic and read-only review are table stakes now.
- "Escalation" in every board means a blocking permission prompt shown as a column. Parking a question and continuing is not on any OSS board; the MCP spec of 2026-07-28 describes the same non-blocking pattern (MRTR); no OSS board had adopted it at the time of writing.
- Declaring decision authority before the agent starts is attempted by nobody. Audit of decisions rather than events exists only in Paperclip.
- The industry is converging on "the tracker owns the queue and the human loop, the agent owns execution" — which is why existing trackers are on tidepool's roadmap as an entry point.
- Academic: *Software Delegation Contracts* ([arXiv 2606.17099](https://arxiv.org/abs/2606.17099), 2026-06) finds explicit authority plus acceptance context improves reviewability.
