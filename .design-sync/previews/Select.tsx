import { Select } from 'tidepool-design-system';

const column = { width: 280, display: 'flex', flexDirection: 'column' as const, gap: 14 };

// Registration's assignee/workspace pickers — plain string options.
export const Assignee = () => (
  <div style={column}>
    <Select label="Assignee" options={['reef-crab', 'anemone', 'you']} value="reef-crab" />
    <Select label="Workspace" options={['tidepool', 'registry', 'skills-fork']} value="tidepool" />
  </div>
);

// { value, label } pairs — the value is a keyword, the label spells out what it means.
export const LabelledOptions = () => (
  <div style={column}>
    <Select
      label="Mode"
      options={[
        { value: 'clone', label: 'clone a repository' },
        { value: 'create', label: 'create a new private repository' },
        { value: 'register', label: 'register an existing path' },
      ]}
      value="clone"
    />
    <Select
      label="Merge authority"
      options={[
        { value: '', label: 'no automatic merge decision (default)' },
        { value: 'escalate', label: 'escalate — always ask a human before merging' },
        { value: 'auto_if_ci_green', label: 'auto_if_ci_green — merge unattended once CI is green' },
      ]}
      value=""
    />
  </div>
);

export const Disabled = () => (
  <div style={column}>
    <Select label="Authority" options={['default', 'careful', 'autonomous']} value="default" disabled />
  </div>
);
