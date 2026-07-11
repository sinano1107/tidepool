/**
 * Task type marker — work / question / review. Question tasks get the sun-amber
 * treatment; they are the human's most expensive input.
 */
export interface TypeBadgeProps {
  type?: 'work' | 'question' | 'review';
  /** Glyph only when false (dense rows). */
  showLabel?: boolean;
  style?: React.CSSProperties;
}
export declare function TypeBadge(props: TypeBadgeProps): JSX.Element;
