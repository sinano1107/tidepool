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

function TpQuestionCard({ q, answer, onAnswer }) {
  const { Card, Input, AgentChip } = window.TidepoolDesignSystem_8a0ead;
  const [override, setOverride] = React.useState(false);
  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{q.id}</span>
        <AgentChip name={q.agent} size="sm" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>{q.agent}</span>
        {q.parent && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>blocks {q.parent}</span>}
      </div>
      {q.kind === 'approval' && (
        <span style={{ display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sun-4)', background: 'var(--sun-1)', borderRadius: 'var(--radius-full)', padding: '2px 10px', marginBottom: 6 }}>
          out-of-authority → approval
        </span>
      )}
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', marginBottom: 4 }}>{q.title}</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: q.note ? 6 : 14 }}>{q.context}</div>
      {q.note && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--sun-4)', marginBottom: 14 }}>⚠ {q.note}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {q.options.map((o) => {
          const picked = answer === o.label;
          return (
            <button key={o.label} onClick={() => onAnswer(picked ? null : o.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)', fontWeight: picked ? 600 : 400,
                color: picked ? '#fff' : 'var(--text-body)',
                background: picked ? 'var(--tide-4)' : 'var(--surface-recessed)',
                border: 'none',
                boxShadow: picked ? 'var(--shadow-primary)' : 'none',
                borderRadius: 'var(--radius-full)', padding: '11px 18px', minHeight: 44, cursor: 'pointer',
                transition: 'background var(--duration-quick) var(--ease-tidal)',
              }}>
              <span style={{ flex: 1 }}>{o.label}</span>
              {o.recommended && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: picked ? 'var(--tide-2)' : 'var(--tide-4)' }}>recommended</span>}
            </button>
          );
        })}
        {override
          ? <Input multiline rows={2} placeholder="override answer — free text" />
          : <button onClick={() => setOverride(true)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', cursor: 'pointer', textAlign: 'left', padding: '2px 0' }}>override with free text…</button>}
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
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-body)', marginBottom: 6 }}>
              <span style={{ flex: 1 }}>{l}</span>
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

const TP_SCRATCH_KINDS = [
  { key: 'task', label: 'task' },
  { key: 'meta', label: 'meta-review' },
  { key: 'drop', label: 'discard' },
];

function TriageScreen({ data, onCommit, onReorderQueue, onFront }) {
  const { Button, Input, LogEntry, QueueItem } = window.TidepoolDesignSystem_8a0ead;
  const nQuestions = data.questions.length;
  // no questions overnight → the flow still exists for the log skim; start at section 2
  const [section, setSection] = React.useState(nQuestions ? 0 : 1);
  const [answers, setAnswers] = React.useState({});
  const [objections, setObjections] = React.useState({});
  const [objecting, setObjecting] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [scratch, setScratch] = React.useState([]);
  const [scratchKinds, setScratchKinds] = React.useState({});
  const answered = Object.values(answers).filter(Boolean).length;
  const unread = data.log.filter((l) => l.unread);
  const progress = (section + (section === 0 ? answered / Math.max(1, nQuestions) : 0)) / 3;

  const heads = [
    { step: '1 / 3 — questions', title: `The tide brought ${nQuestions} question${nQuestions === 1 ? '' : 's'}.`, sub: 'answers apply at commit; parents return to the front of the queue.', next: answered === nQuestions ? 'Log skim' : `Log skim (${nQuestions - answered} unanswered)` },
    { step: nQuestions ? '2 / 3 — decision log' : '2 / 3 — decision log · no questions today', title: `${unread.length} decisions made overnight.`, sub: 'silence is consent — tap an entry to object.', next: 'Queue check' },
    { step: '3 / 3 — queue', title: 'The tide is going out.', sub: 'front-inserted by this session highlighted. reorder is optional.', next: 'Commit' },
  ];
  const cur = heads[section];
  const scratchResolved = () => scratch.map((text, i) => ({ text, kind: scratchKinds[i] || 'task' }));

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
              <TpQuestionCard q={q} answer={answers[q.id]} onAnswer={(a) => setAnswers({ ...answers, [q.id]: a })} />
            </div>
          ))}
        </div>
      )}

      {section === 1 && (
        <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {data.log.map((l, i) => (
            <div key={i}>
              <LogEntry entry={{ ...l, objection: objections[i] }} active={objecting === i} onObject={() => { setObjecting(objecting === i ? null : i); setDraft(''); }} />
              {objecting === i && (
                <div style={{ padding: '10px 12px', background: 'var(--coral-1)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <Input multiline rows={2} placeholder="direction — steering, not rollback" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1 }} />
                  <Button variant="danger" size="sm" disabled={!draft.trim()} onClick={() => { setObjections({ ...objections, [objecting]: draft }); setObjecting(null); }}>Object</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {section === 2 && (() => {
        const pending = Object.entries(answers).filter(([, a]) => a)
          .map(([qid]) => data.questions.find((x) => x.id === qid))
          .filter((q) => q.parent)
          .map((q) => ({ id: q.parent, title: `unblocked by ${q.id}`, assignee: q.agent, frontInserted: true }));
        if (Object.keys(objections).length > 0) {
          pending.push({ id: 'tp-0151', title: `repair task — ${Object.keys(objections).length} objection${Object.keys(objections).length > 1 ? 's' : ''} bundled`, assignee: 'reef-crab', frontInserted: true });
        }
        return (
          <div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pending.map((t, i) => <QueueItem key={t.id} position={i + 1} task={t} frontInserted />)}
              <TpQueueList tasks={data.queue} baseIndex={pending.length} onReorder={onReorderQueue} onFront={onFront} />
            </div>
            {scratch.length > 0 && (
              <div style={{ marginTop: 20, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', padding: 14 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>scratchpad — triage before commit</div>
                {scratch.map((l, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <span style={{ flex: '1 1 100%', fontSize: 'var(--text-sm)', color: (scratchKinds[i] || 'task') === 'drop' ? 'var(--text-muted)' : 'var(--text-body)', textDecoration: (scratchKinds[i] || 'task') === 'drop' ? 'line-through' : 'none' }}>{l}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {TP_SCRATCH_KINDS.map((k) => {
                        const picked = (scratchKinds[i] || 'task') === k.key;
                        return (
                          <button key={k.key} onClick={() => setScratchKinds({ ...scratchKinds, [i]: k.key })}
                            style={{
                              fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', cursor: 'pointer',
                              color: picked ? '#fff' : 'var(--text-secondary)',
                              background: picked ? (k.key === 'drop' ? 'var(--rock-4)' : 'var(--tide-4)') : 'var(--surface-recessed)',
                              border: 'none', borderRadius: 'var(--radius-full)', padding: '4px 12px',
                            }}>{k.label}</button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        {section > (nQuestions ? 0 : 1) && <Button variant="ghost" size="lg" onClick={() => setSection(section - 1)}>Back</Button>}
        <Button variant="primary" size="lg" full onClick={() => (section < 2 ? setSection(section + 1) : onCommit(answers, objections, scratchResolved()))}>{cur.next}</Button>
      </div>
      <TpScratchpad lines={scratch} onAdd={(l) => setScratch([...scratch, l])} onRemove={(i) => {
        setScratch(scratch.filter((_, j) => j !== i));
        setScratchKinds((prev) => {
          const next = {};
          Object.entries(prev).forEach(([j, v]) => { const n = +j; if (n < i) next[n] = v; else if (n > i) next[n - 1] = v; });
          return next;
        });
      }} />
      {section === 2 && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
          commit applies everything in one transaction · immediate poll if slot free
        </p>
      )}
    </div>
  );
}

Object.assign(window, { TriageScreen, TpQuestionCard, TpWaterline, TpSegmentGauge });
