Icon-only square button (toolbars, list-row actions). Always pass `label`; icon is children (Lucide, 16–20px, 1.5px stroke).

```jsx
<IconButton label="Move to front" onClick={front}><i data-lucide="arrow-up-to-line"></i></IconButton>
```

Sizes sm/md/lg (lg = 44px mobile). Variants ghost (default) / outline.
