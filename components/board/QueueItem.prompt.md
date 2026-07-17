TODO-queue row: drag handle, position, id, title, assignee. The hover "↑ front" action means two different things depending on `isHead`: on the true head row it's "run now" (tide-filled pill, fires an immediate pickup poll); on every other row it's plain reorder-to-head (same tide hue but outlined/transparent, no poll — press it again once the row becomes head to actually run it). Same color family so both read as "the queue action," never a neutral/rock treatment, which this design system reserves for disabled. `skipped` renders dashed; its reason text comes from `skipReason` (pause / fail-closed throttle / a known throttle resume time), never a single hardcoded string. `frontInserted` gets a tide fill.

```jsx
<QueueItem position={1} task={{ id: 'tp-0144', title: 'Write board schema DDL', assignee: 'reef-crab' }} isHead frontInserted onFront={front} />
<QueueItem position={2} task={{ id: 'tp-0145', title: 'Add usage-limit gate', assignee: 'reef-crab' }} skipped skipReason="usage check unavailable" onFront={front} />
```
