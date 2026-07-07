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
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', marginBottom: 4 }}>{q.title}</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 14 }}>{q.context}</div>
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

function TriageScreen({ data, onCommit, onReorderQueue, onFront }) {
  const { Button, Input, LogEntry, QueueItem } = window.TidepoolDesignSystem_8a0ead;
  const [section, setSection] = React.useState(0);
  const [answers, setAnswers] = React.useState({});
  const [objections, setObjections] = React.useState({});
  const [objecting, setObjecting] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const answered = Object.values(answers).filter(Boolean).length;
  const unread = data.log.filter((l) => l.unread);
  const progress = (section + (section === 0 ? answered / data.questions.length : 0)) / 3;

  const heads = [
    { step: '1 / 3 — questions', title: `The tide brought ${data.questions.length} questions.`, sub: 'answers apply at commit; parents return to the front of the queue.', next: answered === data.questions.length ? 'Log skim' : `Log skim (${data.questions.length - answered} unanswered)` },
    { step: '2 / 3 — decision log', title: `${unread.length} decisions made overnight.`, sub: 'silence is consent — tap an entry to object.', next: 'Queue check' },
    { step: '3 / 3 — queue', title: 'The tide is going out.', sub: 'front-inserted by this session highlighted. reorder is optional.', next: 'Commit' },
  ];
  const cur = heads[section];

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pending.map((t, i) => <QueueItem key={t.id} position={i + 1} task={t} frontInserted />)}
            <TpQueueList tasks={data.queue} baseIndex={pending.length} onReorder={onReorderQueue} onFront={onFront} />
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        {section > 0 && <Button variant="ghost" size="lg" onClick={() => setSection(section - 1)}>Back</Button>}
        <Button variant="primary" size="lg" full onClick={() => (section < 2 ? setSection(section + 1) : onCommit(answers, objections))}>{cur.next}</Button>
      </div>
      {section === 2 && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
          commit applies everything in one transaction · immediate poll if slot free
        </p>
      )}
    </div>
  );
}

Object.assign(window, { TriageScreen, TpQuestionCard, TpWaterline, TpSegmentGauge });
