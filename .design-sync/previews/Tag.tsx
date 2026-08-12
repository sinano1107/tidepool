import { Tag } from 'tidepool-design-system';

const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const, width: 360 };

// The five colors, each with the metadata it actually carries in the app —
// never status (that's StatusBadge's job).
export const Colors = () => (
  <div style={row}>
    <Tag color="neutral" mono>tidepool-web</Tag>
    <Tag color="tide" mono>registry</Tag>
    <Tag color="sun">protected</Tag>
    <Tag color="coral" mono>risk</Tag>
    <Tag color="grass" mono>main</Tag>
  </div>
);

// FieldRow's skills picker grammar: wildcard, scope word, plain name.
export const Skills = () => (
  <div style={row}>
    <Tag mono>@workspace</Tag>
    <Tag mono>docs:*</Tag>
    <Tag mono>review</Tag>
  </div>
);

// The settings screen's removable-chip pattern — a trailing ✕ glyph inside
// the label itself, color carrying the value's meaning (wildcard = sun).
export const Removable = () => (
  <div style={row}>
    <Tag color="tide" mono>git commit ✕</Tag>
    <Tag color="tide" mono>npm test ✕</Tag>
    <Tag color="sun" mono>* ✕</Tag>
  </div>
);
