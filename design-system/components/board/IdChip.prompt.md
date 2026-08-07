The truncated id chip (9ch + ellipsis, full id on hover via `title`) shared by QueueItem's id column, the Queue slot line, and the pause toast's task-finishing detail. Owns truncation only — typography and layout come from the caller's `style`.

```jsx
<IdChip id={task.id} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', flexShrink: 0 }} />
```
