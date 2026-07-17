// Triage flow — section 1 questions → section 2 log skim → section 3 queue check → commit
// Loaded as a text/babel script from index.html; components read from the DS bundle at render time.

function TpWaterline({ progress }) {
  return (
    <div style={{ height: 2, background: 'var(--rock-2)', position: 'relative', borderRadius: 1 }}>
      <div style={{ position: 'absolute', inset: '0 auto 0 0', width: `${progress * 100}%`, background: 'var(--tide-4)', borderRadius: 1, transition: 'width var(--duration-slow) var(--ease-tidal)' }}></div>
    </div>
  );
}

function TpSegmentGauge({ total, filled }) {
  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{ flex: 1, height: 6, borderRadius: 999, background: i < filled ? 'var(--tide-4)' : 'var(--tide-2)', transition: 'background var(--duration-calm) var(--ease-tidal)' }}></div>
      ))}
    </div>
  );
}

// One question item's option list — one-tap pick, or a free-text override.
// Fires onChange(label) the instant a pick is made; TpQuestionCard above
// decides when every item in the bundle has a pick and submits the whole
// answer set atomically (issue #30) — this component only ever reports its
// own item's value, never submits on its own.
function TpQuestionItemPicker({ item, value, locked, onChange }) {
  const { Input, Button } = window.TidepoolDesignSystem_8a0ead;
  const [override, setOverride] = React.useState(false);
  const [overrideText, setOverrideText] = React.useState('');
  return (
    <div>
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', marginBottom: item.detail ? 3 : 8 }}>{item.title}</div>
      {item.detail && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 8 }}>{item.detail}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {item.options.map((o) => {
          const picked = value === o.label;
          return (
            <button key={o.label} onClick={() => !locked && onChange(picked ? null : o.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)', fontWeight: picked ? 600 : 400,
                color: picked ? '#fff' : 'var(--text-body)',
                background: picked ? 'var(--tide-4)' : 'var(--surface-recessed)',
                border: 'none',
                boxShadow: picked ? 'var(--shadow-primary)' : 'none',
                borderRadius: 'var(--radius-full)', padding: '11px 18px', minHeight: 44,
                cursor: locked ? 'default' : 'pointer',
                opacity: locked && !picked ? 0.45 : 1,
                transition: 'background var(--duration-quick) var(--ease-tidal)',
              }}>
              <span style={{ flex: 1 }}>{o.label}</span>
              {o.recommended && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: picked ? 'var(--tide-2)' : 'var(--tide-4)' }}>recommended</span>}
            </button>
          );
        })}
        {locked && value && !item.options.some((o) => o.label === value) && (
          <div style={{ fontSize: 'var(--text-sm)', color: '#fff', background: 'var(--tide-4)', borderRadius: 'var(--radius-full)', padding: '11px 18px', boxShadow: 'var(--shadow-primary)' }}>{value}</div>
        )}
        {locked ? null : override
          ? <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <Input multiline rows={2} placeholder="override answer — free text" value={overrideText} onChange={(e) => setOverrideText(e.target.value)} style={{ flex: 1 }} />
              <Button variant="secondary" size="sm" disabled={!overrideText.trim()} onClick={() => { onChange(overrideText.trim()); setOverride(false); setOverrideText(''); }}>Set</Button>
            </div>
          : <button onClick={() => setOverride(true)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', cursor: 'pointer', textAlign: 'left', padding: '2px 0' }}>override with free text…</button>}
      </div>
    </div>
  );
}

