/**
 * White surface card — 10px radius, hairline border, water shadow.
 * Status never lives on the card edge (no colored left borders); use badges.
 */
export interface CardProps {
  children?: React.ReactNode;
  /** CSS padding; default 16px. */
  padding?: string;
  /** Hover fill + pointer cursor. */
  interactive?: boolean;
  /** Teal ring — selection state. */
  selected?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
