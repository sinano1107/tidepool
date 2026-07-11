TODO-queue row: drag handle, position, id, title, assignee. "Run now" = the hover "↑ front" action (same operation as reorder). `skipped` renders dashed with "resumes on reset"; `frontInserted` gets a tide fill.

```jsx
<QueueItem position={1} task={{ id: 'tp-0144', title: 'Write board schema DDL', assignee: 'reef-crab' }} frontInserted onFront={front} />
```