// One question task's card: the shared context (its `purpose`) once, then
// every item's picker (issue #30 — a single-item bundle is the degenerate,
// most common case). The card owns its own in-progress picks and fires
// onAnswer(answers) — one array entry per item, in item order — the instant
// every item has a pick, submitting the whole bundle in one shot. This keeps
// the existing one-tap ethos for the common single-item case (it fires on
// that one tap) and generalizes it to a multi-item bundle (it fires on
// whichever tap completes the set) — there is never a separate "submit"
// button, and never a partial-answer state (CONTEXT.md's Question).
function TpQuestionCard({ q, answer, onAnswer, locked }) {
  const { Card, AgentChip } = window.TidepoolDesignSystem_8a0ead;
  const items = q.items;
  const [draft, setDraft] = React.useState(() => answer ?? items.map(() => null));
  // a server-confirmed answer (locked) always wins over in-progress local picks
  React.useEffect(() => { if (answer) setDraft(answer); }, [answer]);
  const setItemAnswer = (i, value) => {
    const next = draft.slice();
    next[i] = value;
    setDraft(next);
    if (next.every(Boolean)) onAnswer(next);
  };
  const answeredCount = draft.filter(Boolean).length;
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{q.id}</span>
        <AgentChip name={q.agent} icon={q.agentIcon} size="sm" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>{q.agent}</span>
        {q.parent && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>blocks {q.parent}</span>}
      </div>
      {q.kind === 'approval' && (
        <span style={{ display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sun-4)', background: 'var(--sun-1)', borderRadius: 'var(--radius-full)', padding: '2px 10px', marginBottom: 6 }}>
          out-of-authority → approval
        </span>
      )}
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: q.note ? 6 : 14 }}>{q.context}</div>
      {q.note && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--sun-4)', marginBottom: 14 }}>⚠ {q.note}</div>}
      {items.length > 1 && !locked && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
          {answeredCount} of {items.length} answered — submits together once every item is
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {items.map((item, i) => (
          <TpQuestionItemPicker key={i} item={item} value={draft[i]} locked={locked} onChange={(v) => setItemAnswer(i, v)} />
        ))}
      </div>
    </Card>
  );
}

