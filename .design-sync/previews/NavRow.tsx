import { Card, NavRow } from 'tidepool-design-system';

// The settings index: four rows, each summarising its own section's state.
export const Index = () => (
  <Card padding="0" style={{ overflow: 'hidden', width: 360 }}>
    <NavRow label="Board" summary="en · 23:00–07:00" first onClick={() => {}} />
    <NavRow label="Workspaces" summary="3 · 1 protected" divider onClick={() => {}} />
    <NavRow label="Agents" summary="4 agents" divider onClick={() => {}} />
    <NavRow label="Authority Profiles" summary="3 profiles" divider last onClick={() => {}} />
  </Card>
);

// A registry list: an agent row wears its chip instead of a plain label.
export const AgentRows = () => (
  <Card padding="0" style={{ overflow: 'hidden', width: 360 }}>
    <NavRow agentName="reef-crab" agentIcon="🦀" summary="implementer" first onClick={() => {}} />
    <NavRow agentName="anemone" agentIcon="🪸" summary="reviewer" divider onClick={() => {}} />
    <NavRow agentName="hermit" agentIcon="🐚" summary="docs-editor" divider last onClick={() => {}} />
  </Card>
);

// A summary too long for the row truncates from the left, keeping the tail
// that identifies it; an unreachable section says so in the alert tone.
export const SummaryTones = () => (
  <Card padding="0" style={{ overflow: 'hidden', width: 360 }}>
    <NavRow label="Workspaces" summary="github.com/masaki/tidepool-registry" first onClick={() => {}} />
    <NavRow label="Agents" summary="no registry configured" summaryTone="alert" divider last onClick={() => {}} />
  </Card>
);
