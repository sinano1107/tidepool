// Single-question push flow — the deep-link target of a daytime push
// notification. TpPushBanner simulates the notification inside the app
// (demo only; the real notification is the OS/browser's own). TpSingleQuestion
// is the one-question(-bundle) answer screen a push tap opens straight into:
// no triage transaction. Reuses TpQuestionCard (triage-screen.jsx), which
// owns the atomic submit itself (issue #30) — the card fires onAnswer once
// every item in the bundle has a pick, same one-tap-through model as triage.
// Loaded as a text/babel script from index.html; components read from the DS
// bundle at render time.

function TpPushBanner({ q, onOpen, onDismiss }) {
  const headline = q.items.length > 1 ? `${q.items.length} questions` : q.items[0].title;
  return (
    <button onClick={onOpen}
      style={{
        position: 'absolute', top: 10, left: 12, right: 12, zIndex: 55, cursor: 'pointer', textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        background: 'var(--rock-6)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)',
      }}>
      <i data-lucide="bell" style={{ width: 16, height: 16, flexShrink: 0 }}></i>
      <span style={{ flex: 1, fontSize: 'var(--text-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <b>{q.agent}</b> asks: {headline}
      </span>
      <span onClick={(e) => { e.stopPropagation(); onDismiss(); }} style={{ fontSize: 'var(--text-sm)', opacity: 0.7, padding: '0 2px' }}>×</span>
    </button>
  );
}

// onAnswer(answers) receives one array entry per item, in item order, fired
// by TpQuestionCard the instant the bundle is fully answered — a live caller
// POSTs that array straight to /api/tasks/:id/answer.
function TpSingleQuestion({ q, onAnswer, onClose, onTranslate }) {
  const heading = q.items.length > 1 ? `${q.items.length} answers, then back to your day.` : 'One answer, then back to your day.';
  return (
    <div className="tp-rise" style={{ position: 'absolute', inset: 0, zIndex: 56, background: 'var(--surface-page)', display: 'flex', flexDirection: 'column', padding: '20px 16px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--tide-4)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>push → {q.items.length > 1 ? `${q.items.length} questions` : 'one question'}</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-lg)', cursor: 'pointer', padding: 0 }}>×</button>
      </div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 'var(--text-2xl)', fontWeight: 400, color: 'var(--tide-5)', margin: '0 0 16px', lineHeight: 1.15 }}>{heading}</h1>
      <TpQuestionCard q={q} answer={null} onAnswer={onAnswer} onTranslate={onTranslate} />
      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textAlign: 'center', marginTop: 12 }}>
        {q.parent ? `answering sends ${q.parent} to the front · ` : ''}applies immediately · immediate poll if slot free · no transaction needed
      </p>
    </div>
  );
}

Object.assign(window, { TpPushBanner, TpSingleQuestion });
