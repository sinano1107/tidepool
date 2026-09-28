import { AgentChip } from './AgentChip.jsx';

const kindColors = {
  decision: 'var(--text-body)',
  completion: 'var(--grass-4)',
  escalation: 'var(--sun-4)',
  objection: 'var(--coral-4)',
};

export function LogEntry({ entry = {}, onObject, onExpand, onOpenMemoryEntry, active = false, style }) {
  const { time, taskId, agent, agentIcon, human = false, kind = 'decision', text, objection, bundledObjection, cause, causeEntries = [], unread = false } = entry;
  const completion = kind === 'completion';
  const clickable = !!onObject;
  const causeText = cause === 'uncertain' ? 'cause: not yet determined (uncertain)' : cause ? `cause: ${cause}` : null;
  // memory の帰責は名指された entry へのリンクを添える
  const causeLinks = causeEntries.map((id) => (
    <a key={id} href={`#memory-entry-${id}`} onClick={(e) => { e.preventDefault(); onOpenMemoryEntry?.(id); }}
      style={{ marginLeft: 6, color: 'var(--tide-4)' }}>#{id}</a>
  ));
  // 注記の帯は Object 押下面の外に置く(issue #1090)—— role="button" の子孫に
  // interactive な要素を入れない。subgrid で帯を本文の列に揃える。
  return (
    <div
      className="tp-log-entry"
      data-clickable={clickable ? '' : undefined}
      data-active={active ? '' : undefined}
      style={{
        display: 'grid', gridTemplateColumns: onExpand ? 'auto auto minmax(0, 1fr) auto' : 'auto auto minmax(0, 1fr)',
        alignItems: 'start', gap: '0 10px',
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
        style={{ gridColumn: '1 / 4', display: 'grid', gridTemplateColumns: 'subgrid', alignItems: 'start', minWidth: 0 }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', paddingTop: 2 }}>{time}</span>
        <AgentChip name={agent} icon={agentIcon} human={human} size="sm" style={{ paddingTop: 1 }} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: kindColors[kind], lineHeight: 'var(--leading-normal)', whiteSpace: 'pre-wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginRight: 6 }}>{taskId}</span>
            {completion && <strong style={{ fontWeight: 'var(--weight-semibold)', marginRight: 4 }}>done —</strong>}
            {text}
          </div>
          {active && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--coral-4)', paddingTop: 3, flexShrink: 0 }}>objecting…</span>
          )}
        </div>
      </div>
      {onExpand && (
        <button
          type="button"
          aria-label="Expand handoff"
          title="Expand handoff"
          onClick={onExpand}
          style={{ padding: '2px 4px', border: 'none', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 'var(--text-sm)', lineHeight: 1 }}
        >⌄</button>
      )}
      {(objection || bundledObjection) && (
        <div style={{ gridColumn: 3 }}>
          {objection && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 6, padding: '6px 10px', background: 'var(--coral-1)', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-xs)', color: 'var(--coral-4)', whiteSpace: 'pre-wrap' }}>
              <span style={{ flex: 1 }}>objection: {objection}</span>
              {causeText && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{causeText}{causeLinks}</span>}
            </div>
          )}
          {bundledObjection && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 6, padding: '6px 10px', background: 'var(--surface-recessed)', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
              <span style={{ flex: 1 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 6 }}>bundled</span>
                {bundledObjection}
              </span>
              {!objection && causeText && <span style={{ flexShrink: 0 }}>{causeText}{causeLinks}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
