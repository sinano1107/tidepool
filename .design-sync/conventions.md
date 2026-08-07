## Building with this library

No wrapper or provider is required. Every exported component is a plain function that reads `React` (and, where used, `React.useState`) from the global scope — mount them directly, no `ThemeProvider`/context setup, no root wrapper. The only runtime requirement is that `window.React` (and `window.ReactDOM` for mounting) already exist on the page, which the rendering environment already provides.

## Styling idiom: CSS custom properties via `style`, never utility classes

This design system has no class vocabulary (no `bg-*`/`text-*` utilities). Every component styles itself inline with `var(--token-name)`, and every component accepts a `style` prop (merged last, so caller overrides win) for one-off placement/layout tweaks — never pass a `className`. Compose layout with plain inline `style` objects using the same tokens.

Real token names (see `tokens/` for the full set):

- **Color** — brand: `--tide-0`…`--tide-5` (pale → deep teal, `--tide-4` is the one action color); neutrals: `--rock-0`…`--rock-7`; status accents: `--sun-*` (blocked/questions), `--coral-*` (danger/objections), `--grass-*` (done). Semantic surfaces: `--surface-page`, `--surface-card`, `--surface-hover`, `--surface-recessed`, `--surface-ink`. Semantic text: `--text-secondary`, `--text-muted`, `--text-link`, `--text-on-ink`. Status pairs ship pre-composed: `--status-<todo|inprogress|blocked|done|cancelled|skipped>-bg` / `-fg`. Type-badge accents: `--type-<work|question|review>-fg`. `--action-primary`, `--action-primary-hover`, `--action-danger`. `--risk-bg` / `--risk-fg`.
- **Type** — families: `--font-display` (Newsreader italic — brand voice: greetings, big numerals, empty states only), `--font-ui` (Hanken Grotesk — everything else), `--font-mono` (Spline Sans Mono — ids, statuses, timestamps, counts). Sizes: `--text-2xs` … `--text-3xl`, plus semantic `--text-body`, `--text-heading`. Weight: `--weight-regular`/`--weight-medium`/`--weight-semibold`. Line-height: `--leading-tight`/`--leading-normal`/`--leading-relaxed`. Tracking: `--tracking-tight`, `--tracking-caps`.
- **Spacing** — 4px base scale: `--space-1` … `--space-16`.
- **Shape & elevation** — radius: `--radius-xs`/`-sm`/`-md`/`-lg`/`-full` (pill-first: buttons/badges/toasts/queue rows are `-full`; cards `-md`/`-lg`; inputs/tags smaller). Shadows do the work of borders: `--shadow-card`, `--shadow-raised`, `--shadow-primary`, `--shadow-overlay`, `--shadow-focus`; hairlines only via `--border-hairline`/`--border-default`/`--border-focus`.
- **Motion** — `--ease-tidal` (slow, decelerating, no bounce) with `--duration-quick`/`--duration-calm`/`--duration-slow`.

## Where the truth lives

Read `styles.css` (imports the full token set) before styling anything new — it's the complete list this bundle ships. Each component's own usage guidance and realistic prop examples live in its `<Name>.prompt.md`.

## Example

```jsx
<div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
  <TaskCard task={{ id: 'tp-0144', title: 'Write board schema DDL', status: 'in_progress', type: 'work', assignee: 'reef-crab' }} />
  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
    <Button variant="primary">Commit</Button>
    <Button variant="ghost">Reorder</Button>
  </div>
</div>
```

## Content voice (if writing copy alongside these components)

Brand name is lowercase in running text ("tidepool"). Terse, declarative, no exclamation marks, no "Great job!"-style cheerleading, no ack rituals ("Got it" / "OK, sure"). Statuses render lowercase mono exactly as stored (`todo`, `in_progress`, `blocked`, `done`, `cancelled`, `skipped`). The tide/sea metaphor belongs in serif display moments only (`--font-display`) — functional UI copy (buttons, badges, log lines) stays literal.
