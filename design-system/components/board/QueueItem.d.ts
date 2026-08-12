/**
 * One row of the TODO queue — position, task, assignee, and an optional drag handle.
 * "Run now" (tide-colored) is only the head row's action; every other row's
 * "↑ front" reorders to the head without triggering an immediate poll.
 * Skipped rows render dashed — this row alone cannot be picked up right now.
 */
export interface QueueItemProps {
  /** 1-based queue position. */
  position?: number;
  task?: { id?: string; title?: string; assignee?: string; risk?: boolean };
  /** This row's own resource cannot take it right now — dashed. */
  skipped?: boolean;
  /** Optional reason appended after `skipped ·`. Omit it when the reason
   *  already lives elsewhere on the screen; the row then just says `skipped`
   *  rather than claiming a cause it doesn't know. */
  skipReason?: string;
  /** Highlighted: placed at front by this triage session. */
  frontInserted?: boolean;
  /** One-time background flash (just moved) — driven by transient state, not persisted data. */
  flash?: boolean;
  /** True queue head (by id, not rendered position) — colors the "↑ front"
   *  action as "run now" instead of plain reorder. */
  isHead?: boolean;
  /** Shows the drag handle when this row can be reordered. */
  draggable?: boolean;
  /** Shows the hover "↑ front" action. */
  onFront?: () => void;
  style?: React.CSSProperties;
}
export declare function QueueItem(props: QueueItemProps): JSX.Element;
