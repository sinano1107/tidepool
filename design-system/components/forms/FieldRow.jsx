import { AgentChip } from '../board/AgentChip.jsx';
import { Tag } from '../surfaces/Tag.jsx';

// The read-only half of a form field (issue #204): a card shows FieldRows until
// you press Edit, and only then renders Input/Select/Switch in their place. The
// value band keeps the Input's 42px height so a card doesn't jump when it
// switches modes, and an unset optional field reads as its default in words
// ("adapter default") rather than as a blank box.
const rowLabel = {
  display: 'block',
  fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-medium)',
  letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)',
  lineHeight: '19.5px', marginBottom: 6,
};

// Same grammar as the pickers that edit these lists (SkillListInput /
// ProfileListInput): sun for the wildcard, grass for a scope word, tide for a
// plain name.
function tagColor(value, scheme) {
  if (value === '*') return 'sun';
  if (scheme === 'skills' && value.charAt(0) === '@') return 'grass';
  return 'tide';
}

export function FieldRow({
  label, kind = 'text', value,
  tags = [], agentIcons = {}, scheme = 'plain', wildcardHint = 'any',
  checked = false, onLabel = 'yes', offLabel = 'no', unsetLabel = '—',
  style,
}) {
  const band = { padding: '9px 0', fontSize: 'var(--text-md)', lineHeight: 'var(--leading-normal)' };
  let body = null;

  if (kind === 'text') {
    body = <div style={{ ...band, color: 'var(--text-body)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{value}</div>;
  } else if (kind === 'mono') {
    body = (
      <div style={{ padding: '9px 0', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', lineHeight: 1.62, color: 'var(--text-body)', overflowWrap: 'anywhere' }}>
        {value}
      </div>
    );
  } else if (kind === 'tags') {
    // the wildcard always sorts last and states what it widens to, matching the
    // picker's own option label ("* — every workspace")
    const plain = tags.filter((t) => t !== '*');
    const wild = tags.includes('*');
    body = (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 0', minHeight: 26 }}>
        {plain.map((t) => (
          <span key={t} style={{ display: 'inline-flex' }}>
            {agentIcons[t]
              ? <AgentChip name={t} icon={agentIcons[t]} />
              : <Tag color={tagColor(t, scheme)} mono>{t}</Tag>}
          </span>
        ))}
        {wild && <Tag color="sun" mono>{`* — ${wildcardHint}`}</Tag>}
      </div>
    );
  } else if (kind === 'bool') {
    body = (
      <div style={{ ...band, display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: checked ? 'var(--text-body)' : 'var(--text-muted)' }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={checked ? 'var(--tide-4)' : 'var(--rock-4)'}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          {checked ? <path d="M20 6 9 17l-5-5" /> : <path d="M18 6 6 18M6 6l12 12" />}
        </svg>
        <span>{checked ? onLabel : offLabel}</span>
      </div>
    );
  } else {
    body = <div style={{ ...band, color: 'var(--text-muted)' }}>{unsetLabel}</div>;
  }

  return (
    <div style={{ display: 'block', width: '100%', boxSizing: 'border-box', ...style }}>
      <span style={rowLabel}>{label}</span>
      {body}
    </div>
  );
}
