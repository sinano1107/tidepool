import { IdChip, RiskFlag, StatusBadge, TypeBadge } from 'tidepool-design-system';

const row = { display: 'flex', gap: 10, alignItems: 'center' };

// The bare chip — ⚠ risk, coral. Marks a task for on-completion review,
// not a priority marker.
export const Standalone = () => (
  <div style={row}>
    <RiskFlag />
  </div>
);

// Rendered only when the flag is set — here, one task row with risk next
// to a task row without, the way a board card composes it: `{task.risk && <RiskFlag />}`.
export const InContext = () => {
  const cell = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 380 }}>
      <div style={cell}>
        <IdChip id="tp-0158" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', flexShrink: 0 }} />
        <TypeBadge type="work" showLabel={false} />
        <span style={{ flex: 1, fontSize: 'var(--text-sm)' }}>run destructive migration on prod</span>
        <RiskFlag />
        <StatusBadge status="blocked" />
      </div>
      <div style={cell}>
        <IdChip id="tp-0159" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', flexShrink: 0 }} />
        <TypeBadge type="work" showLabel={false} />
        <span style={{ flex: 1, fontSize: 'var(--text-sm)' }}>update changelog</span>
        <StatusBadge status="todo" />
      </div>
    </div>
  );
};
