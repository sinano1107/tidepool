// tidepool webui — shared fake data for the UI kit
const tpData = {
  agents: [
    { name: 'reef-crab', desc: 'implementation · sonnet + git-guardrails' },
    { name: 'anemone', desc: 'review · read-only authority' },
    { name: 'hermit', desc: 'docs + registry edits' },
  ],
  questions: [
    {
      id: 'tp-0143', parent: 'tp-0141', agent: 'reef-crab',
      title: 'Merge PR #58? CI green',
      context: 'registry loader — 4 files, all checks pass. Merge is outside my authority (merge: escalate).',
      options: [
        { label: 'Merge', recommended: true },
        { label: 'Hold — I will look today' },
        { label: 'Request changes via repair task' },
      ],
    },
    {
      id: 'tp-0148', parent: 'tp-0146', agent: 'anemone',
      title: 'Schema: soft-delete or hard-delete cancelled tasks?',
      context: 'events table is append-only either way; this only affects the tasks row.',
      options: [
        { label: 'Keep rows, status=cancelled', recommended: true },
        { label: 'Hard delete' },
      ],
    },
    {
      id: 'tp-0149', parent: null, agent: 'hermit',
      title: 'Registry README: document probation model?',
      context: 'new-agent onboarding section. 2 paragraphs, no authority change.',
      options: [
        { label: 'Yes, write it', recommended: true },
        { label: 'Skip for v1' },
      ],
    },
    {
      id: 'tp-0153', parent: 'tp-0146', agent: 'reef-crab', kind: 'approval',
      title: 'Child task exceeds my risk — approve?',
      context: 'register_child_task: "Backfill events for migrated rows" carries a risk flag; parent tp-0146 does not. Held pending — converted server-side, no error returned.',
      note: 'approving raises tp-0146 risk (upward propagation)',
      options: [
        { label: 'Approve — raise parent risk', recommended: true },
        { label: 'Reject — cancel the child' },
      ],
    },
  ],
  log: [
    { time: '06:41', taskId: 'tp-0142', agent: 'reef-crab', kind: 'decision', text: 'used better-sqlite3 transactions for queue reorder — single writer, no locking needed', unread: true },
    { time: '03:52', taskId: 'tp-0139', agent: 'anemone', kind: 'completion', text: 'criteria met — review of watchdog timer, findings → 1 repair task. handoff: PR #58', unread: true,
      handoff: 'outcome vs criteria: review complete — 2 findings, 1 escalated to a repair task\ndeliverable location: PR #58 review comments\nkey decision refs: d-041\ndead ends: none\ncontext to resume: SIGKILL path of the watchdog timer is still unclear\nknown issues (no task): timer test is flaky on CI' },
    { time: '02:07', taskId: 'tp-0141', agent: 'reef-crab', kind: 'decision', text: 'chose YAML over TOML for authority profiles — matches workspaces.yaml', unread: true },
    { time: '01:30', taskId: 'tp-0141', agent: 'reef-crab', kind: 'escalation', text: 'escalated: merge PR #58 → question tp-0143', unread: true },
    { time: '23:58', taskId: 'tp-0138', agent: 'hermit', kind: 'completion', text: 'criteria met — workspaces.yaml documented, branch task/tp-0138', unread: false },
  ],
  queue: [
    { id: 'tp-0144', title: 'Write board schema DDL', assignee: 'reef-crab', workspace: 'tidepool' },
    // derived-blocked: holds its queue position dimmed — the slot skips it until the children finish
    { id: 'tp-0141', title: 'Registry loader + agent.md parser', assignee: 'reef-crab', risk: true, workspace: 'tidepool', blocked: true },
    { id: 'tp-0146', title: 'Scaffold MCP server verbs', assignee: 'reef-crab', risk: true, workspace: 'tidepool' },
    { id: 'tp-0147', title: 'Vite PWA shell + push subscription', assignee: 'hermit', skipped: true, workspace: 'tidepool' },
    { id: 'tp-0150', title: 'Watchdog repair: clear stale timer on SIGKILL path', assignee: 'reef-crab', workspace: 'registry' },
  ],
  // tree-rule failure state — surfaced in the queue as a needs-human banner (toggle in tweaks)
  workspaceAlert: {
    workspace: 'registry',
    reason: 'tree rule failed — conflict on task/tp-0141',
    held: ['tp-0150'],
    question: 'tp-0154',
  },
  // canned single-question flow — the deep-link target of a push notification
  pushQuestion: {
    id: 'tp-0156', parent: 'tp-0150', agent: 'reef-crab',
    title: 'Watchdog grace: 30s or 120s before SIGKILL?',
    context: 'SIGTERM sent on timeout; how long to wait for the WIP commit before SIGKILL.',
    options: [
      { label: '120s — give the tree rule room', recommended: true },
      { label: '30s' },
    ],
  },
  board: {
    todo: [
      { id: 'tp-0144', title: 'Write board schema DDL', type: 'work', assignee: 'reef-crab' },
      { id: 'tp-0146', title: 'Scaffold MCP server verbs', type: 'work', assignee: 'reef-crab', risk: true },
      { id: 'tp-0143', title: 'Merge PR #58? CI green', type: 'question', assignee: 'you', human: true },
    ],
    in_progress: [
      { id: 'tp-0142', title: 'Queue reorder — fractional sort keys', type: 'work', assignee: 'reef-crab' },
    ],
    blocked: [
      { id: 'tp-0141', title: 'Registry loader + agent.md parser', type: 'work', assignee: 'reef-crab', risk: true, children: 1 },
    ],
    done: [
      { id: 'tp-0139', title: 'Review watchdog timer implementation', type: 'review', assignee: 'anemone' },
      { id: 'tp-0138', title: 'Document workspaces.yaml format', type: 'work', assignee: 'hermit' },
      { id: 'tp-0136', title: 'Watchdog timer — kill + question after 2h', type: 'work', assignee: 'reef-crab' },
      { id: 'tp-0135', title: 'agent.md template for the registry', type: 'work', assignee: 'hermit' },
      { id: 'tp-0134', title: 'Tailscale serve config for the Pi', type: 'work', assignee: 'reef-crab' },
      { id: 'tp-0132', title: 'Review escalation-path doc', type: 'review', assignee: 'anemone' },
      { id: 'tp-0131', title: 'events table — append-only DDL', type: 'work', assignee: 'reef-crab' },
    ],
  },
  humanTasks: [
    { id: 'tp-0145', title: 'Plug in the second SSD to the Pi', blocking: 'tp-0147' },
    { id: 'tp-0155', title: 'Buy a USB-C cable for the Pi', blocking: null },
  ],
};
window.tpData = tpData;
