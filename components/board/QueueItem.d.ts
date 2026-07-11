/**
 * One row of the TODO queue — drag handle, position, task, assignee.
 * "Run now" is just move-to-front. Skipped rows render dashed (token-limit skip).
 */
export interface QueueItemProps {
  /** 1-based queue position. */
  position?: number;
  task?: { id?: string; title?: string; assignee?: string; risk?: boolean };
  /** Token-limit skip — dashed, auto-recovers. */
  skipped?: boolean;
  /** Highlighted: placed at front by this triage session. */
  frontInserted?: boolean;
  /** One-time background flash (just moved) — driven by transient state, not persisted data. */
  flash?: boolean;
  /** Shows the hover "↑ front" action. */
  onFront?: () => void;
  style?: React.CSSProperties;
}
export declare function QueueItem(props: QueueItemProps): JSX.Element;
