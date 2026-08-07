Kanban card for one task. Status lives in the badge (never the card edge); blocked shows its open-child count in amber.

```jsx
<TaskCard task={{ id: 'tp-0141', title: 'Registry loader', status: 'blocked', type: 'work', assignee: 'reef-crab', risk: true, children: 1 }} onClick={open} />
```
