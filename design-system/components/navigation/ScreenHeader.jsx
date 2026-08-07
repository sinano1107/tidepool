// The header of a drilldown level below the top (issue #204). The back button
// names its destination rather than pointing at it, so a two-deep stack stays
// legible ("← Agents" from a record, "← Settings" from a section), and it keeps
// a 44px tap height. The h1 sets only its size — colour, weight and tracking
// come from base.css's heading defaults, the same ones a screen title written
// as a plain <h1> gets. `children` is an optional action slot on the title line.
export function ScreenHeader({ title, backLabel, meta, onBack, children, style }) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', width: '100%', boxSizing: 'border-box', ...style }}>
      <button
        type="button"
        onClick={() => onBack && onBack()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { setHover(false); setPress(false); }}
        onMouseDown={() => setPress(true)}
        onMouseUp={() => setPress(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 2, alignSelf: 'flex-start',
          minHeight: 44, marginLeft: -10, padding: '0 10px',
          border: 'none', borderRadius: 'var(--radius-full)',
          background: press ? 'var(--tide-1)' : hover ? 'var(--surface-hover)' : 'transparent',
          fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)',
          color: hover || press ? 'var(--tide-5)' : 'var(--tide-4)',
          boxShadow: focus ? 'var(--shadow-focus)' : 'none',
          cursor: 'pointer', outline: 'none', WebkitTapHighlightColor: 'transparent',
          transition: 'background var(--duration-quick) var(--ease-tidal), color var(--duration-quick) var(--ease-tidal)',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
        <span>{backLabel}</span>
      </button>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-3)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', overflowWrap: 'anywhere' }}>{title}</h1>
        {children && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
            {children}
          </div>
        )}
      </div>
      {meta && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{meta}</span>
      )}
    </div>
  );
}
