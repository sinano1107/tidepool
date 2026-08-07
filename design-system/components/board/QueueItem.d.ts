/**
 * One row of the TODO queue — drag handle, position, task, assignee.
 * "Run now" (tide-colored) is only the head row's action; every other row's
 * "↑ front" reorders to the head without triggering an immediate poll.
 * Skipped rows render dashed (throttle/pause pickup-block, auto-recovers).
 */
export interface QueueItemProps {
  /** 1-based queue position. */
  position?: number;
  task?: { id?: string; title?: string; assignee?: string; risk?: boolean };
  /** Env-wide pickup block (throttle/pause) — dashed, auto-recovers. */
  skipped?: boolean;
  /** Why `skipped` is true: distinguishes pause / fail-closed throttle / a
   *  known throttle resume time so the row never claims a reset time it
   *  doesn't have. Defaults to the generic throttle phrasing. */
  skipReason?: string;
  /** Highlighted: placed at front by this triage session. */
  frontInserted?: boolean;
  /** One-time background flash (just moved) — driven by transient state, not persisted data. */
  flash?: boolean;
  /** True queue head (by id, not rendered position) — colors the "↑ front"
   *  action as "run now" instead of plain reorder. */
  isHead?: boolean;
  /** Shows the hover "↑ front" action. */
  onFront?: () => void;
  style?: React.CSSProperties;
}
export declare function QueueItem(props: QueueItemProps): JSX.Element;
