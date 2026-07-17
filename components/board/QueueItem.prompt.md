TODO-queue row: drag handle, position, id, title, assignee. The hover "↑ front" action means two different things depending on `isHead`: on the true head row it's "run now" (tide-colored, fires an immediate pickup poll); on every other row it's plain reorder-to-head (neutral/rock-colored, no poll — press it again once the row becomes head to actually run it). `skipped` renders dashed; its reason text comes from `skipReason` (pause / fail-closed throttle / a known throttle resume time), never a single hardcoded string. `frontInserted` gets a tide fill.

```jsx
<QueueItem position={1} task={{ id: 'tp-0144', title: 'Write board schema DDL', assignee: 'reef-crab' }} isHead frontInserted onFront={front} />
<QueueItem position={2} task={{ id: 'tp-0145', title: 'Add usage-limit gate', assignee: 'reef-crab' }} skipped skipReason="usage check unavailable" onFront={front} />
```
