/**
 * Ink toast — transient confirmations of board operations ("moved to front of queue").
 * Never asks for acknowledgment; auto-dismisses.
 */
export interface ToastProps {
  kind?: 'info' | 'success' | 'warn' | 'danger';
  children?: React.ReactNode;
  /** Mono second line — task id, timestamp. Rendered as-is, so nodes are fine. */
  detail?: React.ReactNode;
  onDismiss?: () => void;
  style?: React.CSSProperties;
}
export declare function Toast(props: ToastProps): JSX.Element;
