/**
 * One decision-log line for the morning skim. Silence = approval; tapping a
 * clickable row's body (onObject given) toggles the objection
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
    /** Latest attribution beside the objection annotation. `uncertain` is
     *  rendered as explicitly not yet determined. Read-only. */
    cause?: 'capability' | 'task_ambiguity' | 'missing_information' | 'environment' | 'preference' | 'requirement_change' | 'memory' | 'uncertain';
    /** With cause `memory`: the ids of the memory entries the attribution
     *  named, each rendered as a link beside the cause. */
    causeEntries?: number[];
    /** Teal unread bar (entries since last skim). */
    unread?: boolean;
  };
  /** Tap/click handler — the row's time, agent, task id, text and
   *  "objecting…" marker become the Object affordance (a button, Enter/Space).
   *  The objection annotations sit outside it, so tapping them does nothing. */
  onObject?: () => void;
  /** Completion handoff toggle, kept separate from the row's Object affordance. */
  onExpand?: () => void;
  /** A `causeEntries` link was followed; it never triggers the row's Object. */
  onOpenMemoryEntry?: (id: number) => void;
  /** Objection composer open for this row (coral tint + "objecting…" marker). */
  active?: boolean;
  style?: React.CSSProperties;
}
export declare function LogEntry(props: LogEntryProps): JSX.Element;
