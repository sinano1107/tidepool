export function RiskFlag({ style }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)',
      color: 'var(--risk-fg)', background: 'var(--risk-bg)',
      padding: '2px 8px', borderRadius: 'var(--radius-xs)', whiteSpace: 'nowrap',
      ...style,
    }}>
      <span aria-hidden="true">⚠</span> risk
    </span>
  );
}
