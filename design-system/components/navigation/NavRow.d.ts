/**
 * One row of a drilldown index — a label (or an agent's chip), a right-aligned
 * summary of the section's current state, and a chevron. The whole row is the
 * tap target.
 */
export interface NavRowProps {
  /** Row label. Ignored when `agentName` is set. */
  label?: string;
  /** Right-aligned state summary. Truncates from the left, keeping the tail. */
  summary?: string;
  /** `alert` colours the summary as a warning (e.g. an unreachable section). */
  summaryTone?: 'muted' | 'alert';
  /** Renders an AgentChip instead of a plain label. */
  agentName?: string;
  agentIcon?: string;
  /** Hairline above the row — set on every row but the first in a stack. */
  divider?: boolean;
  /** Carries the enclosing Card's top / bottom corner. */
  first?: boolean;
  last?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function NavRow(props: NavRowProps): JSX.Element;
