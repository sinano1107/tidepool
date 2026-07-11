/**
 * Modal dialog — confirmation moments only (commit triage, cancel task).
 * Tidepool avoids modals elsewhere; flows are full screens.
 */
export interface DialogProps {
  open?: boolean;
  title?: string;
  children?: React.ReactNode;
  /** Right-aligned action row. */
  footer?: React.ReactNode;
  /** Scrim click / close. */
  onClose?: () => void;
  /** Max width px; default 420. */
  width?: number;
}
export declare function Dialog(props: DialogProps): JSX.Element;
