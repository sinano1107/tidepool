import { Input } from 'tidepool-design-system';

const column = { width: 340, display: 'flex', flexDirection: 'column' as const, gap: 14 };

// Registration form — a title line plus the two multiline fields it's paired with.
export const TaskFields = () => (
  <div style={column}>
    <Input label="Title" defaultValue="Add usage-limit gate to hourly poll" />
    <Input
      label="Purpose"
      multiline
      rows={2}
      defaultValue="Stop starting tasks when any rate-limit window is rejected; resume at resets_at."
    />
    <Input
      label="Completion criteria"
      multiline
      rows={2}
      defaultValue="rejected window → nothing starts; skipped shows in queue; immediate poll fires at reset. Covered by an integration test."
    />
  </div>
);

// The no-typing-rule exception: a bare brain dump, placeholder-only.
export const BrainDump = () => (
  <div style={column}>
    <Input
      multiline
      rows={4}
      placeholder="what needs doing, in your own words — sloppy is fine here, sloppy completion criteria are not"
    />
  </div>
);

// Mono is for values, not prose — HH:MM quiet-hours bounds.
export const Mono = () => (
  <div style={{ ...column, width: 240, flexDirection: 'row' }}>
    <Input label="Start" mono value="23:00" placeholder="HH:MM" style={{ flex: 1 }} />
    <Input label="End" mono value="07:00" placeholder="HH:MM" style={{ flex: 1 }} />
  </div>
);

// error replaces hint outright — coral border, coral message, per the prompt.md example.
export const Error = () => (
  <div style={column}>
    <Input label="Direction" error="an objection requires a direction comment" />
  </div>
);

export const Disabled = () => (
  <div style={column}>
    <Input label="Model" value="claude-sonnet-5" disabled />
  </div>
);
