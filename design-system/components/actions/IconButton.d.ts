/**
 * Square icon-only button for toolbars and list rows. Pass a 16–20px Lucide icon as children.
 */
export interface IconButtonProps {
  /** Required accessible label (also the tooltip). */
  label: string;
  /** sm=28, md=36, lg=44px. */
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'outline';
  disabled?: boolean;
  /** The icon element. */
  children?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
