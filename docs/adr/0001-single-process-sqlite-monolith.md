# Single-process TypeScript monolith; board in SQLite, registry in git

Tidepool runs as one Node.js process on the Raspberry Pi (WebUI static + API + MCP endpoint + scheduler + agent child-process spawning), with the kanban board in a single SQLite file (WAL) and the agent registry in a separate git repository.

Concurrency=1 is a foundational product decision, so the execution slot is a single in-process fact; splitting into services would turn slot arbitration and triage-pause/immediate-poll coordination into IPC problems with no benefit on one machine. SQLite's single-writer weakness is structurally irrelevant here, and its zero-ops/backup-by-file-copy strengths dominate; a file-based or Postgres board was rejected (transaction and query needs vs. an extra daemon). The registry stays in git because "commit hash = strict agent version" and "authority changes require human approval via path rules" are git-shaped requirements — and it is a *separate* repo so code commits don't pollute agent version hashes and instance data stays out of the product.

Consequence: a server restart interrupts any running task; this is deliberate — it drops into the same escalation path as a watchdog kill (WIP-commit tree rule), so no graceful-drain machinery exists.
