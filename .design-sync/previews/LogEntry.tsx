import { LogEntry } from 'tidepool-design-system';

const column = { width: 420, display: 'flex', flexDirection: 'column' as const };

// The four kinds a morning skim actually scrolls through.
export const Kinds = () => (
  <div style={column}>
    <LogEntry entry={{ time: '07:14', taskId: 'tp-0133', agent: 'reef-crab', kind: 'decision', text: 'picked esbuild over rollup — smaller config surface' }} />
    <LogEntry entry={{ time: '03:52', taskId: 'tp-0139', agent: 'anemone', kind: 'completion', text: 'criteria met — PR #58' }} onExpand={() => {}} />
    <LogEntry entry={{ time: '09:21', taskId: 'tp-0142', agent: 'shako', kind: 'escalation', text: 'blocked — needs a human call on the migration window' }} onObject={() => {}} />
    <LogEntry
      entry={{ time: '11:03', taskId: 'tp-0139', agent: 'anemone', kind: 'objection', text: 'reopened after review', objection: 'the fallback path still throws on empty input' }}
      onObject={() => {}}
    />
  </div>
);

// Unread bar (since-last-skim) vs. the user's own entries.
export const UnreadAndHuman = () => (
  <div style={column}>
    <LogEntry entry={{ time: '14:02', taskId: 'tp-0144', agent: 'reef-crab', kind: 'completion', text: 'schema migration applied — 0 rows affected', unread: true }} />
    <LogEntry entry={{ time: '14:10', taskId: 'tp-0144', human: true, kind: 'decision', text: 'approved — ship to the pi tonight' }} />
  </div>
);

// A row with the objection composer open for it.
export const Objecting = () => (
  <div style={column}>
    <LogEntry entry={{ time: '09:21', taskId: 'tp-0142', agent: 'shako', kind: 'escalation', text: 'blocked — needs a human call on the migration window' }} onObject={() => {}} active />
  </div>
);
