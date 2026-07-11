/**
 * Toggle switch — settings (quiet hours, push notifications).
 */
export interface SwitchProps {
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Receives the next boolean value. */
  onChange?: (next: boolean) => void;
  style?: React.CSSProperties;
}
export declare function Switch(props: SwitchProps): JSX.Element;
