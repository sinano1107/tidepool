# Landscape: boards and orchestrators for AI agents (2026-08-22)

A dated snapshot taken while writing the README (issue #437, ADR 0095). Star counts are approximate as of the date above and will drift; the axis each project sits on is the part meant to last.

Columns: (a) decision authority declared per agent or delegation, (b) asynchronous escalation — the agent asks, keeps working, the human answers later, (c) audit of *decisions* (not just events or transcripts), (d) read-only review with fix-forward. ✓ present, ~ partial, ✗ not documented.

| Project | What it is | ★ | Lock-in | a | b | c | d |
|---|---|---|---|---|---|---|---|
| [Paperclip](https://github.com/paperclipai/paperclip) | Control plane for a "company of agents": org chart, budgets, heartbeats, approval gates | 79k | none | ✓ action-level approval policies | ~ approval inbox (approves actions, not Q&A) | ✓ "every decision explained" | ✓ |
| [Ruflo](https://github.com/ruvnet/ruflo) (ex-claude-flow) | Execution harness + memory layer; `swarm_init` runs agents immediately; no board | 69k | Claude Code-centric | ✗ | ✗ | ✗ | ~ |
| [Plane](https://github.com/makeplane/plane) | Linear/Jira alternative; agent-as-assignee, Agent Runs with `awaiting`/elicitation, REST + webhooks + MCP (runs in Beta, AGPL-3.0) | 57k | none | ~ OAuth scopes only | ✓ | ~ activity feed | ✓ |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Web kanban + worktrees + inline diff comments (community-maintained since 2026-04) | 28k | none | ✗ | ✗ | ✗ | ✓ |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | Desktop IDE; columns derived from git/CI/review facts | 9.7k | none | ✗ | ~ "needs attention" column | ✗ | ✓ |
| [ccpm](https://github.com/automazeio/ccpm) | PRD → epic → GitHub issues, parallel worktrees | 8.3k | none | ✗ | ✗ | ~ | ~ |
| [Emdash](https://github.com/generalaction/emdash) | Desktop agentic environment with Linear/Jira intake | 5.5k | none | ✗ | ✗ | ✗ | ✓ |
| [Bernstein](https://github.com/sipyourdrink-ltd/bernstein) | Deterministic (no-LLM) scheduler; HMAC-chained audit receipts | 950 | none | ✗ | ✗ | ✓ of events, not decisions | ~ |
| [Kandev](https://github.com/kdlbs/kandev) | Self-hosted kanban; human gates per workflow step; ACP | 670 | none | ~ per step | ✗ | ✗ | ✓ |
| [Kanban Code](https://github.com/langwatch/kanban-code) | Desktop board; card = Claude session + worktree | 310 | Claude Code | ✗ | ~ "Waiting" column, session blocked | ✗ | ✓ |
| [5dive](https://github.com/5dive-ai/5dive) | Agents as Linux users; Telegram tap-to-answer | new | none | ~ OS isolation tiers (capability, not decision) | ✓ | ✗ | ✗ |
| Claude Code Agent Teams | Lead + teammates with a shared task list | — | Claude Code | ~ lead approves plans autonomously | ✗ synchronous | ✗ | ~ |
| Linear for Agents / Jira Rovo / Copilot coding agent | Agents as assignees inside an existing tracker | — | — | scopes + free-text instructions | ✓ elicitation / approval step (Copilot: draft PR only) | ✗ | ✓ |

## Reading

- Model-agnostic and read-only review are table stakes now.
- "Escalation" in every board means a blocking permission prompt shown as a column. Parking a question and continuing is not on any OSS board; the MCP spec of 2026-07-28 describes the same non-blocking pattern (MRTR) and nobody has adopted it yet.
- Declaring decision authority before the agent starts is attempted by nobody. Audit of decisions rather than events exists only in Paperclip.
- The industry is converging on "the tracker owns the queue and the human loop, the agent owns execution" — which is why existing trackers are on tidepool's roadmap as an entry point.
- Academic: *Software Delegation Contracts* ([arXiv 2606.17099](https://arxiv.org/abs/2606.17099), 2026-06) finds explicit authority plus acceptance context improves reviewability.
