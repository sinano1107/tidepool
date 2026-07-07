# Tidepool WebUI kit

Interactive recreation of the Tidepool PWA — the single-user steering surface, mobile-first (440px), designed from the decided UX docs (no prior UI existed).

Screens (all composed from `components/`):
- **Morning triage** (`triage-screen.jsx`) — the 3-section single-path flow: questions (2–4 options, recommendation marked, free-text override) → decision-log skim (silence = approval, hover-Object with required direction) → queue preview (front-inserted highlighted). Atomic commit; waterline shows progress.
- **Board** (`board-screen.jsx`) — kanban progress overview: todo / in_progress / blocked / done. `skipped` never appears here.
- **Queue** (`queue-screen.jsx`) — TODO queue with slot line ("tide level"), FIFO order, hover "↑ front" (= run now), dashed skipped rows, plus the "Your tasks" human list outside the queue.
- **Register** (`register-screen.jsx`) — brain dump → LLM-drafted fields → confirm; appends to queue tail.

`index.html` is the interactive shell (bottom tab nav, toasts, working triage commit that front-inserts unblocked parents and one repair task per objected entry). `data.js` holds the fake board state.
