/**
 * Text input / textarea. Free text is rare in Tidepool (no-typing rule) —
 * used for brain dump, objection direction comments, override answers.
 */
export interface InputProps {
  label?: string;
  hint?: string;
  /** Replaces hint; coral border + message. */
  error?: string;
  /** Render a textarea. */
  multiline?: boolean;
  /** Mono font (ids, paths). */
  mono?: boolean;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent) => void;
  style?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
