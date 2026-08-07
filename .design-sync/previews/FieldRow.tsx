import { FieldRow } from 'tidepool-design-system';

const column = { width: 360, display: 'flex', flexDirection: 'column' as const, gap: 14 };

// The five kinds, in the order a record card tends to use them.
export const Kinds = () => (
  <div style={column}>
    <FieldRow label="description" kind="text" value="implementation · sonnet + git-guardrails" />
    <FieldRow label="repository" kind="mono" value="github.com/masaki/tidepool-registry" />
    <FieldRow label="skills" kind="tags" tags={['@workspace', 'docs:*']} scheme="skills" />
    <FieldRow label="protected" kind="bool" checked onLabel="changes need human approval" offLabel="not protected" />
    <FieldRow label="model" kind="unset" unsetLabel="adapter default" />
  </div>
);

// Tag colour carries the pickers' own grammar: sun for the wildcard, grass for
// a scope word, tide for a plain name. A registered agent shows as its chip.
export const Tags = () => (
  <div style={column}>
    <FieldRow label="skills" kind="tags" tags={['@workspace', '@host', 'review']} scheme="skills" wildcardHint="every skill" />
    <FieldRow label="assignable to" kind="tags" tags={['reef-crab', 'human']} agentIcons={{ 'reef-crab': '🦀' }} wildcardHint="any agent" />
    <FieldRow label="allowed workspaces" kind="tags" tags={['*']} wildcardHint="every workspace" />
  </div>
);

// A boolean states what it means in words, both ways — never a bare yes/no.
export const Booleans = () => (
  <div style={column}>
    <FieldRow label="protected" kind="bool" checked onLabel="changes here always need human approval" offLabel="not protected" />
    <FieldRow label="protected" kind="bool" onLabel="changes here always need human approval" offLabel="not protected" />
  </div>
);

// An empty optional field reads as its default in words, never as a blank box.
export const Unset = () => (
  <div style={column}>
    <FieldRow label="effort" kind="unset" unsetLabel="adapter default" />
    <FieldRow label="advisor model" kind="unset" unsetLabel="no advisor" />
    <FieldRow label="notes" kind="unset" unsetLabel="—" />
  </div>
);
