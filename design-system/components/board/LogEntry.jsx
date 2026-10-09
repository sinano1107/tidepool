import { AgentChip } from './AgentChip.jsx';
import { IdChip } from './IdChip.jsx';

const kindColors = {
  decision: 'var(--text-body)',
  completion: 'var(--grass-4)',
  escalation: 'var(--sun-4)',
  objection: 'var(--coral-4)',
};

export function LogEntry({ entry = {}, onObject, onExpand, onOpenMemoryEntry, active = false, style }) {
  const { time, taskId, agent, agentIcon, human = false, kind = 'decision', text, objection, bundledObjection, cause, causeEntries = [], causeEvidence, unread = false } = entry;
  const completion = kind === 'completion';
  const clickable = !!onObject;
  const causeText = cause === 'uncertain' ? 'cause: not yet determined (uncertain)' : cause ? `cause: ${cause}` : null;
  // memory の帰責は名指された entry へのリンクを添える
  // リンクの間は実際の空白で置く(折り返し位置になる)—— #id は番号の途中で割れない
  const causeLinks = causeEntries.map((id) => (
    <React.Fragment key={id}>{' '}<a href={`#memory-entry-${id}`} onClick={(e) => { e.preventDefault(); onOpenMemoryEntry?.(id); }}
      style={{ color: 'var(--tide-4)' }}>{`#${id}`}</a></React.Fragment>
  ));
  // 判定の根拠(ADR 0213 決定4)は異議コメントの下の、帯の幅いっぱいの独立した行に置く(issue #1113)
  const causeNote = causeText && (
    <span style={{ color: 'var(--text-muted)' }}><span>{causeText}</span>{causeLinks}{causeEvidence && ` — ${causeEvidence}`}</span>
  );
  const band = { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6, padding: '6px 10px', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-xs)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };
  // 注記の帯は Object 押下面の外に置く(issue #1090)—— role="button" の子孫に
  // interactive な要素を入れない。列は 押下面(見出し行 + 本文)/ Expand(onExpand があるときだけ)、
  // 帯は全列にわたり本文と同じ左端に揃う(issue #1683)。
  return (
    <div
      className="tp-log-entry"
      data-clickable={clickable ? '' : undefined}
      data-active={active ? '' : undefined}
      style={{
        display: 'grid', gridTemplateColumns: onExpand ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)',
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
        style={{ minWidth: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
          <span>{time}</span>
          <AgentChip name={agent} icon={agentIcon} human={human} size="sm" />
          <IdChip id={taskId} />
          {active && <span style={{ marginLeft: 'auto', color: 'var(--coral-4)' }}>objecting…</span>}
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: kindColors[kind], lineHeight: 'var(--leading-normal)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {completion && <strong style={{ fontWeight: 'var(--weight-semibold)', marginRight: 4 }}>done —</strong>}
          {text}
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
        <div style={{ gridColumn: '1 / -1' }}>
          {objection && (
            <div style={{ ...band, background: 'var(--coral-1)', color: 'var(--coral-4)' }}>
              <span>objection: {objection}</span>
              {causeNote}
            </div>
          )}
          {bundledObjection && (
            <div style={{ ...band, background: 'var(--surface-recessed)', color: 'var(--text-muted)' }}>
              <span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 6 }}>bundled</span>
                {bundledObjection}
              </span>
              {!objection && causeNote}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
