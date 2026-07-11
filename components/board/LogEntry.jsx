import { AgentChip } from './AgentChip.jsx';

const kindColors = {
  decision: 'var(--text-body)',
  completion: 'var(--grass-4)',
  escalation: 'var(--sun-4)',
  objection: 'var(--coral-4)',
};

export function LogEntry({ entry = {}, onObject, active = false, style }) {
  const { time, taskId, agent, kind = 'decision', text, objection, unread = false } = entry;
  const completion = kind === 'completion';
  const clickable = !!onObject && !objection;
  return (
    <div
      className="tp-log-entry"
      data-clickable={clickable ? '' : undefined}
      data-active={active ? '' : undefined}
      onClick={clickable ? onObject : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onObject(); } } : undefined}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 12px',
        background: completion ? 'var(--grass-1)' : undefined,
        borderBottom: '1px solid var(--border-hairline)',
        borderLeft: unread ? '2px solid var(--tide-4)' : '2px solid transparent',
        ...style,
      }}
    >
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', paddingTop: 2, flexShrink: 0 }}>{time}</span>
      <AgentChip name={agent} size="sm" style={{ paddingTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', color: kindColors[kind], lineHeight: 'var(--leading-normal)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginRight: 6 }}>{taskId}</span>
          {completion && <strong style={{ fontWeight: 'var(--weight-semibold)', marginRight: 4 }}>done —</strong>}
          {text}
        </div>
        {objection && (
          <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--coral-1)', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-xs)', color: 'var(--coral-4)' }}>
            objection: {objection}
          </div>
        )}
      </div>
      {active && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--coral-4)', paddingTop: 3, flexShrink: 0 }}>objecting…</span>
      )}
    </div>
  );
}
