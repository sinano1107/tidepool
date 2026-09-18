// Registration — wired to POST /api/tasks. Two content sources:
// manual (this screen's own brain-dump → LLM-draft → edit flow, issue #65)
// and the issue-backed source (issue #49): the board stores only a reference
// (workspace + issue number) and the registration gate may reject with a
// suggested issue comment — shown inline here for the human to approve
// (posting it is the approval; the board never posts on its own).
// parentTask (issue #129, human decompose): when set, this screen registers
// a child of parentTask instead of a root task — same dump → draft → edit →
// submit flow (CONTEXT.md's Decompose point 2: "登録画面に木モードは作らない
// — ルート登録 + 子追加の合成で足りる", no separate tree-registration mode),
// with the type/source pickers and issue-backed path dropped (a decompose
// child is always type work, never issue-backed — decomposeTask's own
// ChildSpec has no such fields either) and one field added: a required
// free-text reason for the split, which lands as a decision-log entry
// (CONTEXT.md's Decompose point 5) and steers the child's own AI
// draft as context (point 4).
// この画面がサーバとやりとりする形 —— 画面内で閉じた型で、集合ごとの移送は
// issue #352 が持つ。POST /api/tasks の本文(登録の門が読む)。
interface RegisterScreenFields {
  /** 画面が出すのはこの2つだけ(子追加は常に work)。 */
  type: 'work' | 'review';
  title?: string;
  purpose?: string;
  completion_criteria?: string;
  risk_flag?: boolean;
  review_flag?: boolean;
  assignee?: string;
  workspace?: string;
  github_issue_number?: number;
  parent_id?: string;
  decompose_reason?: string;
}
/** 登録の門の 422 本文(src/human-verbs.ts の issue_rejected)+ 検査した参照。 */
interface RegisterScreenGate {
  missing?: string;
  suggested_comment?: string;
  workspace?: string;
  github_issue_number?: number;
}
interface RegisterScreenIssue {
  number: number;
  title: string;
}
interface RegisterScreenPendingDump {
  id: number;
  line: string;
}
interface RegisterScreenProps {
  onRegister: (fields: RegisterScreenFields) => Promise<void>;
  /** 子追加モード —— 未設定ならルート登録。 */
  parentTask?: { id: string; title: string } | null;
  onClose: () => void;
}

