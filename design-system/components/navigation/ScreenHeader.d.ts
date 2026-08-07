/**
 * Header for a drilldown level below the top: a back button that names its
 * destination, the screen title, and an optional line of metadata.
 */
export interface ScreenHeaderProps {
  title?: string;
  /** Where back goes, by name — "Settings", "Agents". */
  backLabel?: string;
  /** Mono caption under the title — "agent · 1 of 3". */
  meta?: string;
  onBack?: () => void;
  /** Action slot on the title line, right-aligned. */
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function ScreenHeader(props: ScreenHeaderProps): JSX.Element;
