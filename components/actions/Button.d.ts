/**
 * Tidepool action button. Primary is the single teal action on a screen;
 * secondary/ghost for everything else; danger for objections and destructive ops.
 * @startingPoint section="Actions" subtitle="Primary / secondary / ghost / danger button" viewport="700x220"
 */
export interface ButtonProps {
  /** Visual weight. One primary per view. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** lg = 44px, the mobile hit-target size. */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to container width (mobile action rows). */
  full?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function Button(props: ButtonProps): JSX.Element;
