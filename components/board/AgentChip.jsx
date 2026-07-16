const chipPalette = ['var(--tide-3)', 'var(--sun-3)', 'var(--coral-3)', 'var(--grass-3)', 'var(--rock-5)'];

// The one sanctioned emoji use (visual identity for agents, never in copy).
// icon is caller-supplied, not looked up here — a multi-character or empty
// icon falls back to initials the same as an absent one.
function isSingleGrapheme(value) {
  if (!value) return false;
  const segments = [...new Intl.Segmenter().segment(value)];
  return segments.length === 1 && segments[0].segment === value;
}

export function AgentChip({ name = '', icon, human = false, size = 'md', style }) {
  const px = size === 'sm' ? 20 : 26;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const glyph = human ? '🧍' : (isSingleGrapheme(icon) ? icon : undefined);
  const bg = glyph ? 'var(--tide-1)' : chipPalette[Math.abs(hash) % chipPalette.length];
  const initials = name.split(/[-_ ]/).map((w) => w[0]).join('').slice(0, 2);
  return (
    <span title={human ? 'you' : name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <span aria-hidden="true" style={{
        width: px, height: px, borderRadius: '50%', background: bg, color: '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono)', fontSize: glyph ? px * 0.58 : px * 0.42, fontWeight: 500, flexShrink: 0,
      }}>{glyph || initials}</span>
      {size !== 'sm' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{human ? 'you' : name}</span>}
    </span>
  );
}
