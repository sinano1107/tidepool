The truncated id chip (9ch + ellipsis, full id on hover via `title` — desktop only; on touch the full id is read where tapping a Board card leads — the info toast or task actions dialog — and in the handoff heading) shared by TaskCard's heading row, QueueItem's id column, the Queue slot line, the LogEntry heading row, and the pause toast's task-finishing detail. Owns truncation and typography (muted mono, `flexShrink: 0`) — layout comes from the caller's `style`, which overrides the defaults.

```jsx
<IdChip id={task.id} />
```
