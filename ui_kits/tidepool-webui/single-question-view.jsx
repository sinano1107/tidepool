// Single-question push flow — the deep-link target of a daytime push
// notification. TpPushBanner simulates the notification inside the app
// (demo only; the real notification is the OS/browser's own). TpSingleQuestion
// is the one-question answer screen a push tap opens straight into: one
// answer, unambiguous consequence, no triage transaction. Reuses
// TpQuestionCard (triage-screen.jsx) for the question itself.
// Loaded as a text/babel script from index.html; components read from the DS
// bundle at render time.

function TpPushBanner({ q, onOpen, onDismiss }) {
  return (
    <button onClick={onOpen}
      style={{
        position: 'absolute', top: 10, left: 12, right: 12, zIndex: 55, cursor: 'pointer', textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        background: 'var(--rock-6)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)',
      }}>
      <i data-lucide="bell" style={{ width: 16, height: 16, flexShrink: 0 }}></i>
      <span style={{ flex: 1, fontSize: 'var(--text-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <b>{q.agent}</b> asks: {q.title}
      </span>
      <span onClick={(e) => { e.stopPropagation(); onDismiss(); }} style={{ fontSize: 'var(--text-sm)', opacity: 0.7, padding: '0 2px' }}>×</span>
    </button>
  );
}

// onAnswer(answer) receives the picked option's label — the demo ignores the
// argument (it always just moves the parent to front), but a live caller
// needs it to POST the actual answer.
function TpSingleQuestion({ q, onAnswer, onClose }) {
  const { Button } = window.TidepoolDesignSystem_8a0ead;
  const [answer, setAnswer] = React.useState(null);
  return (
    <div className="tp-rise" style={{ position: 'absolute', inset: 0, zIndex: 56, background: 'var(--surface-page)', display: 'flex', flexDirection: 'column', padding: '20px 16px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>push → one question</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-lg)', cursor: 'pointer', padding: 0 }}>×</button>
      </div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', fontWeight: 400, color: 'var(--tide-5)', margin: '0 0 16px', lineHeight: 1.15 }}>One answer, then back to your day.</h1>
      <TpQuestionCard q={q} answer={answer} onAnswer={setAnswer} />
      <Button variant="primary" size="lg" full disabled={!answer} onClick={() => onAnswer(answer)}>Answer{q.parent ? ` — ${q.parent} to front` : ''}</Button>
      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
        applies immediately · immediate poll if slot free · no transaction needed for one answer
      </p>
    </div>
  );
}

Object.assign(window, { TpPushBanner, TpSingleQuestion });
