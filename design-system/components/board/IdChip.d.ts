/**
 * A task/entity id, truncated to 9 monospace characters with a trailing
 * ellipsis. The full id stays in the DOM — never string-truncated — so
 * copy/search on the id is unaffected; hovering (`title`) reveals it.
 * Owns truncation only: typography and layout (flex item vs. inline text
 * run) are the caller's responsibility via `style`.
 */
export interface IdChipProps {
  id: string;
  style?: React.CSSProperties;
}
export declare function IdChip(props: IdChipProps): JSX.Element;
