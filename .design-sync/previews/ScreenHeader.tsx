import { Button, ScreenHeader } from 'tidepool-design-system';

// A section one level below the top: back names its destination, the meta line
// counts what's inside, and the action slot carries the section's own verb.
export const Section = () => (
  <div style={{ width: 360 }}>
    <ScreenHeader title="Agents" backLabel="Settings" meta="3 registered" onBack={() => {}}>
      <Button variant="ghost" size="sm" onClick={() => {}}>Add</Button>
    </ScreenHeader>
  </div>
);

// One record, two levels deep — back goes to the section, not to the top.
export const Record = () => (
  <div style={{ width: 360 }}>
    <ScreenHeader title="reef-crab" backLabel="Agents" meta="agent · 1 of 3" onBack={() => {}} />
  </div>
);

// A record name long enough to wrap — it keeps the meta line under it rather
// than pushing anything off the row.
export const LongTitle = () => (
  <div style={{ width: 360 }}>
    <ScreenHeader title="tidepool-registry-mirror-staging" backLabel="Workspaces"
      meta="workspace · 4 of 7" onBack={() => {}} />
  </div>
);
