/**
 * The read-only half of a form field — label plus value, sharing the Input's
 * vertical rhythm so a card doesn't jump when it switches between viewing and
 * editing.
 */
export interface FieldRowProps {
  label?: string;
  /** `unset` renders `unsetLabel` in muted text — an empty optional field. */
  kind?: 'text' | 'mono' | 'tags' | 'bool' | 'unset';
  /** Value for `text` / `mono`. */
  value?: string;
  /** Values for `tags`. `"*"` sorts last and renders as `* — wildcardHint`. */
  tags?: string[];
  /** name → emoji; a listed name renders as an AgentChip instead of a Tag. */
  agentIcons?: Record<string, string>;
  /** `skills` colours `@scope` entries green (the skills allowlist grammar). */
  scheme?: 'plain' | 'skills';
  wildcardHint?: string;
  /** Value for `bool`. */
  checked?: boolean;
  onLabel?: string;
  offLabel?: string;
  unsetLabel?: string;
  style?: React.CSSProperties;
}
export declare function FieldRow(props: FieldRowProps): JSX.Element;
