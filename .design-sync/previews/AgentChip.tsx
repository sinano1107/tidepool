import { AgentChip } from 'tidepool-design-system';

const row = { display: 'flex', gap: 16, alignItems: 'center' };

// The caller-supplied icon on a sea-glass circle — the canonical case.
export const Identity = () => (
  <div style={row}>
    <AgentChip name="tako" icon="🐙" />
    <AgentChip name="reef-crab" icon="🦀" />
    <AgentChip name="anemone" icon="🌺" />
  </div>
);

// No icon (absent or not a single grapheme) falls back to mono initials
// on a hashed accent circle — never a blank circle.
export const Fallback = () => (
  <div style={row}>
    <AgentChip name="reef-crab" />
    <AgentChip name="anemone" />
    <AgentChip name="shako" />
  </div>
);

// sm = 20px circle only, md = 26px + name.
export const Sizes = () => (
  <div style={row}>
    <AgentChip name="reef-crab" icon="🦀" size="sm" />
    <AgentChip name="reef-crab" icon="🦀" size="md" />
  </div>
);

// The two identities that aren't registry agents: the human (🧍, "you")
// and the board itself (its own inlined mark).
export const Special = () => (
  <div style={row}>
    <AgentChip human />
    <AgentChip human size="sm" />
    <AgentChip name="tidepool" board />
    <AgentChip name="tidepool" board size="sm" />
  </div>
);
