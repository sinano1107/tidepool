/**
 * Worker identity chip — the caller-supplied `icon` emoji on a sea-glass
 * circle, mono initials on a hashed accent circle when `icon` is absent or
 * invalid. The one sanctioned emoji use — visual identity only, never in
 * copy. The human is 🧍, the board is its own inlined mark.
 */
export interface AgentChipProps {
  /** Registry agent name, e.g. "reef-crab". */
  name?: string;
  /** Caller-resolved agent icon, e.g. "🦀". Absent or not a single grapheme → mono initials. */
  icon?: string;
  /** The user — 🧍 on a sea-glass circle, labeled "you". */
  human?: boolean;
  /** The board itself (tidepool) — its own mark on a sea-glass circle, labeled with `name`. */
  board?: boolean;
  /** sm = 20px circle only, md = 26px + name. */
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}
export declare function AgentChip(props: AgentChipProps): JSX.Element;
