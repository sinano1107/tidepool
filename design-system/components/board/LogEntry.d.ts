/**
 * One decision-log line for the morning skim. Silence = approval; tapping a
 * clickable row (onObject given) toggles the objection
 * composer — works on touch, no hover required. Completions get a grass fill.
 */
export interface LogEntryProps {
  entry?: {
    /** "07:14" */
    time?: string;
    taskId?: string;
    agent?: string;
    /** The user — 🧍, labeled "you" (issue #261). */
    human?: boolean;
    kind?: 'decision' | 'completion' | 'escalation' | 'objection';
    text?: string;
    /** Commit-pending objection comment(s), rendered as a coral annotation. */
    objection?: string;
    /** Already-bundled objection comment(s) from a closed session, rendered
     *  as a dimmed annotation with a "bundled" label (ADR 0085). Renders
     *  after `objection` when both are present. */
    bundledObjection?: string;
    /** Teal unread bar (entries since last skim). */
    unread?: boolean;
  };
  /** Tap/click handler — row becomes the Object affordance. */
  onObject?: () => void;
  /** Completion handoff toggle, kept separate from the row's Object affordance. */
  onExpand?: () => void;
  /** Objection composer open for this row (coral tint + "objecting…" marker). */
  active?: boolean;
  style?: React.CSSProperties;
}
export declare function LogEntry(props: LogEntryProps): JSX.Element;
