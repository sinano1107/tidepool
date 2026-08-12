import { QueueItem } from 'tidepool-design-system';

// Stacked, not a wide row — queue rows already read full-width in the app;
// a column keeps the card from cropping. Wider than FieldRow's 360 since
// the title needs room before it truncates.
const column = { width: 440, display: 'flex', flexDirection: 'column' as const, gap: 10 };

// A real queue slice — head row draggable + reorderable, position order.
export const Queue = () => (
  <div style={column}>
    <QueueItem position={1} task={{ id: 'tp-0144', title: 'Write board schema DDL', assignee: 'reef-crab' }} isHead draggable onFront={() => {}} />
    <QueueItem position={2} task={{ id: 'tp-0145', title: 'Add usage-limit gate', assignee: 'anemone' }} draggable onFront={() => {}} />
    <QueueItem position={3} task={{ id: 'tp-0146', title: 'Migrate registry loader off the flat map', assignee: 'reef-crab', risk: true }} draggable onFront={() => {}} />
  </div>
);

// Same "↑ front" action, two meanings: tide-filled "run now" on the true
// head, tide-outlined plain reorder on every other row.
export const HeadVsReorder = () => (
  <div style={column}>
    <QueueItem position={1} task={{ id: 'tp-0144', title: 'Write board schema DDL', assignee: 'reef-crab' }} isHead onFront={() => {}} />
    <QueueItem position={2} task={{ id: 'tp-0145', title: 'Add usage-limit gate', assignee: 'anemone' }} onFront={() => {}} />
  </div>
);

// Skipped rows render dashed — the reason always names why, never a bare
// "skipped": pause, fail-closed throttle, and a known resume time.
export const Skipped = () => (
  <div style={column}>
    <QueueItem position={1} task={{ id: 'tp-0147', title: 'Pause pickup handoff', assignee: 'reef-crab' }} skipped skipReason="pickup paused" />
    <QueueItem position={2} task={{ id: 'tp-0148', title: 'Add usage-limit gate', assignee: 'anemone' }} skipped skipReason="usage check unavailable" />
    <QueueItem position={3} task={{ id: 'tp-0149', title: 'Docs sweep for the settings drilldown', assignee: 'shako' }} skipped skipReason="resumes 06:12" />
  </div>
);

// Triage's pending list — front-inserted this session, no drag handle or
// front action (read-only preview of what's about to land).
export const FrontInserted = () => (
  <div style={column}>
    <QueueItem position={1} task={{ id: 'tp-0150', title: 'Fallback throws on empty input', assignee: 'anemone' }} frontInserted />
    <QueueItem position={2} task={{ id: 'tp-0151', title: 'Migration window needs a human call', assignee: 'shako' }} frontInserted />
  </div>
);
