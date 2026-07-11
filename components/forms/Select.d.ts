/**
 * Native select styled to the system — assignee, workspace, task-type pickers.
 */
export interface SelectProps {
  label?: string;
  /** Strings or { value, label } pairs. */
  options?: Array<string | { value: string; label: string }>;
  value?: string;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent) => void;
  style?: React.CSSProperties;
}
export declare function Select(props: SelectProps): JSX.Element;