// biome-ignore lint/correctness/noUnusedVariables: rendered by webui/app.jsx — one concatenated bundle
function RegisterScreen({ onRegister, parentTask, onClose }: RegisterScreenProps) {
  const { Button, Card, Input, Select, Checkbox } = window.TidepoolDesignSystem_8a0ead;
  const childMode = !!parentTask;
  const [source, setSource] = React.useState<'manual' | 'github issue'>('manual');
  const [type, setType] = React.useState<'work' | 'review'>('work');
  const [title, setTitle] = React.useState('');
  const [purpose, setPurpose] = React.useState('');
  const [criteria, setCriteria] = React.useState('');
  const [assignee, setAssignee] = React.useState('');
  const [workspace, setWorkspace] = React.useState('');
  const [risk, setRisk] = React.useState(false);
  const [review, setReview] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [issueNumber, setIssueNumber] = React.useState('');
  const [gate, setGate] = React.useState<RegisterScreenGate | null>(null);
  const [busy, setBusy] = React.useState(false);
  // brain dump → LLM draft (issue #12, wired here by issue #65): dump stays
  // its own field so a redraft never has to fight stale content-field values
  const [dump, setDump] = React.useState('');
  const [drafted, setDrafted] = React.useState(false);
  const [plainFormActive, setPlainFormActive] = React.useState(false);
  const [draftBusy, setDraftBusy] = React.useState(false);
  // registry-sourced assignee/workspace candidates (issue #12/#65) — fetched
  // once per screen visit; RegisterScreen remounts fresh each tab entry (the
  // shell's key={tab}), so this never goes stale within a sitting
  const [candidates, setCandidates] = React.useState<{ assignees: string[]; workspaces: string[] }>({ assignees: [], workspaces: [] });
  React.useEffect(() => {
    fetch('/api/registry/candidates').then((r) => r.json()).then(setCandidates).catch(() => {});
  }, []);
  const issueMode = !childMode && source === 'github issue';
  // the parent_id/decompose_reason pair every childMode request (draft and
  // submit alike) carries — one shared shape so the two call sites can't
  // drift apart
  const childExtras = () =>
    parentTask
      ? { parent_id: parentTask.id, decompose_reason: reason.trim() }
      : {};
  // the issue-number picker's open-issue list (issue #67): one fetch per
  // workspace selection, no cache/paging — the board-side rationale is the
  // human's own operation frequency (one Select change = one API call).
  // `truncated` comes from the server (which owns the `--limit` it asked
  // `gh` for) rather than the UI comparing issues.length against a
  // hardcoded 100 of its own.
  const [issues, setIssues] = React.useState<RegisterScreenIssue[]>([]);
  const [issuesFailed, setIssuesFailed] = React.useState(false);
  const [truncated, setTruncated] = React.useState(false);
  React.useEffect(() => {
    setIssues([]); setIssuesFailed(false); setTruncated(false);
    if (!issueMode || !workspace.trim()) return;
    api(`/api/github-issues?workspace=${encodeURIComponent(workspace.trim())}`, undefined, 'GET')
      .then((d) => { setIssues(d.issues); setTruncated(d.truncated); })
      .catch(() => setIssuesFailed(true));
  }, [issueMode, workspace]);
  // pending dumps (issue #61) — triage's `register` disposition lands here.
  // Picking one flows its line into the brain dump the same as typing it by
  // hand; the row itself is consumed only by a successful registration built
  // from it, or an explicit discard — never by merely selecting or backing out.
  const [pendingDumps, setPendingDumps] = React.useState<RegisterScreenPendingDump[]>([]);
  const [selectedDumpId, setSelectedDumpId] = React.useState<number | null>(null);
  const refreshPendingDumps = () =>
    fetch('/api/pending-dumps').then((r) => r.json()).then(setPendingDumps).catch(() => {});
  React.useEffect(() => { refreshPendingDumps(); }, []);
  const pickPendingDump = (d: RegisterScreenPendingDump) => {
    resetContent();
    setSelectedDumpId(d.id);
    setDump(d.line);
  };
  const discardPendingDump = async (id: number) => {
    if (id === selectedDumpId) { setSelectedDumpId(null); }
    try {
      await api(`/api/pending-dumps/${id}`, {}, 'DELETE');
    } catch {
      return;
    }
    refreshPendingDumps();
  };
  const issueListHintStyle = { fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' };
  // design-system の onChange は React.ChangeEvent(総称引数の既定は Element)を渡すので
  // .value が生えていない。宣言を締めるのは design-system 側の仕事で、このスライスは
  // .d.ts を正本として読むだけ —— 呼び出し側で1箇所に寄せる。
  const targetValue = (e: React.ChangeEvent) => (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  // the Input doubles as the list's filter (issue #67): a number or a
  // title substring narrows the rows, tapping a row confirms the number
  const filteredIssues = issueNumber.trim()
    ? issues.filter((i) =>
        String(i.number).includes(issueNumber.trim()) ||
        i.title.toLowerCase().includes(issueNumber.trim().toLowerCase()))
    : issues;
  const ok = issueMode
    ? workspace.trim() && /^[0-9]+$/.test(issueNumber.trim())
    : title.trim() && purpose.trim() && criteria.trim() && (!childMode || reason.trim());
  const fields = (): RegisterScreenFields =>
    issueMode
      ? { type: 'work', workspace: workspace.trim(), github_issue_number: Number(issueNumber.trim()) }
      : {
          // a decompose child is always type work (decomposeTask's own
          // ChildSpec has no type field) — the type picker is dropped in
          // childMode below, so `type` state never leaves its 'work' default
          type, title: title.trim(), purpose: purpose.trim(), completion_criteria: criteria.trim(),
          risk_flag: risk, review_flag: review,
          // unset assignee/workspace resolve to the board's defaults at
          // execution time (CONTEXT.md) — omit rather than send '' so an
          // unknown-workspace 400 never fires on a field the human left blank
          ...(assignee ? { assignee } : {}),
          ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
          ...childExtras(),
        };
  const resetContent = () => {
    setDump(''); setDrafted(false); setPlainFormActive(false);
    setType('work'); setTitle(''); setPurpose(''); setCriteria('');
    setAssignee(''); setWorkspace(''); setIssueNumber(''); setReason('');
    setRisk(false); setReview(false);
    // backing out of a pending dump's content leaves the row itself alone —
    // it is unconsumed and stays listed, pickable again later
    setSelectedDumpId(null);
  };
  const submitFields = async (f: RegisterScreenFields) => {
    setBusy(true);
    setGate(null);
    try {
      await onRegister(f);
      // the pending dump this registration was built from is consumed the
      // moment registration succeeds — same delete an explicit discard uses
      if (selectedDumpId != null) {
        const consumedId = selectedDumpId;
        setSelectedDumpId(null);
        api(`/api/pending-dumps/${consumedId}`, {}, 'DELETE').then(refreshPendingDumps).catch(() => {});
      }
      resetContent();
      // a root registration stays on the screen for the next dump; a child
      // add is a one-shot dialog action — close it once it lands
      if (childMode) onClose();
    } catch (rawErr) {
      // a gate rejection carries the fix; anything else the toast reported.
      // The inspected reference is burned into the gate state so a later
      // edit of the form fields can't repoint the approved comment (or the
      // retry) at a different issue than the one that was inspected.
      // webui/app.jsx の api() が status / detail を生やして投げる
      const err = rawErr as { status?: number; detail?: RegisterScreenGate };
      if (err.status === 422 && err.detail) {
        setGate({
          ...err.detail,
          workspace: f.workspace,
          github_issue_number: f.github_issue_number,
        });
      }
    }
    setBusy(false);
  };
  const submit = () => submitFields(fields());
  const approveComment = async () => {
    if (!gate) return; // gate 表示の中からしか押せない
    setBusy(true);
    try {
      await api('/api/issue-comments', {
        workspace: gate.workspace,
        github_issue_number: gate.github_issue_number,
        body: gate.suggested_comment,
      });
    } catch {
      setBusy(false);
      return; // posting failed — keep the gate view so the human can retry
    }
    setBusy(false);
    // the comment is now part of the issue thread — re-register the same
    // inspected reference so the gate re-reads it, comment included
    await submitFields({
      type: 'work',
      workspace: gate.workspace,
      github_issue_number: gate.github_issue_number,
    });
  };
  const draftFields = async () => {
    setDraftBusy(true);
    try {
      const d = await api('/api/tasks/draft', { dump: dump.trim(), ...childExtras() });
      setTitle(d.title); setPurpose(d.purpose); setCriteria(d.completion_criteria);
      setAssignee(d.assignee ?? ''); setWorkspace(d.workspace ?? '');
      setRisk(!!d.risk_flag); setReview(!!d.review_flag);
      setDrafted(true);
    } catch {
      // the draft client is unset or unreachable (always a 503 — api.ts's
      // own posture) — never blocks registration, only drops to the plain
      // form with blank fields (issue #12 AC3 / issue #65 AC3)
      setPlainFormActive(true);
    }
    setDraftBusy(false);
  };
  const togglePlainForm = () => {
    const next = !plainFormActive;
    resetContent();
    setPlainFormActive(next);
  };
  // prepends a "choose one"/default placeholder to a registry-candidate list
  const withPlaceholder = (value: string, label: string, names: string[]) => [
    { value, label },
    ...names.map((n) => ({ value: n, label: n })),
  ];
  const assigneeOptions = withPlaceholder('', '(default agent)', candidates.assignees);
  // manual content's workspace is optional (unset → the board's default at
  // execution time); an issue reference's workspace is required — it fixes
  // *which* issue the reference means (CONTEXT.md), so its placeholder reads
  // as a prompt to choose, never as an implicit default
  const workspaceOptions = withPlaceholder('', '(default workspace)', candidates.workspaces);
  const issueWorkspaceOptions = withPlaceholder('', 'select workspace…', candidates.workspaces);
  const primaryAction = issueMode || plainFormActive || drafted
    ? {
        label: childMode ? 'Add child — appends to queue tail' : 'Register — appends to queue tail',
        disabled: !ok || busy,
        onClick: submit,
      }
    : { label: draftBusy ? 'Drafting…' : 'Draft fields', disabled: !dump.trim() || draftBusy, onClick: draftFields };
  return (
    <div style={{ padding: '20px 16px' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', margin: '0 0 2px' }}>{childMode ? 'Add child' : 'Register'}</h1>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        {parentTask
          ? `splitting "${parentTask.title}" — appears as a child, same dump → draft → edit flow`
          : issueMode
            ? "reference a GitHub issue — its title/purpose/completion criteria stay live on GitHub"
            : plainFormActive
              ? 'the LLM is unreachable — fill the fields yourself'
              : 'dump it — the LLM drafts the fields, you confirm'}
      </p>
      {childMode && (
        <Card style={{ marginBottom: 14 }}>
          <Input
            label="Reason for splitting this"
            value={reason}
            onChange={(e) => setReason(targetValue(e))}
            placeholder="why this work is being split"
          />
        </Card>
      )}
      {!issueMode && !childMode && pendingDumps.length > 0 && (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            pending dump{pendingDumps.length > 1 ? 's' : ''} — sent here from scratchpad triage, awaiting writeup
          </span>
          {pendingDumps.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-body)',
                fontWeight: d.id === selectedDumpId ? 600 : 400,
              }}>{d.line}</span>
              <Button variant={d.id === selectedDumpId ? 'primary' : 'secondary'} size="sm" onClick={() => pickPendingDump(d)}>Use</Button>
              <Button variant="ghost" size="sm" onClick={() => discardPendingDump(d.id)}>Discard</Button>
            </div>
          ))}
        </Card>
      )}
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!childMode && (
          <Select label="Source" options={['manual', 'github issue']} value={source} onChange={(e) => {
            setSource(targetValue(e) === 'github issue' ? 'github issue' : 'manual'); setGate(null);
            // switching away from the pending-dump's own manual content: a
            // later registration (e.g. an unrelated issue reference) must not
            // consume a dump it was never built from
            setSelectedDumpId(null);
          }} />
        )}
        {issueMode && (
          <React.Fragment>
            <Select label="Workspace" options={issueWorkspaceOptions} value={workspace} onChange={(e) => setWorkspace(targetValue(e))} />
            <Input label="Issue number" value={issueNumber} onChange={(e) => setIssueNumber(targetValue(e))} placeholder="content stays on GitHub; the board keeps only this reference" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {!workspace.trim() && (
                <span style={issueListHintStyle}>select a workspace to browse its open issues</span>
              )}
              {workspace.trim() && issuesFailed && (
                <span style={issueListHintStyle}>couldn't fetch open issues — type the number directly</span>
              )}
              {workspace.trim() && !issuesFailed && filteredIssues.map((i) => (
                <div key={i.number} onClick={() => setIssueNumber(String(i.number))}
                  style={{
                    display: 'flex', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                    fontSize: 'var(--text-sm)', color: 'var(--text-body)',
                    background: String(i.number) === issueNumber.trim() ? 'var(--surface-sunken, rgba(0,0,0,0.06))' : 'transparent',
                  }}>
                  <span style={{ color: 'var(--text-muted)' }}>#{i.number}</span>
                  <span>{i.title}</span>
                </div>
              ))}
              {workspace.trim() && !issuesFailed && truncated && (
                <span style={issueListHintStyle}>older issues exist — type the number directly</span>
              )}
            </div>
          </React.Fragment>
        )}
        {!issueMode && !plainFormActive && !drafted && (
          <Input multiline rows={4} placeholder="what needs doing, in your own words — sloppy is fine here, sloppy completion criteria are not" value={dump} onChange={(e) => setDump(targetValue(e))} />
        )}
        {!issueMode && (plainFormActive || drafted) && (
          <React.Fragment>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: drafted ? 'var(--tide-4)' : 'var(--sun-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {drafted ? 'drafted — edit freely' : 'plain form — same fields, no draft'}
            </span>
            <Input label="Title" value={title} onChange={(e) => setTitle(targetValue(e))} />
            <Input label="Purpose" multiline rows={2} value={purpose} onChange={(e) => setPurpose(targetValue(e))} placeholder="state prerequisites here — the agent verifies and escalates cheaply" />
            <Input label="Completion criteria" multiline rows={2} value={criteria} onChange={(e) => setCriteria(targetValue(e))} placeholder="sloppy completion criteria are the expensive kind" />
            {/* a decompose child is always type work (decomposeTask's own ChildSpec has no type field) */}
            {!childMode && (
              <Select label="Type" options={['work', 'review']} value={type} onChange={(e) => setType(targetValue(e) === 'review' ? 'review' : 'work')} />
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Select label="Assignee" options={assigneeOptions} value={assignee} onChange={(e) => setAssignee(targetValue(e))} />
              <Select label="Workspace" options={workspaceOptions} value={workspace} onChange={(e) => setWorkspace(targetValue(e))} />
            </div>
            <Checkbox label="risk flag — this task has irreversible external effects" checked={risk} onChange={() => setRisk(!risk)} />
            <Checkbox label="review flag — request an on-completion review" checked={review} onChange={() => setReview(!review)} />
          </React.Fragment>
        )}
        <Button variant="primary" size="lg" full disabled={primaryAction.disabled} onClick={primaryAction.onClick}>{primaryAction.label}</Button>
        {childMode && (
          <Button variant="ghost" size="lg" full disabled={busy} onClick={onClose}>Cancel</Button>
        )}
      </Card>
      {!issueMode && (
        <button onClick={togglePlainForm}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: '10px 0 0', display: 'block' }}>
          {plainFormActive ? '← back to brain dump' : 'LLM unavailable? use the plain form'}
        </button>
      )}
      {gate && (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14, borderColor: 'var(--coral-3, var(--rock-3))' }}>
          <div style={{ fontWeight: 600 }}>the issue fails the registration gate</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{gate.missing}</div>
          {gate.suggested_comment && (
            <React.Fragment>
              <div style={{ fontSize: 'var(--text-sm)' }}>suggested comment — posting it to the issue is your approval:</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--text-sm)', background: 'var(--surface-sunken, rgba(0,0,0,0.06))', borderRadius: 8, padding: 10, margin: 0 }}>{gate.suggested_comment}</pre>
              <Button variant="primary" full disabled={busy} onClick={approveComment}>Approve — post to issue &amp; retry</Button>
            </React.Fragment>
          )}
        </Card>
      )}
    </div>
  );
}
