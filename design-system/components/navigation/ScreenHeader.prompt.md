Header for a screen you drilled into. The back button names where it goes, so a two-deep stack stays readable. The title is a plain `h1` at screen-title size — same treatment as a top-level screen's own heading.

```jsx
<ScreenHeader title="Agents" backLabel="Settings" meta="3 registered" onBack={goBack}>
  <Button variant="ghost" size="sm" onClick={toggleAdd}>Add</Button>
</ScreenHeader>
```
