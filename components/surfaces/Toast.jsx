const toastKinds = {
  info:    { border: 'var(--tide-3)', icon: 'var(--tide-4)' },
  success: { border: 'var(--grass-2)', icon: 'var(--grass-3)' },
  warn:    { border: 'var(--sun-2)', icon: 'var(--sun-3)' },
  danger:  { border: 'var(--coral-2)', icon: 'var(--coral-3)' },
};

export function Toast({ kind = 'info', children, detail, onDismiss, style }) {
  const k = toastKinds[kind];
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      background: 'var(--surface-card)', color: 'var(--text-heading)',
      borderRadius: 'var(--radius-full)', boxShadow: 'var(--shadow-overlay)',
      padding: '12px 18px', maxWidth: 420,
      fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)',
      ...style,
    }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: k.icon, marginTop: 6, flexShrink: 0 }}></span>
      <div style={{ flex: 1 }}>
        <div>{children}</div>
        {detail && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 3, fontWeight: 400 }}>{detail}</div>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1, alignSelf: 'center', flexShrink: 0 }}>✕</button>
      )}
    </div>
  );
}
