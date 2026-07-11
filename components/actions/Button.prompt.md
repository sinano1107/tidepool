Tidepool button — one teal primary per view; labels say what they do ("Answer", "Object", "Commit"), never "OK".

```jsx
<Button variant="primary" onClick={commit}>Commit</Button>
<Button variant="secondary" size="sm">Reorder</Button>
<Button variant="danger">Object</Button>
```

Variants: primary (teal), secondary (outlined), ghost, danger (coral, for objections). Sizes sm/md/lg (lg = 44px mobile hit target). `full` stretches to container.
