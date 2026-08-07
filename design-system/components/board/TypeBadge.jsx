const typeStyles = {
  work:     { color: 'var(--type-work-fg)', symbol: '●' },
  question: { color: 'var(--type-question-fg)', symbol: '?' },
  review:   { color: 'var(--type-review-fg)', symbol: '◍' },
};

export function TypeBadge({ type = 'work', showLabel = true, style }) {
  const t = typeStyles[type];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
      color: t.color, whiteSpace: 'nowrap',
      ...style,
    }}>
      <span aria-hidden="true" style={{ fontSize: 10 }}>{t.symbol}</span>
      {showLabel && type}
    </span>
  );
}
