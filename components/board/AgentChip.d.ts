/**
 * Worker identity chip — species emoji on a sea-glass circle for known agents
 * (🦀 reef-crab / 🪸 anemone / 🐚 hermit), mono initials on a hashed accent circle
 * otherwise. The one sanctioned emoji use — visual identity only, never in copy. The human is 🧍.
 */
export interface AgentChipProps {
  /** Registry agent name, e.g. "reef-crab". */
  name?: string;
  /** The user — 🧍 on a sea-glass circle, labeled "you". */
  human?: boolean;
  /** sm = 20px circle only, md = 26px + name. */
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}
export declare function AgentChip(props: AgentChipProps): JSX.Element;
