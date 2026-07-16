import { StatusBadge } from './StatusBadge.jsx';
import { TypeBadge } from './TypeBadge.jsx';
import { RiskFlag } from './RiskFlag.jsx';
import { AgentChip } from './AgentChip.jsx';

export function TaskCard({ task = {}, onClick, style }) {
  const { id, title, status = 'todo', type = 'work', assignee, assigneeIcon, human = false, risk = false, children: childCount = 0 } = task;
  const [hover, setHover] = React.useState(false);
  const cancelled = status === 'cancelled';
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? 'var(--surface-hover)' : 'var(--surface-card)',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-card)',
        padding: '14px 16px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background var(--duration-quick) var(--ease-tidal)',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{id}</span>
        <TypeBadge type={type} showLabel={false} />
        {risk && <RiskFlag style={{ marginLeft: 'auto' }} />}
      </div>
      <div style={{
        fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)',
        color: cancelled ? 'var(--text-muted)' : 'var(--text-heading)',
        textDecoration: cancelled ? 'line-through' : 'none',
        marginBottom: 10, lineHeight: 'var(--leading-tight)',
      }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 6, minWidth: 0 }}>
        <AgentChip name={assignee} icon={assigneeIcon} human={human} size="sm" />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 }}>{human ? 'you' : assignee}</span>
        {childCount > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sun-4)', whiteSpace: 'nowrap' }}>{childCount} open child{childCount > 1 ? 'ren' : ''}</span>}
        <StatusBadge status={status} style={{ marginLeft: 'auto' }} />
      </div>
    </div>
  );
}
