import { TypeBadge } from 'tidepool-design-system';

const row = { display: 'flex', gap: 14, alignItems: 'center' };

// work ● / question ? / review ◍ — question gets the sun-amber treatment,
// the human's most expensive input.
export const Types = () => (
  <div style={row}>
    <TypeBadge type="work" />
    <TypeBadge type="question" />
    <TypeBadge type="review" />
  </div>
);

// Glyph only, for dense rows (queue, board card headers).
export const GlyphOnly = () => (
  <div style={row}>
    <TypeBadge type="work" showLabel={false} />
    <TypeBadge type="question" showLabel={false} />
    <TypeBadge type="review" showLabel={false} />
  </div>
);
