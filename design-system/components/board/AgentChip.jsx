const chipPalette = ['var(--tide-3)', 'var(--sun-3)', 'var(--coral-3)', 'var(--grass-3)', 'var(--rock-5)'];

// The one sanctioned emoji use (visual identity for agents, never in copy).
// icon is caller-supplied, not looked up here — a multi-character or empty
// icon falls back to initials the same as an absent one.
function isSingleGrapheme(value) {
  if (!value) return false;
  const segments = [...new Intl.Segmenter().segment(value)];
  return segments.length === 1 && segments[0].segment === value;
}

// The board's own mark (issue #261) — inlined rather than an <img src="/favicon.svg">
// so this component stays free of the app's asset paths (ADR 0050: it must
// render standalone in ui_kits and Claude Design previews). Kept in sync by
// hand with public/favicon.svg / public/icon.svg — this is the path's 3rd copy.
const BOARD_MARK_VIEWBOX = '76 76 360 360';
const BOARD_MARK_PATH =
  'M 384.1 223.0 L 388.8 220.8 L 393.2 218.2 L 397.3 215.1 L 401.2 211.7 L 404.8 208.1 L 408.1 204.2 L 411.1 200.0 L 413.8 195.6 L 416.1 191.0 L 418.0 186.2 L 419.4 181.2 L 420.2 176.0 L 420.6 170.8 L 420.3 165.6 L 419.6 160.5 L 418.4 155.5 L 416.8 150.6 L 414.8 145.8 L 412.5 141.3 L 409.9 136.8 L 407.0 132.6 L 403.7 128.7 L 400.0 125.0 L 396.0 121.7 L 391.7 118.9 L 387.1 116.5 L 382.2 114.8 L 377.2 113.5 L 372.1 112.8 L 367.1 112.6 L 362.0 112.8 L 357.1 113.4 L 352.2 114.2 L 347.4 115.3 L 342.6 116.6 L 337.9 118.3 L 333.3 120.2 L 328.8 122.5 L 324.5 125.3 L 320.4 128.4 L 316.7 132.0 L 313.4 136.0 C 299.2 156.7 306.1 162.0 252.4 152.2 L 241.4 150.8 L 230.2 150.6 L 219.1 151.5 L 208.2 153.4 L 197.5 156.2 L 187.1 159.7 L 177.0 164.0 L 167.2 168.9 L 157.6 174.5 L 148.4 180.7 L 139.7 187.7 L 131.5 195.4 L 124.1 203.9 L 117.6 213.2 L 112.1 223.2 L 107.8 233.8 L 104.7 244.8 L 102.8 256.0 L 102.1 267.4 L 102.5 278.7 L 103.9 289.8 L 106.2 300.7 L 109.3 311.4 L 113.1 321.8 L 117.8 331.8 L 123.2 341.4 L 129.5 350.5 L 136.5 359.0 L 144.3 366.8 L 152.7 373.8 L 161.8 380.0 L 171.3 385.4 L 181.2 390.0 L 191.5 393.8 L 202.0 396.9 L 212.7 399.2 L 223.5 400.9 L 234.6 401.8 L 245.8 401.7 L 257.0 400.7 L 268.1 398.6 L 279.0 395.3 L 289.5 390.8 L 299.4 385.1 L 308.5 378.2 L 316.8 370.5 L 324.3 361.9 L 330.9 352.8 L 336.6 343.1 L 341.6 333.2 L 345.8 322.9 L 349.3 312.4 L 352.1 301.7 L 354.0 290.8 L 355.1 279.8 C 356.5 225.2 360.9 232.7 384.1 223.0 Z';

export function AgentChip({ name = '', icon, human = false, board = false, size = 'md', style }) {
  const px = size === 'sm' ? 20 : 26;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const glyph = human ? '🧍' : (isSingleGrapheme(icon) ? icon : undefined);
  const bg = (glyph || board) ? 'var(--tide-1)' : chipPalette[Math.abs(hash) % chipPalette.length];
  const initials = name.split(/[-_ ]/).map((w) => w[0]).join('').slice(0, 2);
  return (
    <span title={human ? 'you' : name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <span aria-hidden="true" style={{
        width: px, height: px, borderRadius: '50%', background: bg, color: '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-mono)', fontSize: glyph ? px * 0.58 : px * 0.42, fontWeight: 500, flexShrink: 0,
      }}>
        {board
          ? <svg viewBox={BOARD_MARK_VIEWBOX} width={px * 0.58} height={px * 0.58} style={{ fill: 'currentColor', color: 'var(--tide-4)' }}><path d={BOARD_MARK_PATH} /></svg>
          : (glyph || initials)}
      </span>
      {size !== 'sm' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{human ? 'you' : name}</span>}
    </span>
  );
}
