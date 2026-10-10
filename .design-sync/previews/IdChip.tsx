import { IdChip } from 'tidepool-design-system';

const column = { display: 'flex', flexDirection: 'column' as const, gap: 8 };

// Ids longer than 9 characters truncate with an ellipsis (full id lives in
// the DOM, revealed on hover via title) — a short id passes through untouched.
export const Truncation = () => (
  <div style={column}>
    <IdChip id="tp-0141" />
    <IdChip id="tp-01414892" />
    <IdChip id="agent:reef-crab" />
  </div>
);

// The queue slot line's real composition — the chip owns truncation and typography,
// the caller's flex row does the layout.
export const InContext = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--rock-4)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>slot</span>
    <IdChip id="tp-0144892" />
    <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      write board schema DDL
    </span>
  </div>
);
