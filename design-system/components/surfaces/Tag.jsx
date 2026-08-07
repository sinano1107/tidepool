const tagColors = {
  neutral: { color: 'var(--rock-5)', background: 'var(--rock-1)' },
  tide:    { color: 'var(--tide-4)', background: 'var(--tide-1)' },
  sun:     { color: 'var(--sun-4)', background: 'var(--sun-1)' },
  coral:   { color: 'var(--coral-4)', background: 'var(--coral-1)' },
  grass:   { color: 'var(--grass-4)', background: 'var(--grass-1)' },
};

export function Tag({ color = 'neutral', mono = false, children, style }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
      fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-medium)',
      padding: '3px 10px', borderRadius: 'var(--radius-full)',
      whiteSpace: 'nowrap',
      ...tagColors[color],
      ...style,
    }}>
      {children}
    </span>
  );
}
