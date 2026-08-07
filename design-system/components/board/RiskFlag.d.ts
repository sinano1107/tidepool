/**
 * The risk flag — marks a task for on-completion review / external effects.
 * Uses the one sanctioned ⚠ glyph. Render only when the flag is set.
 */
export interface RiskFlagProps {
  style?: React.CSSProperties;
}
export declare function RiskFlag(props: RiskFlagProps): JSX.Element;
