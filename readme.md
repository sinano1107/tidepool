# tidepool design system

Design system for **Tidepool** — a multi-AI kanban board (MCP + WebUI, on a Raspberry Pi) for task delegation and handoff. Tasks swell in like the tide; heterogeneous agents each handle what's within their decision authority; the human steers everything in ~10 minutes over morning coffee.

## Company / product context

Tidepool is a single-user system: one human, one Raspberry Pi, a small community of deliberately heterogeneous AI agents. Its core bet is **making synchronous decision requests asynchronous** — the human submits tasks before bed and triages questions, decision logs, and the queue in a fixed morning flow. Everything is a task; escalation is task creation; failure is escalation; the system tunes its own authority boundaries from its own logs (the **Concentration** loop — the intertidal phenomenon: an isolated pool concentrates between tides, until the next Swell flushes it). The periodic task-intake cycle is called **Swell**.

**One product surface**: the Tidepool WebUI — a Vite + React PWA served from the Pi over Tailscale, installed to the phone home screen. Its screens: kanban board (progress overview), TODO queue (ordering + manual intervention), morning triage flow (questions → log skim → queue check), task registration (brain dump → LLM draft). Agents connect over MCP, not UI — the WebUI is built for exactly one person, mostly on a phone, often at 7am.

### Sources provided
Markdown design docs only (in `uploads/`): overview, design-principles, technical-architecture, naming, tracker-integration, adjacent-products, task-pickup-ux, morning-triage-ux, worker-and-workspace-ux, failure-and-status, future-ideas. **No Figma, no codebase, no logo, no font files, no imagery were provided** — all visual foundations here were designed from scratch against the written brand (see Caveats).

## CONTENT FUNDAMENTALS

How Tidepool writes:

- **Brand name is lowercase in running text** — "tidepool", like the docs. Title-case "Tidepool" only at sentence start or in formal headings.
- **Terse, engineering-precise, declarative.** Sentences state decisions: "Silence = approval." "Failure = escalation." "No auto-retry in v1." Em-dashes and colons over subordinate clauses.
- **Second person for the user, named roles for everyone else** — "your tasks", "the assignee decides how to recover". Agents are workers, never anthropomorphized beyond their species icon.
- **Domain vocabulary is load-bearing and never paraphrased**: task, worker, assignee, decision authority, escalation, question / work / review (task types), fix-forward, objection, handoff doc, triage, the slot, Swell, Concentration. Statuses always render in lowercase mono exactly as stored: `todo`, `in_progress`, `blocked`, `done`, `cancelled`, `skipped`.
- **World-flavored copy at key moments only.** Serif display moments — triage section titles, empty states, the morning summons — speak in the tide metaphor: "The tide brought 3 questions." · "3 decisions made overnight." · "The tide is going out." · "Low tide. Go enjoy your coffee." (empty state, with 🐚 above — an avatar-style accent, not inline copy). Functional UI (buttons, badges, toasts, log lines, field labels) stays literal — never "surfed to the front", always "moved to front of queue". The metaphor lives in the voice, not the controls.
- **What "tide" means**: the tide is the exchange between you and the pool — NOT task volume. High tide = you are connected and steering (evening Swell, morning triage); low tide = the pool is isolated and running on its own (Concentration). So "Low tide. Go enjoy your coffee." after triage is correct even though the agents' queue is full — the water went out, the pool works alone until the next tide.
- **Numbers are budgets**: "~10 minutes", "2–4 options", "concurrency=1". Quantities are stated, not softened.
- **No emoji in copy.** The single sanctioned text glyph is a functional ⚠ for missing-field warnings ("⚠ deliverable location unknown"). Species emoji exist only as agent avatars (see ICONOGRAPHY) — never inline in sentences. No exclamation marks, no cheerleading ("Great job!" is banned). The UI never thanks or congratulates.
- **No ack rituals in copy either** — buttons say what they do ("Answer", "Object", "Commit"), never "Got it" / "OK, sure".
- Example microcopy: "The tide brought 3 questions." (triage title) · "silence is consent" · "moved to front of queue" · "watchdog killed after 2h — question created" · "Low tide. Go enjoy your coffee." (empty state).

## VISUAL FOUNDATIONS

The aesthetic is **sea-glass candy over a coastal-technical skeleton**: a pale sea-glass page, white pill and card surfaces floated on soft teal shadows (no borders), one deep teal for action, filled status pills — while the copy, density, and information structure stay instrument-quiet.

