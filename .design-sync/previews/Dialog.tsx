import { Button, Dialog } from 'tidepool-design-system';

// Dialog renders `position: fixed; inset: 0`. The card harness contains
// fixed descendants inside a `transform`-ed wrapper, which becomes their
// containing block — an in-flow spacer here gives that wrapper a real
// height, so `inset: 0` resolves against it instead of collapsing to 0.
const spacer = { height: 500 };

// Confirmation moments only — commit triage, cancel task. Not used for flows.
export const CancelConfirm = () => (
  <div style={spacer}>
    <Dialog
      title="Cancel task?"
      footer={
        <>
          <Button variant="ghost">Keep</Button>
          <Button variant="danger">Cancel task</Button>
        </>
      }
    >
      tp-0141 will be marked cancelled. done stays unpolluted.
    </Dialog>
  </div>
);

// No footer — content-only confirmation.
export const Notice = () => (
  <div style={spacer}>
    <Dialog title="Objection recorded">reef-crab will see this on the next skim.</Dialog>
  </div>
);
