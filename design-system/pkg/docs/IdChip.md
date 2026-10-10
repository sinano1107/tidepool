The truncated id chip (9ch + ellipsis, full id on hover via `title` — desktop only; on touch the full id is read from Board's TaskCard or the handoff heading) shared by QueueItem's id column, the Queue slot line, the LogEntry heading row, and the pause toast's task-finishing detail. Owns truncation and typography (muted mono, `flexShrink: 0`) — layout comes from the caller's `style`, which overrides the defaults.

```jsx
<IdChip id={task.id} />
```
