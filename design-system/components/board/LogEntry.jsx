import { AgentChip } from './AgentChip.jsx';

const kindColors = {
  decision: 'var(--text-body)',
  completion: 'var(--grass-4)',
  escalation: 'var(--sun-4)',
  objection: 'var(--coral-4)',
};

export function LogEntry({ entry = {}, onObject, onExpand, active = false, style }) {
  const { time, taskId, agent, agentIcon, human = false, kind = 'decision', text, objection, bundledObjection, cause, unread = false } = entry;
  const completion = kind === 'completion';
  const clickable = !!onObject;
  const causeText = cause === 'uncertain' ? 'cause: not yet determined (uncertain)' : cause ? `cause: ${cause}` : null;
  return (
    <div
      className="tp-log-entry"
      data-clickable={clickable ? '' : undefined}
      data-active={active ? '' : undefined}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 12px',
        background: completion ? 'var(--grass-1)' : undefined,
        borderBottom: '1px solid var(--border-hairline)',
        borderLeft: unread ? '2px solid var(--tide-4)' : '2px solid transparent',
        ...style,
      }}
    >
      <div
        onClick={clickable ? onObject : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onObject(); } } : undefined}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1, minWidth: 0 }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', paddingTop: 2, flexShrink: 0 }}>{time}</span>
        <AgentChip name={agent} icon={agentIcon} human={human} size="sm" style={{ paddingTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: kindColors[kind], lineHeight: 'var(--leading-normal)', whiteSpace: 'pre-wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginRight: 6 }}>{taskId}</span>
            {completion && <strong style={{ fontWeight: 'var(--weight-semibold)', marginRight: 4 }}>done —</strong>}
            {text}
          </div>
          {objection && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 6, padding: '6px 10px', background: 'var(--coral-1)', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-xs)', color: 'var(--coral-4)', whiteSpace: 'pre-wrap' }}>
              <span style={{ flex: 1 }}>objection: {objection}</span>
              {causeText && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{causeText}</span>}
            </div>
          )}
          {bundledObjection && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 6, padding: '6px 10px', background: 'var(--surface-recessed)', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
              <span style={{ flex: 1 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 6 }}>bundled</span>
                {bundledObjection}
              </span>
              {!objection && causeText && <span style={{ flexShrink: 0 }}>{causeText}</span>}
            </div>
          )}
        </div>
        {active && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--coral-4)', paddingTop: 3, flexShrink: 0 }}>objecting…</span>
        )}
      </div>
      {onExpand && (
        <button
          type="button"
          aria-label="Expand handoff"
          title="Expand handoff"
          onClick={onExpand}
          style={{ flexShrink: 0, padding: '2px 4px', border: 'none', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 'var(--text-sm)', lineHeight: 1 }}
        >⌄</button>
      )}
    </div>
  );
}
