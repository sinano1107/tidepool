// Single-question push flow — TpSingleQuestion is the one-question(-bundle)
// answer screen a daytime push tap opens straight into: no triage transaction.
// Reuses TpQuestionCard (triage-screen.tsx), which owns the atomic submit
// itself (issue #30) — the card fires onAnswer once every item in the bundle
// has a pick, same one-tap-through model as triage.

// onAnswer(answers) receives one array entry per item, in item order, fired
// by TpQuestionCard the instant the bundle is fully answered — a live caller
// POSTs that array straight to /api/tasks/:id/answer.
// q の形は webui/app.tsx の toQuestionCardShape が作る —— 写しを書かずにそこから引く。
// onTranslate も同様に実体から引く。
interface TpSingleQuestionProps {
  q: ReturnType<typeof toQuestionCardShape>;
  onAnswer: (answers: string[], amendment?: TpAmendment) => void;
  onClose: () => void;
  onTranslate?: typeof translateTarget;
}

// biome-ignore lint/correctness/noUnusedVariables: rendered by webui/app.tsx — one concatenated bundle
function TpSingleQuestion({ q, onAnswer, onClose, onTranslate }: TpSingleQuestionProps) {
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
        {q.blocking ? `answering sends ${q.blocking} to the front · ` : ''}applies immediately · immediate poll if slot free · no transaction needed
      </p>
    </div>
  );
}
