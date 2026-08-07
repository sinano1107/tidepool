/**
 * Checkbox — risk flag / review opt-in at registration, scratchpad triage picks.
 */
export interface CheckboxProps {
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent) => void;
  style?: React.CSSProperties;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
