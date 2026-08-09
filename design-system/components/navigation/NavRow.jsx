import { AgentChip } from '../board/AgentChip.jsx';

// One row of a drilldown index (issue #204's settings top level). The whole
// row is the tap target, and `summary` states the section's current state so
// the index reads without opening anything. First/last rows carry the
// enclosing Card's corner themselves — the hover fill and the focus ring then
// stay inside the rounded shape instead of squaring it off.
export function NavRow({
  label, summary, summaryTone = 'muted',
  agentName, agentIcon,
  divider = false, first = false, last = false,
  onClick, style, testId,
}) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  const go = () => onClick && onClick();
  const corner = (on) => (on ? 'var(--radius-lg)' : '0');
  return (
    <React.Fragment>
      {divider && <div style={{ height: 1, background: 'var(--border-hairline)', marginLeft: 'var(--space-4)' }} />}
      <div
        role="button" tabIndex={0} data-testid={testId}
        onClick={go}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { setHover(false); setPress(false); }}
        onMouseDown={() => setPress(true)}
        onMouseUp={() => setPress(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          width: '100%', boxSizing: 'border-box', minHeight: 52,
          padding: 'var(--space-3) var(--space-4)',
          background: press ? 'var(--tide-1)' : hover ? 'var(--surface-hover)' : 'var(--surface-card)',
          borderRadius: `${corner(first)} ${corner(first)} ${corner(last)} ${corner(last)}`,
          boxShadow: focus ? 'inset 0 0 0 2px var(--tide-4)' : 'none',
          cursor: 'pointer', outline: 'none', WebkitTapHighlightColor: 'transparent',
          transition: 'background var(--duration-quick) var(--ease-tidal)',
          ...style,
        }}
      >
        {agentName
          ? (
            <span style={{ flex: '0 0 auto', minWidth: 0 }}>
              <AgentChip name={agentName} icon={agentIcon} />
            </span>
          )
          : (
            <span style={{
              flex: '0 1 auto', minWidth: '5.5em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 'var(--text-md)', fontWeight: 'var(--weight-medium)',
              color: 'var(--text-heading)', letterSpacing: 'var(--tracking-tight)',
            }}>{label}</span>
          )}
        {/* a summary too long for the row truncates from the left, so a repo URL
            keeps the tail that identifies it (…/tidepool-registry); the inner
            span pins the text itself back to ltr so only the clipping flips */}
        <span title={summary || undefined} style={{
          flex: '1 1 auto', minWidth: 0, textAlign: 'right',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl',
          fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
          color: summaryTone === 'alert' ? 'var(--sun-4)' : 'var(--text-muted)',
        }}>
          <span style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{summary}</span>
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--rock-4)"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ flexShrink: 0, marginRight: -2 }}>
          <path d="m9 18 6-6-6-6" />
        </svg>
      </div>
    </React.Fragment>
  );
}
