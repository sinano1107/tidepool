import { Button, Card, Tag, TaskCard } from 'tidepool-design-system';

const column = { width: 360, display: 'flex', flexDirection: 'column' as const, gap: 14 };

// The settings screen's canonical use: a plain shell around a labeled record,
// metadata carried by Tag chips — never a colored card edge.
export const Default = () => (
  <div style={column}>
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>tidepool-registry</span>
        <Tag color="tide" mono>registry</Tag>
        <Tag color="sun">protected</Tag>
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        the board's own registry clone — protection stays on
      </div>
    </Card>
  </div>
);

// interactive (hover fill + pointer) vs selected (teal ring) — the two
// state props, side by side so the difference actually reads.
export const States = () => (
  <div style={column}>
    <Card interactive onClick={() => {}} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>interactive — click to open</span>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>hover fills the surface, pointer cursor</span>
    </Card>
    <Card selected style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>selected</span>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>teal ring, no hover behavior</span>
    </Card>
  </div>
);

// The queue screen's "Your tasks" row — a plain-shell list item holding a
// task summary plus an inline action.
export const HumanTaskRow = () => (
  <div style={column}>
    <Card style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>tp-0139</span>
      <span style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-heading)' }}>Review the registry loader PR</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sun-4)' }}>blocks tp-0141</span>
      <Button variant="secondary" size="sm">Done</Button>
    </Card>
  </div>
);

// A card can hold a full component, not just text — here a TaskCard nested
// inside a "pinned" shell, the padding pulled to 0 so the child owns its own.
export const HoldingTaskCard = () => (
  <div style={column}>
    <Card padding="0" style={{ overflow: 'hidden' }}>
      <TaskCard task={{ id: 'tp-0141', title: 'Registry loader', status: 'blocked', type: 'work', assignee: 'reef-crab', risk: true, children: 1 }} />
    </Card>
  </div>
);