- **Color**: page is pale sea-glass `--tide-0 #f4f9f7`; green-cast rock neutrals for text; primary **tide teal** `--tide-4 #1d6a66` (actions, links); the serif brand voice sits in **deep teal `--tide-5`**, not ink. **Sun amber** for questions/blocked, **coral** for objections/danger, **eelgrass** for done. Status pills are filled mid-tones with white text; `todo` is white with a teal shadow ("not yet wet").
- **Type**: Newsreader (serif italic, in `--tide-5`) is the brand voice — greetings, wordmark, big triage numerals. Hanken Grotesk is all UI. Spline Sans Mono is all board data: statuses, task ids, timestamps, counts, log entries. The serif/mono contrast (calm voice vs. precise record) is the core typographic motif.
- **Spacing**: 4px base scale (`--space-1…16`). Dense in lists (12px paddings), generous around the triage flow (32–64px). Screens are single-column mobile-first (~420px), board is the one horizontal surface.
- **Backgrounds**: flat sea-glass; recessed wells `--surface-recessed` for board columns. No images, no illustration, no patterns, no gradients — the one atmospheric device is the **waterline**: a 2px teal horizontal rule that marks "the tide level" (progress through triage, queue front, section dividers).
- **Corners**: pill-first — buttons, badges, toasts, and queue rows are full pills; cards 20px; inner cards 16px; inputs 10px; tags 6px.
- **Borders & shadows**: shadows do the work of borders — cards and pills are borderless, floated on soft teal-cast shadows (`--shadow-card`, `--shadow-raised`); the primary button carries `--shadow-primary`. Hairlines remain only for inputs and in-card row separators. No inner shadows.
- **Motion**: tidal — slow, decelerating, no bounce. `--ease-tidal cubic-bezier(0.25,0.6,0.3,1)`; 120ms hovers, 240ms reveals, 480ms page-level. Fades and small vertical drifts (4–8px) only. Skipped tasks pulse nothing; nothing loops.
- **Hover**: background shifts to `--surface-hover` (pale mint); text/links darken to `--tide-5`. **Press**: darken one step, no shrink. **Focus**: 3px teal ring `--shadow-focus`.
- **Transparency/blur**: only dialog scrims (`rgba(23,33,30,0.4)`). No glassmorphism.
- **Cards**: white, borderless, 20px radius, `--shadow-card`, 16px padding. Never colored left-borders — status lives in the badge, not the card edge.
- **Imagery**: none in-product. If ever needed: cool, blue-green, natural (rock, water), never stock-office.

## ICONOGRAPHY

No icon assets were provided. The system uses **Lucide** (CDN, stroke icons, 1.5px stroke at 16–20px) — chosen to match the technical-calm foundation. **This is a substitution, flag for review.** Usage: icons are functional only (status glyphs, nav, actions), always paired with or replaced by text where budget allows; never decorative. Unicode is used for two things: the sanctioned ⚠, and `·` middots as metadata separators. **Agent species icons are the one sanctioned emoji use**: 🦀 reef-crab, 🪸 anemone, 🐚 hermit, 🧍 the human — rendered by `AgentChip` on a sea-glass circle — visual identity only, never inline in copy. Unknown agents fall back to two-letter mono initial chips.

**No logo exists.** The wordmark is plain type: lowercase "tidepool" in Newsreader italic. Do not draw a mark.

## Index

- `styles.css` — global entry; imports everything under `tokens/`
- `tokens/` — `colors.css`, `typography.css`, `spacing.css` (also radius/shadow/motion), `fonts.css`, `base.css`
- `guidelines/` — foundation specimen cards (Design System tab)
- `components/core/` — Button, IconButton, Input, Select, Checkbox, Switch, Tag, Card, Dialog, Toast
- `components/board/` — StatusBadge, TypeBadge, RiskFlag, AgentChip, TaskCard, LogEntry, QueueItem
- `ui_kits/tidepool-webui/` — interactive recreation-grade screens: Board, Queue, Morning Triage, Register
- `SKILL.md` — agent-skill entry point

### Intentional additions
No source defined a component inventory, so the core set is authored from scratch, sized to the WebUI's decided screens. `components/board/` are domain primitives required by the decided UX (status set, decision log, queue, question cards) — not speculative.

## Caveats
- Fonts are Google Fonts choices (Newsreader / Hanken Grotesk / Spline Sans Mono), not provided binaries — loaded via CDN `@import` in `tokens/fonts.css`.
- Lucide icons are a CDN substitution; no source icon set existed.
- All UI kit screens are **designed from the written UX docs**, not recreated from an existing UI — no product UI existed to copy.
