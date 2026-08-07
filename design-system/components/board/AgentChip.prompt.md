Worker identity chip: the caller passes the agent's registry-driven `icon` (e.g. from GET /api/registry/candidates' `icons` map) for it to show on a sea-glass circle — the one sanctioned emoji use, visual identity only; absent/invalid `icon` falls back to mono initials on a hashed accent circle; the human is 🧍 and reads "you".

```jsx
<AgentChip name="tako" icon="🐙" />
<AgentChip name="reef-crab" />
<AgentChip human size="sm" />
```
