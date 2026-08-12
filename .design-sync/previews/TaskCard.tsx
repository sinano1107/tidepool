import { TaskCard } from 'tidepool-design-system';

// Stacked, not the board's cramped 210px kanban columns — a wider column
// keeps each card's full content on one line.
const column = { width: 320, display: 'flex', flexDirection: 'column' as const, gap: 10 };

// The five statuses, in the board's own column order.
export const Statuses = () => (
  <div style={column}>
    <TaskCard task={{ id: 'tp-0139', title: 'Registry loader', status: 'todo', type: 'work', assignee: 'reef-crab' }} />
    <TaskCard task={{ id: 'tp-0140', title: 'Add usage-limit gate', status: 'in_progress', type: 'work', assignee: 'anemone' }} />
    <TaskCard task={{ id: 'tp-0141', title: 'Migrate off the flat map', status: 'blocked', type: 'work', assignee: 'reef-crab', risk: true, children: 1 }} />
    <TaskCard task={{ id: 'tp-0133', title: 'Picked esbuild over rollup', status: 'done', type: 'work', assignee: 'reef-crab' }} />
    <TaskCard task={{ id: 'tp-0128', title: 'Old queue-reorder spike', status: 'cancelled', type: 'work', assignee: 'anemone' }} />
  </div>
);

// Type carries the glyph, not the color — question and review beside work.
export const Types = () => (
  <div style={column}>
    <TaskCard task={{ id: 'tp-0142', title: 'Migration window needs a human call', status: 'blocked', type: 'question', assignee: 'shako' }} />
    <TaskCard task={{ id: 'tp-0143', title: 'Registry loader PR', status: 'in_progress', type: 'review', assignee: 'anemone' }} />
    <TaskCard task={{ id: 'tp-0144', title: 'Write board schema DDL', status: 'todo', type: 'work', assignee: 'reef-crab' }} />
  </div>
);

// Blocked-with-risk — the canonical prompt.md example: amber open-child
// count plus the risk flag, both live in the badge row, never the card edge.
export const BlockedAndRisk = () => (
  <div style={column}>
    <TaskCard task={{ id: 'tp-0141', title: 'Registry loader', status: 'blocked', type: 'work', assignee: 'reef-crab', risk: true, children: 1 }} />
    <TaskCard task={{ id: 'tp-0145', title: 'Migration touches three workspaces', status: 'blocked', type: 'work', assignee: 'shako', risk: true, children: 3 }} />
  </div>
);

// The assignee is the user, not a registry agent — reads "you".
export const Human = () => (
  <div style={column}>
    <TaskCard task={{ id: 'tp-0139', title: 'Review the registry loader PR', status: 'todo', type: 'review', assignee: 'masaki', human: true }} />
  </div>
);
