import { StatusBadge } from 'tidepool-design-system';

const row = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const };

// All six statuses, rendered lowercase mono exactly as stored. `skipped`
// (dashed) is queue-view-only, never shown on the board — grouped in the
// order a task moves through them, with skipped last as the queue modifier it is.
export const Statuses = () => (
  <div style={row}>
    <StatusBadge status="todo" />
    <StatusBadge status="in_progress" />
    <StatusBadge status="blocked" />
    <StatusBadge status="done" />
    <StatusBadge status="cancelled" />
    <StatusBadge status="skipped" />
  </div>
);
