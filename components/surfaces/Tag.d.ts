/**
 * Small rectangular label — metadata like workspace names, branch names, counts.
 * For task status use StatusBadge instead.
 */
export interface TagProps {
  color?: 'neutral' | 'tide' | 'sun' | 'coral' | 'grass';
  /** Mono font for ids/branches. */
  mono?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Tag(props: TagProps): JSX.Element;
