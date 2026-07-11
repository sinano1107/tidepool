/**
 * Task status pill. Renders the raw status string in lowercase mono — never paraphrase.
 * `skipped` is queue-view-only (a modifier on todo), never shown on the board.
 */
export interface StatusBadgeProps {
  status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled' | 'skipped';
  style?: React.CSSProperties;
}
export declare function StatusBadge(props: StatusBadgeProps): JSX.Element;
