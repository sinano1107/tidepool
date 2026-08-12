import { Button } from 'tidepool-design-system';

const row = { display: 'flex', gap: 12, alignItems: 'center' };

// One primary per view; the rest name what everything else is for.
export const Variants = () => (
  <div style={row}>
    <Button variant="primary">Commit</Button>
    <Button variant="secondary">Reorder</Button>
    <Button variant="ghost">Skip</Button>
    <Button variant="danger">Object</Button>
  </div>
);

// lg is the 44px mobile hit-target.
export const Sizes = () => (
  <div style={row}>
    <Button size="sm">Reorder</Button>
    <Button size="md">Commit</Button>
    <Button size="lg">Commit</Button>
  </div>
);

// Stretches to its container — mobile action rows.
export const Full = () => (
  <div style={{ width: 320 }}>
    <Button variant="primary" full>
      Commit
    </Button>
  </div>
);

export const Disabled = () => (
  <div style={row}>
    <Button variant="primary" disabled>
      Commit
    </Button>
    <Button variant="danger" disabled>
      Object
    </Button>
  </div>
);