// Shared scratchpad — pain capture across all triage sections. Free text is
// allowed here by design: human steering information is itself the payload.
function TpScratchpad({ lines, onAdd, onRemove }) {
  const { Button, Input } = window.TidepoolDesignSystem_8a0ead;
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const add = () => { if (draft.trim()) { onAdd(draft.trim()); setDraft(''); } };
  React.useEffect(() => { lucide.createIcons(); });
  // portal: the tab-switch animation's transform hijacks position:fixed inside the app tree
  return ReactDOM.createPortal(
    <>
      <button onClick={() => setOpen(!open)} aria-label="scratchpad"
        style={{
          position: 'fixed', bottom: 118, right: 'max(16px, calc(50vw - 204px))', zIndex: 30,
          width: 44, height: 44, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer',
          background: open ? 'var(--tide-4)' : 'var(--surface-card)', color: open ? '#fff' : 'var(--tide-4)',
          boxShadow: 'var(--shadow-card)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        <i data-lucide="notebook-pen" style={{ width: 18, height: 18 }}></i>
        {lines.length > 0 && !open && (
          <span style={{ position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 999, background: 'var(--sun-4)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>{lines.length}</span>
        )}
      </button>
      {open && (
        <div style={{ position: 'fixed', bottom: 170, right: 'max(16px, calc(50vw - 204px))', zIndex: 30, width: 300, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)', padding: 12 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>scratchpad — "this again?"</div>
          {lines.map((l, i) => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-body)', marginBottom: 6 }}>
              <span style={{ flex: 1 }}>{l.text}</span>
              <button onClick={() => onRemove(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>×</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <Input multiline rows={1} placeholder="jot the irritation — triaged at commit" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1 }} />
            <Button variant="secondary" size="sm" disabled={!draft.trim()} onClick={add}>Add</Button>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}

// keys are the domain's disposition vocabulary (task / meta_review / discard)
// so no translation layer sits between the screen and the commit API
const TP_SCRATCH_KINDS = [
  { key: 'task', label: 'task' },
  { key: 'meta_review', label: 'meta-review' },
  { key: 'discard', label: 'discard' },
];

// Decision log workspace grouping (issue #44): the API stays flat and only
// annotates each entry with a resolved `workspace` name (null when neither
// the task nor the board names one) — grouping, sort order, and the
// read/unread fold are all client-side view derivation over that flat list,
// re-run from scratch on every render (nothing about it is persisted).
const LOG_READ_BATCH = 8;
const NO_WORKSPACE_LABEL = 'no workspace';

// Groups `data.log` by workspace, sorted groups-with-unread-first (most
// recent unread first), then fully-read groups (most recent entry first).
// Within a group, entries are chronological (oldest first) — because the
// read cursor is a single forward-only watermark, read entries are always
// exactly the group's oldest-side prefix, so there is exactly one fold per
// group (the caller decides how much of that prefix to reveal).
//
// Each entry is stamped with `chronoKey` (its sort order) and `sourceIndex`
// (its position in the input array) — `logKey` below falls back to
// `sourceIndex` for the standalone kit's mock data, which has no `id`.
function groupLogEntries(entries) {
  const byWorkspace = new Map();
  entries.forEach((l, i) => {
    // real entries always carry an id (ascending = chronological); the
    // standalone kit's mock data doesn't, so its own (newest-first) array
    // order stands in instead
    const withKeys = { ...l, chronoKey: l.id != null ? l.id : -i, sourceIndex: i };
    const key = l.workspace || '';
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(withKeys);
  });
  const groups = [...byWorkspace.entries()].map(([key, groupEntries]) => {
    const sorted = groupEntries.slice().sort((a, b) => a.chronoKey - b.chronoKey);
    const unreadEntries = sorted.filter((l) => l.unread);
    return {
      key,
      label: key || NO_WORKSPACE_LABEL,
      entries: sorted,
      unreadCount: unreadEntries.length,
      readCount: sorted.length - unreadEntries.length,
      mostRecentUnread: unreadEntries.length ? Math.max(...unreadEntries.map((l) => l.chronoKey)) : null,
      mostRecent: Math.max(...sorted.map((l) => l.chronoKey)),
    };
  });
  groups.sort((a, b) => {
    if ((a.unreadCount > 0) !== (b.unreadCount > 0)) return a.unreadCount > 0 ? -1 : 1;
    return a.unreadCount > 0 ? b.mostRecentUnread - a.mostRecentUnread : b.mostRecent - a.mostRecent;
  });
  return groups;
}

// Live-mode props (all optional — absent, the screen runs standalone on mock
// data): onAnswer / onObject / onScratchAdd persist immediately (中断安全),
// onDisplayed records the skimmed entries, loadPreview fetches the server's
// staged S3 queue. onCommit always closes the flow.
function TriageScreen({ data, onCommit, onReorderQueue, onFront, loadHandoff, onAnswer, onObject, onScratchAdd, onDisplayed, loadPreview }) {
  const { Button, Input, LogEntry, QueueItem } = window.TidepoolDesignSystem_8a0ead;
  const nQuestions = data.questions.length;
  // no questions overnight → the flow still exists for the log skim; start at section 2
  const [section, setSection] = React.useState(nQuestions ? 0 : 1);
  const [answers, setAnswers] = React.useState({});
  const [objections, setObjections] = React.useState({});
  const [objecting, setObjecting] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [scratch, setScratch] = React.useState([]);       // [{ id, text }]
  const [dropped, setDropped] = React.useState([]);       // persisted lines removed in-UI → discard at commit
  const [scratchKinds, setScratchKinds] = React.useState({}); // keyed by line id
  const scratchSeq = React.useRef(0);
  const [preview, setPreview] = React.useState(null);

  // live answers are one-way: a persisted answer cannot be untapped or replaced
  const answerQ = async (q, a) => {
    if (onAnswer) {
      if (!a || answers[q.id]) return;
      try { await onAnswer(q, a); } catch { return; }
    }
    setAnswers((prev) => ({ ...prev, [q.id]: a }));
  };

  const addScratch = async (text) => {
    let entry = { id: `pad-${scratchSeq.current++}`, text };
    if (onScratchAdd) {
      try { entry = await onScratchAdd(text); } catch { return; }
    }
    setScratch((prev) => [...prev, entry]);
  };
  const removeScratch = (i) => {
    const entry = scratch[i];
    setScratch((prev) => prev.filter((_, j) => j !== i));
    // a server-persisted line cannot be unwritten — it is dispositioned as discard at commit
    if (onScratchAdd) setDropped((prev) => [...prev, entry]);
  };

  const refreshPreview = () => {
    if (loadPreview) loadPreview().then(setPreview).catch(() => {});
  };
  React.useEffect(() => { if (section === 2) refreshPreview(); }, [section]);
  // "displayed" is an event: the objection-rate denominator counts only what
  // was actually put in front of the human — an entry reports once it is
  // genuinely in the viewport, not merely because the skim section mounted
  const logListRef = React.useRef(null);
  const displayedSeen = React.useRef(new Set());
  React.useEffect(() => {
    if (section !== 1 || !onDisplayed || !logListRef.current) return;
    const byId = new Map(data.log.filter((l) => l.unread).map((l) => [String(l.id), l]));
    const io = new IntersectionObserver((observed) => {
      const shown = [];
      for (const o of observed) {
        if (!o.isIntersecting) continue;
        const id = o.target.dataset.entryId;
        if (byId.has(id) && !displayedSeen.current.has(id)) {
          displayedSeen.current.add(id);
          shown.push(byId.get(id));
        }
      }
      if (shown.length) onDisplayed(shown);
    }, { threshold: 0.5 });
    logListRef.current.querySelectorAll('[data-entry-id]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [section]);
  // completion rows carry a handoff doc: tap unfolds it in place (the log's
  // link back to the deliverable) and the objection entry point moves inside
  // the expansion. decision rows keep tap = object.
  // per-entry state is keyed by the entry's stable id (falling back to
  // `sourceIndex` for id-less mock data) so a log refresh can't retarget an
  // objection at a different line, and grouping/reordering can't either.
  // Only ever called on group-derived entries (groupLogEntries stamps
  // `sourceIndex` on every entry it returns) — never on a raw `data.log` row.
  const logKey = (entry) => (entry.id != null ? entry.id : entry.sourceIndex);
  // one fold per workspace group (issue #44): how many of a group's read
  // entries are revealed, keyed by group key, growing by LOG_READ_BATCH per
  // tap starting from the most recent (closest to the unread boundary) and
  // working backward. A group with zero unread stays hidden entirely until
  // the section-wide toggle below flips it into view — the one control that
  // makes every workspace reachable; its own read entries still fold same as
  // any other group's, one more tap away.
  const [revealedRead, setRevealedRead] = React.useState({});
  const [showFullyReadWorkspaces, setShowFullyReadWorkspaces] = React.useState(false);
  const allLogGroups = React.useMemo(() => groupLogEntries(data.log), [data.log]);
  const fullyReadGroups = allLogGroups.filter((g) => g.unreadCount === 0);
  const logGroups = showFullyReadWorkspaces ? allLogGroups : allLogGroups.filter((g) => g.unreadCount > 0);
  // iOS Safari has no CSS overflow-anchor: revealing an older batch inserts
  // content above the reader's current position, which would otherwise jump
  // the viewport by the inserted height. Captured synchronously in the click
  // handler (before the reveal), applied in the same frame the reveal paints.
  // `<main class="tp-scroll">` (index.html, both the live app and the
  // standalone kit preview) is the actual scrolling element — this list's
  // own div is just a layout container inside it.
  const scrollContainer = () => logListRef.current && logListRef.current.closest('.tp-scroll');
  const pendingScrollFix = React.useRef(null);
  React.useLayoutEffect(() => {
    const fix = pendingScrollFix.current;
    pendingScrollFix.current = null;
    const container = scrollContainer();
    if (!fix || !container) return;
    container.scrollTop = fix.scrollTop + (container.scrollHeight - fix.scrollHeight);
  });
  const expandRead = (groupKey) => {
    const container = scrollContainer();
    pendingScrollFix.current = container
      ? { scrollTop: container.scrollTop, scrollHeight: container.scrollHeight }
      : null;
    setRevealedRead((prev) => ({ ...prev, [groupKey]: (prev[groupKey] || 0) + LOG_READ_BATCH }));
  };
  const [handoffOpen, setHandoffOpen] = React.useState({});
  const handoffCache = React.useRef({});
  const toggleObjecting = (k) => { setObjecting(objecting === k ? null : k); setDraft(''); };
  const toggleHandoff = async (k, entry) => {
    if (handoffOpen[k]) { setHandoffOpen((prev) => ({ ...prev, [k]: false })); return; }
    if (handoffCache.current[k] == null) {
      try {
        handoffCache.current[k] = entry.handoff != null ? entry.handoff : await loadHandoff(entry);
      } catch {
        handoffCache.current[k] = '(handoff doc failed to load)';
      }
    }
    setHandoffOpen((prev) => ({ ...prev, [k]: true }));
  };
  const answered = Object.values(answers).filter(Boolean).length;
  const unread = data.log.filter((l) => l.unread);
  const progress = (section + (section === 0 ? answered / Math.max(1, nQuestions) : 0)) / 3;

  const heads = [
    { step: '1 / 3 — questions', title: `The tide brought ${nQuestions} question${nQuestions === 1 ? '' : 's'}.`, sub: 'answers persist at once; unblocked parents surface at the front on commit.', next: answered === nQuestions ? 'Log skim' : `Log skim (${nQuestions - answered} unanswered)` },
    { step: nQuestions ? '2 / 3 — decision log' : '2 / 3 — decision log · no questions today', title: `${unread.length} decisions made overnight.`, sub: 'silence is consent — tap an entry to object.', next: 'Queue check' },
    { step: '3 / 3 — queue', title: 'The tide is going out.', sub: loadPreview ? 'front-inserted by this session highlighted. the queue applies at commit.' : 'front-inserted by this session highlighted. reorder is optional.', next: 'Commit' },
  ];
  const cur = heads[section];
  const scratchResolved = () => [
    ...scratch.map((s) => ({ id: s.id, text: s.text, kind: scratchKinds[s.id] || 'task' })),
    ...dropped.map((s) => ({ id: s.id, text: s.text, kind: 'discard' })),
  ];

  return (
    <div key={section} style={{ padding: '20px 16px 28px' }}>
      <div className="tp-rise" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>{cur.step}</div>
      <h1 className="tp-rise" style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', fontWeight: 400, color: 'var(--tide-5)', margin: '0 0 4px', lineHeight: 1.15, animationDelay: '60ms' }}>{cur.title}</h1>
      <p className="tp-rise" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 20px', animationDelay: '120ms' }}>{cur.sub}</p>
      {section === 0 ? <TpSegmentGauge total={data.questions.length} filled={answered} /> : <TpWaterline progress={progress} />}
      <div style={{ height: 20 }}></div>

      {section === 0 && (
        <div>
          {data.questions.map((q, i) => (
            <div key={q.id} className="tp-rise" style={{ animationDelay: `${180 + i * 90}ms` }}>
              <TpQuestionCard q={q} answer={answers[q.id]} onAnswer={(a) => answerQ(q, a)} locked={!!onAnswer && !!answers[q.id]} />
            </div>
          ))}
        </div>
      )}

      {section === 1 && (() => {
        // renders one entry row + its handoff/objection expansion — shared by
        // every group's revealed-read and unread rows below
        const renderLogRow = (l) => {
          const k = logKey(l);
          const hasHandoff = l.kind === 'completion' && (l.handoff != null || (loadHandoff && l.handoffPresent));
          return (
            <div key={k} data-entry-id={l.unread && l.id != null ? l.id : undefined}>
              <LogEntry entry={{ ...l, objection: objections[k] }} active={objecting === k} onObject={() => (hasHandoff ? toggleHandoff(k, l) : toggleObjecting(k))} />
              {handoffOpen[k] && (
                <div style={{ padding: '10px 14px 12px', background: 'var(--surface-recessed)' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>handoff — {l.taskId}</div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', lineHeight: 1.6, color: 'var(--text-body)', overflowX: 'auto' }}>{handoffCache.current[k]}</pre>
                  {objecting !== k && (
                    <button onClick={() => toggleObjecting(k)} style={{ background: 'none', border: 'none', color: 'var(--coral-4)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: '8px 0 0', display: 'block' }}>object to this completion…</button>
                  )}
                </div>
              )}
              {objecting === k && (
                <div style={{ padding: '10px 12px', background: 'var(--coral-1)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <Input multiline rows={2} placeholder="direction — steering, not rollback" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1 }} />
                  <Button variant="danger" size="sm" disabled={!draft.trim()} onClick={async () => {
                    // live mode: the annotation is persisted the moment it is raised
                    if (onObject) {
                      try { await onObject(l, draft); } catch { return; }
                    }
                    setObjections({ ...objections, [k]: draft });
                    setObjecting(null);
                  }}>Object</Button>
                </div>
              )}
            </div>
          );
        };
        return (
          <div>
            {fullyReadGroups.length > 0 && (
              <button onClick={() => setShowFullyReadWorkspaces((v) => !v)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px 10px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {showFullyReadWorkspaces
                  ? 'hide fully-read workspaces'
                  : `show ${fullyReadGroups.length} fully-read workspace${fullyReadGroups.length > 1 ? 's' : ''} too`}
              </button>
            )}
            <div ref={logListRef} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {logGroups.map((g) => {
                const revealed = Math.min(revealedRead[g.key] || 0, g.readCount);
                const hiddenCount = g.readCount - revealed;
                const visibleReadEntries = g.entries.slice(hiddenCount, g.readCount);
                const unreadEntries = g.entries.slice(g.readCount);
                return (
                  <div key={g.key} style={{ background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 12px', background: 'var(--surface-recessed)', borderBottom: '1px solid var(--border-hairline)' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{g.label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                        {g.unreadCount > 0 ? `${g.unreadCount} unread` : `${g.readCount} read`}
                      </span>
                    </div>
                    {hiddenCount > 0 && (
                      <button onClick={() => expandRead(g.key)}
                        style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer', padding: '8px 12px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {hiddenCount} more read decision{hiddenCount > 1 ? 's' : ''} — show
                      </button>
                    )}
                    {visibleReadEntries.map(renderLogRow)}
                    {unreadEntries.map(renderLogRow)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {section === 2 && (() => {
        const nObjections = Object.keys(objections).length;
        const scratchPanel = scratch.length > 0 && (
          <div style={{ marginTop: 20, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', padding: 14 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>scratchpad — triage before commit</div>
            {scratch.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ flex: '1 1 100%', fontSize: 'var(--text-sm)', color: (scratchKinds[l.id] || 'task') === 'discard' ? 'var(--text-muted)' : 'var(--text-body)', textDecoration: (scratchKinds[l.id] || 'task') === 'discard' ? 'line-through' : 'none' }}>{l.text}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {TP_SCRATCH_KINDS.map((k) => {
                    const picked = (scratchKinds[l.id] || 'task') === k.key;
                    return (
                      <button key={k.key} onClick={() => setScratchKinds({ ...scratchKinds, [l.id]: k.key })}
                        style={{
                          fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', cursor: 'pointer',
                          color: picked ? '#fff' : 'var(--text-secondary)',
                          background: picked ? (k.key === 'discard' ? 'var(--rock-4)' : 'var(--tide-4)') : 'var(--surface-recessed)',
                          border: 'none', borderRadius: 'var(--radius-full)', padding: '4px 12px',
                        }}>{k.label}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
        // live mode: the server's staged preview is the truth — this session's
        // front-inserts arrive on top, already highlighted. Read-only: nothing
        // touches the queue before commit (a mid-session reorder would break
        // the "abandoning triage never changes the queue" guarantee), so
        // reorder/front stay on the queue screen.
        if (loadPreview) {
          return (
            <div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <TpQueueList tasks={preview ?? []} />
              </div>
              {nObjections > 0 && (
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 10 }}>
                  {nObjections} objection{nObjections > 1 ? 's' : ''} bundle into repair tasks at commit — one per objected task, queue tail
                </p>
              )}
              {scratchPanel}
            </div>
          );
        }
        const pending = Object.entries(answers).filter(([, a]) => a)
          .map(([qid]) => data.questions.find((x) => x.id === qid))
          .filter((q) => q.parent)
          .map((q) => ({ id: q.parent, title: `unblocked by ${q.id}`, assignee: q.agent, assigneeIcon: q.agentIcon, frontInserted: true }));
        if (nObjections > 0) {
          pending.push({ id: 'tp-0151', title: `repair task — ${nObjections} objection${nObjections > 1 ? 's' : ''} bundled`, assignee: 'reef-crab', frontInserted: true });
        }
        // a pending front-insert may already sit in the queue as a blocked row — show it once, up top
        const previewQueue = data.queue.filter((t) => !pending.some((p) => p.id === t.id));
        return (
          <div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pending.map((t, i) => <QueueItem key={t.id} position={i + 1} task={t} frontInserted />)}
              {/* headId is the true queue head, not previewQueue[0] — pending's front-inserts sit
                 above this list, so previewQueue[0] can still be the actual head even though it
                 isn't rendered at this list's own index 0 (issue #82 follow-up) */}
              <TpQueueList tasks={previewQueue} baseIndex={pending.length} onReorder={onReorderQueue} onFront={onFront} headId={data.queue[0]?.id} />
            </div>
            {scratchPanel}
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        {section > (nQuestions ? 0 : 1) && <Button variant="ghost" size="lg" onClick={() => setSection(section - 1)}>Back</Button>}
        <Button variant="primary" size="lg" full onClick={() => (section < 2 ? setSection(section + 1) : onCommit(answers, objections, scratchResolved()))}>{cur.next}</Button>
      </div>
      <TpScratchpad lines={scratch} onAdd={addScratch} onRemove={removeScratch} />
      {section === 2 && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
          commit applies everything in one transaction · immediate poll if slot free
        </p>
      )}
    </div>
  );
}

Object.assign(window, { TriageScreen, TpQuestionCard, TpQuestionItemPicker, TpWaterline, TpSegmentGauge });
