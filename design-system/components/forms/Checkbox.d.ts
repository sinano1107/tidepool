/**
 * Checkbox — risk flag / review opt-in at registration, scratchpad triage picks.
 */
export interface CheckboxProps {
  label?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  style?: React.CSSProperties;
  /** `data-testid` on the label. */
  testId?: string;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
