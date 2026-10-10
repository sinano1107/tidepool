/**
 * A task/entity id, truncated to 9 monospace characters with a trailing
 * ellipsis. The full id stays in the DOM — never string-truncated — and
 * `title` reveals it on hover, which touch does not have: there the full id
 * is read where tapping the card leads (the info toast or task actions
 * dialog) and in the handoff heading. Whether the chip's
 * text can be selected is the caller's row (Queue rows disable selection
 * for reordering).
 * Owns truncation and typography (muted mono); layout (flex item vs. inline
 * text run) comes from the caller via `style`, which overrides the defaults.
 */
export interface IdChipProps {
  id: string;
  style?: React.CSSProperties;
}
export declare function IdChip(props: IdChipProps): JSX.Element;
