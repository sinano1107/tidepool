/**
 * Kanban board card for one task — id, type glyph, title, assignee, status, risk.
 * Blocked state is derived (open children) and shown as an amber child count.
 * @startingPoint section="Board" subtitle="Kanban task card with status, type, assignee" viewport="700x300"
 */
export interface TaskCardProps {
  task?: {
    id?: string;
    title?: string;
    status?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
    type?: 'work' | 'question' | 'review';
    assignee?: string;
    /** Assignee is the user. */
    human?: boolean;
    risk?: boolean;
    /** Count of open (not done/cancelled) children. */
    children?: number;
  };
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function TaskCard(props: TaskCardProps): JSX.Element;
