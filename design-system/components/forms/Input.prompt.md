Text input / textarea. Tidepool has a no-typing rule during triage — inputs appear only for brain dump (registration), objection direction comments, and free-text answer overrides.

```jsx
<Input label="Brain dump" multiline rows={4} placeholder="what needs doing, in your own words" />
<Input label="Direction" error="an objection requires a direction comment" />
```

Props: `multiline`, `mono`, `hint`, `error` (coral state).
