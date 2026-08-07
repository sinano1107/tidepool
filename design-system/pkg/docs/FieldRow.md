The read half of a field. Use it wherever a card shows a value it can also edit — FieldRow while viewing, Input/Select/Switch in the same slot while editing.

```jsx
<FieldRow label="repository" kind="mono" value="github.com/masaki/tidepool" />
<FieldRow label="skills" kind="tags" tags={['@workspace', 'docs:*']} scheme="skills" />
<FieldRow label="protected" kind="bool" checked onLabel="changes need human approval" offLabel="not protected" />
<FieldRow label="model" kind="unset" unsetLabel="adapter default" />
```
