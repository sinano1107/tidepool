import { Checkbox } from 'tidepool-design-system';

const column = { display: 'flex', flexDirection: 'column' as const, gap: 12 };

// Registration risk flag — the primary use, off then on.
export const RiskFlag = () => (
  <div style={column}>
    <Checkbox label="risk flag — request on-completion review" />
    <Checkbox label="risk flag — request on-completion review" checked />
  </div>
);

// Registry protection toggle — the other real call site (settings-screen).
export const Protected = () => (
  <div style={column}>
    <Checkbox label="protected — changes here always need human approval" checked />
    <Checkbox label="protected — changes here always need human approval" />
  </div>
);

// Locked cases — e.g. the registry's own workspace, whose protection can't be cleared.
export const Disabled = () => (
  <div style={column}>
    <Checkbox label="protected — changes here always need human approval" checked disabled />
    <Checkbox label="protected — changes here always need human approval" disabled />
  </div>
);
