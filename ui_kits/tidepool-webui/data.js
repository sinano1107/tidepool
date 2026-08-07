// tidepool webui — shared fake data for the UI kit
const tpData = {
  agents: [
    { name: 'reef-crab', desc: 'implementation · sonnet + git-guardrails', icon: '🦀', authority: 'implementer', model: 'sonnet', effort: '', advisor: '', skills: ['@workspace', '@host'], systemPrompt: 'Prefers small, reviewable commits. Never force-pushes.' },
    { name: 'anemone', desc: 'review · read-only authority', icon: '🪸', authority: 'reviewer', model: 'sonnet', effort: 'high', advisor: 'claude-opus-5', skills: ['@workspace'], systemPrompt: '' },
    { name: 'hermit', desc: 'docs + registry edits', icon: '🐚', authority: 'docs-editor', model: 'sonnet', effort: '', advisor: '', skills: ['@workspace', 'docs:*'], systemPrompt: '' },
  ],
  // the host's enumerated @host skills (issue #106) — the settings screen's
  // skill picker offers these plus the @workspace/@host scope words and "*"
  hostSkills: ['review', 'refactor', 'docs', 'deploy'],
  // settings screen fixtures (issue #57 phase 3 kit mirror) — workspaces /
  // authorityProfiles below mirror the same registry the board-wide `settings`
  // preferences live alongside; kept separate from `agents` above only because
  // that array predates this section and other screens already read it.
  workspaces: [
    { name: 'tidepool', repo: 'github.com/masaki/tidepool', notes: "the board's own registry clone — protection stays on", protected: true, registrySelf: true },
    { name: 'registry', repo: 'github.com/masaki/tidepool-registry', notes: '' },
    { name: 'sandbox', path: '/home/masaki/sandbox', notes: 'scratch experiments, wiped weekly' },
  ],
  authorityProfiles: [
    { name: 'implementer', guidance: 'full read/write in assigned workspaces; merge requires human confirmation', assignable_to: ['reef-crab'], allowed_workspaces: ['tidepool', 'registry'], merge: 'escalate' },
    { name: 'reviewer', guidance: 'read-only — flags issues, never edits', assignable_to: ['anemone'], allowed_workspaces: ['*'], merge: '' },
    { name: 'docs-editor', guidance: 'may edit docs and registry entries, no code paths', assignable_to: ['hermit'], allowed_workspaces: ['registry'], merge: '' },
  ],
  settings: {
    displayLanguage: 'en',
    displayLanguageOptions: ['en', 'ja'],
    quietHours: { start: '23:00', end: '07:00', tz: 'Asia/Tokyo' },
    paceOffsets: { session: 20, week: 10, fable: 10 },
  },
  // each question task carries a shared `context` (its `purpose`) plus 1-4
  // `items`, each with its own title / optional detail / options (issue
  // #30) — a single-item bundle is the degenerate, most common case; tp-0148
  // below shows the 2-item case the bundle exists for.
  questions: [
    {
      id: 'tp-0143', parent: 'tp-0141', agent: 'reef-crab',
      context: 'registry loader — 4 files, all checks pass. Merge is outside my authority (merge: escalate).',
      items: [
        {
          title: 'Merge PR #58? CI green',
          options: [
            { label: 'Merge', recommended: true },
            { label: 'Hold — I will look today' },
            { label: 'Request changes via repair task' },
          ],
        },
      ],
    },
    {
      id: 'tp-0148', parent: 'tp-0146', agent: 'anemone',
      context: 'Two related schema calls came up together while reviewing tp-0146 — deciding them in one sitting avoids a second round-trip.',
      items: [
        {
          title: 'Cancelled tasks: soft-delete or hard-delete?',
          detail: 'events table is append-only either way; this only affects the tasks row.',
          options: [
            { label: 'Keep rows, status=cancelled', recommended: true },
            { label: 'Hard delete' },
          ],
        },
        {
          title: 'Cancellation reason: free text or a fixed enum?',
          detail: 'free text keeps abandon’s human note flexible; an enum needs a vocabulary decided up front.',
          options: [
            { label: 'Free text', recommended: true },
            { label: 'Fixed enum' },
          ],
        },
      ],
    },
    {
      id: 'tp-0149', parent: null, agent: 'hermit',
      context: 'new-agent onboarding section. 2 paragraphs, no authority change.',
      items: [
        {
          title: 'Registry README: document probation model?',
          options: [
            { label: 'Yes, write it', recommended: true },
            { label: 'Skip for v1' },
          ],
        },
      ],
    },
    {
      id: 'tp-0153', parent: 'tp-0146', agent: 'reef-crab', kind: 'approval',
      context: 'register_child_task: "Backfill events for migrated rows" carries a risk flag; parent tp-0146 does not. Held pending — converted server-side, no error returned.',
      note: 'approving raises tp-0146 risk (upward propagation)',
      items: [
        {
          title: 'Child task exceeds my risk — approve?',
          options: [
            { label: 'Approve — raise parent risk', recommended: true },
            { label: 'Reject — cancel the child' },
          ],
        },
      ],
    },
  ],
  // workspace (issue #44): demos the log skim's grouping — 'tidepool' mixes
  // unread and read, 'registry' is unread-only, 'sandbox' is read-only (only
  // reachable through the log section's "show read-only workspaces" toggle)
  log: [
    { time: '06:41', taskId: 'tp-0142', agent: 'reef-crab', kind: 'decision', text: 'used better-sqlite3 transactions for queue reorder — single writer, no locking needed', unread: true, workspace: 'tidepool' },
    { time: '03:52', taskId: 'tp-0139', agent: 'anemone', kind: 'completion', text: 'criteria met — review of watchdog timer, findings → 1 repair task. handoff: PR #58', unread: true, workspace: 'registry',
      handoff: 'outcome vs criteria: review complete — 2 findings, 1 escalated to a repair task\ndeliverable location: PR #58 review comments\nkey decision refs: d-041\ndead ends: none\ncontext to resume: SIGKILL path of the watchdog timer is still unclear\nknown issues (no task): timer test is flaky on CI' },
    { time: '02:07', taskId: 'tp-0141', agent: 'reef-crab', kind: 'decision', text: 'chose YAML over TOML for authority profiles — matches workspaces.yaml', unread: true, workspace: 'tidepool' },
    { time: '01:30', taskId: 'tp-0141', agent: 'reef-crab', kind: 'escalation', text: 'escalated: merge PR #58 → question tp-0143', unread: true, workspace: 'tidepool' },
    { time: '23:58', taskId: 'tp-0138', agent: 'hermit', kind: 'completion', text: 'criteria met — workspaces.yaml documented, branch task/tp-0138', unread: false, workspace: 'tidepool' },
    { time: '20:15', taskId: 'tp-0130', agent: 'hermit', kind: 'decision', text: 'reused the existing S3 preview cache instead of adding a new endpoint', unread: false, workspace: 'sandbox' },
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
  // canned single-question flow — the deep-link target of a push notification.
  // 2 items, to demo the single-question view handling a bundle too.
  pushQuestion: {
    id: 'tp-0156', parent: 'tp-0150', agent: 'reef-crab',
    context: 'watchdog grace-period tuning — two related dials came up together.',
    items: [
      {
        title: 'Watchdog grace: 30s or 120s before SIGKILL?',
        detail: 'SIGTERM sent on timeout; how long to wait for the WIP commit before SIGKILL.',
        options: [
          { label: '120s — give the tree rule room', recommended: true },
          { label: '30s' },
        ],
      },
      {
        title: 'Retries before auto-escalating to abandon?',
        options: [
          { label: '1 retry, then ask', recommended: true },
          { label: '3 retries, then ask' },
        ],
      },
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
