# Tidepool WebUI kit

Interactive recreation of the Tidepool PWA — the single-user steering surface, mobile-first (440px), designed from the decided UX docs (no prior UI existed).

Screens (all composed from `components/`):
- **Morning triage** (`triage-screen.jsx`) — the 3-section single-path flow: questions (2–4 options, recommendation marked, free-text override; approval questions get an "out-of-authority → approval" badge + risk-propagation note) → decision-log skim (silence = approval, hover-Object with required direction) → queue preview (front-inserted highlighted, scratchpad lines triaged into task / meta-review / discard). Atomic commit; waterline shows progress. A floating scratchpad (pain capture, free text allowed) follows all three sections. With zero questions the flow starts at the log skim; "Low tide" shows only when there are no questions AND no unread log entries.
- **Board** (`board-screen.jsx`) — kanban progress overview: todo / in_progress / blocked / done. `skipped` never appears here.
- **Queue** (`queue-screen.jsx`) — TODO queue with slot line in four states (busy / free / warning / limit — limit renders every row as skipped, the Swell throttle), FIFO order, hover "↑ front" (= run now), dashed skipped rows, an optional "workspace needs human" banner (tree-rule failure), plus the "Your tasks" human list outside the queue.
- **Register** (`register-screen.jsx`) — brain dump → LLM-drafted fields → confirm; appends to queue tail. Plain-form fallback for LLM outage (same fields, no draft).
- **Single question** (in `index.html`) — the deep-link target of a daytime push: banner → one question card → answer applies immediately, parent to front. Trigger via "simulate question push" in the tweaks panel.
- **Handoff assist** (in `index.html`) — completing a human task that blocks AI work opens a bottom sheet: free-text dump → LLM-drafted 6-field handoff with ⚠ gap flags → complete with handoff / explicit skip. Isolated human tasks close one-tap.

`index.html` is the interactive shell (bottom tab nav, toasts, working triage commit that front-inserts unblocked parents, one repair task per objected entry, and scratchpad-triaged tasks to the tail). `data.js` holds the fake board state. The tweaks panel's States section switches slot state and the workspace alert for demo purposes.
