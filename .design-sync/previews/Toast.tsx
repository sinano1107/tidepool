import { Toast } from 'tidepool-design-system';

// In-flow only — Toast owns no positioning of its own; the caller places it
// (usually fixed to a screen corner). Stacked here the way FieldRow stacks.
const column = { width: 380, display: 'flex', flexDirection: 'column' as const, gap: 10 };

// Board-operation confirmations — facts, never acks. The four kinds.
export const Kinds = () => (
  <div style={column}>
    <Toast kind="info" detail="tp-0139">reordered — now at front of queue</Toast>
    <Toast kind="success" detail="tp-0141">committed — PR #58 opened</Toast>
    <Toast kind="warn">watchdog killed after 2h — question created</Toast>
    <Toast kind="danger" detail="tp-0144">workspace needs human — pickup paused</Toast>
  </div>
);

// A dismissible toast — the ✕ only shows when `onDismiss` is passed.
export const Dismissible = () => (
  <div style={column}>
    <Toast kind="success" detail="tp-0141" onDismiss={() => {}}>committed tp-0141</Toast>
  </div>
);
