const chipPalette = ['var(--tide-3)', 'var(--sun-3)', 'var(--coral-3)', 'var(--grass-3)', 'var(--rock-5)'];

// Species icons — the one sanctioned emoji use (visual identity for agents, never in copy).
const speciesIcons = { 'reef-crab': '🦀', 'anemone': '🪸', 'hermit': '🐚' };

export function AgentChip({ name = '', human = false, size = 'md', style }) {
  const px = size === 'sm' ? 20 : 26;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const species = human ? '🧍' : speciesIcons[name];
  const bg = species ? 'var(--tide-1)' : chipPalette[Math.abs(hash) % chipPalette.length];
  const initials = name.split(/[-_ ]/).map((w) => w[0]).join('').slice(0, 2);
  return (
    <span title={human ? 'you' : name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <span aria-hidden="true" style={{
        width: px, height: px, borderRadius: '50%', background: bg, color: '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono)', fontSize: species ? px * 0.58 : px * 0.42, fontWeight: 500, flexShrink: 0,
      }}>{species || initials}</span>
      {size !== 'sm' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{human ? 'you' : name}</span>}
    </span>
  );
}
