import { IconButton } from 'tidepool-design-system';

const row = { display: 'flex', gap: 10, alignItems: 'center' };

// The system loads Lucide icons imperatively at runtime (`lucide.createIcons()`)
// rather than as static markup, so these previews use plain inline SVG glyphs —
// same 16-20px / 1.5px-stroke spec the prompt.md calls for, statically renderable.
const ArrowUpToLine = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3h14" />
    <path d="M12 21V7" />
    <path d="M6 13l6-6 6 6" />
  </svg>
);
const Bell = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 8a6 6 0 0 1 12 0c0 6 2 8 2 8H4s2-2 2-8" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
);
const Pause = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M8 4v16" />
    <path d="M16 4v16" />
  </svg>
);
const X = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M5 5l14 14M19 5L5 19" />
  </svg>
);

// prompt.md's own canonical call — a queue-reorder action, in both variants.
export const Variants = () => (
  <div style={row}>
    <IconButton label="Move to front">
      <ArrowUpToLine />
    </IconButton>
    <IconButton label="Move to front" variant="outline">
      <ArrowUpToLine />
    </IconButton>
  </div>
);

// sm=28 / md=36 / lg=44px (lg is the mobile hit-target) — same icon throughout.
export const Sizes = () => (
  <div style={row}>
    <IconButton label="Notifications" size="sm">
      <Bell />
    </IconButton>
    <IconButton label="Notifications" size="md">
      <Bell />
    </IconButton>
    <IconButton label="Notifications" size="lg">
      <Bell />
    </IconButton>
  </div>
);

// A real toolbar cluster — three distinct list-row actions together.
export const ToolbarCluster = () => (
  <div style={row}>
    <IconButton label="Move to front">
      <ArrowUpToLine />
    </IconButton>
    <IconButton label="Pause pickup">
      <Pause />
    </IconButton>
    <IconButton label="Dismiss">
      <X />
    </IconButton>
  </div>
);

export const Disabled = () => (
  <div style={row}>
    <IconButton label="Move to front" disabled>
      <ArrowUpToLine />
    </IconButton>
    <IconButton label="Move to front" variant="outline" disabled>
      <ArrowUpToLine />
    </IconButton>
  </div>
);
