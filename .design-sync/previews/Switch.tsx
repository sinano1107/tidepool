import { Switch } from 'tidepool-design-system';

const column = { display: 'flex', flexDirection: 'column' as const, gap: 12 };

// The prompt.md's own canonical call site — settings only.
export const QuietHours = () => (
  <div style={column}>
    <Switch label="Quiet hours 23:00–07:00" checked />
  </div>
);

// Workspace protection — the settings-screen call site, off then on.
export const Protected = () => (
  <div style={column}>
    <Switch label="protected — changes here always need human approval" />
    <Switch label="protected — changes here always need human approval" checked />
  </div>
);

// 訳を添える — the triage-screen translate-gloss toggle, off then on.
export const TranslateGloss = () => (
  <div style={column}>
    <Switch label="訳を添える" />
    <Switch label="訳を添える" checked />
  </div>
);

// Locked on — the registry's own workspace, whose protection can't be cleared.
export const Disabled = () => (
  <div style={column}>
    <Switch label="protected — changes here always need human approval" checked disabled />
  </div>
);
