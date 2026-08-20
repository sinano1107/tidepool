Modal — confirmation moments only (commit triage, cancel task); flows are full screens, not modals.
When the body is long, only the body scrolls; the title and footer remain fixed.

```jsx
<Dialog title="Cancel task?" onClose={close}
  footer={<><Button variant="ghost">Keep</Button><Button variant="danger">Cancel task</Button></>}>
  tp-0141 will be marked cancelled. done stays unpolluted.
</Dialog>
```
