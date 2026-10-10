Kanban card for one task. The id is shown truncated (IdChip: 9ch + ellipsis); the full id is in its `title` on hover and, on touch, where tapping the card leads. Status lives in the badge (never the card edge); blocked shows its open-child count in amber.

```jsx
<TaskCard task={{ id: '9d47c877-20ca-4564-a661-39bad4738912', title: 'Registry loader', status: 'blocked', type: 'work', assignee: 'reef-crab', risk: true, children: 1 }} onClick={open} />
```
