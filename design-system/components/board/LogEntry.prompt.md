Decision-log line for the skim: time · agent · task id · one-line decision. Tapping a row's body opens the single Object action (the objection annotations below it are outside that tap target); a completion's right-edge chevron opens its handoff. Completions get a grass fill; unread entries a teal left bar. When an objection has a cause, show that latest cause as read-only text beside the objection annotation; `uncertain` must say that the cause is not yet determined. A `memory` cause names the memory entries the worker followed (`causeEntries`): render each id as a link beside the cause that calls `onOpenMemoryEntry`, never the row's Object.

```jsx
<LogEntry entry={{ time: '03:52', taskId: 'tp-0139', agent: 'anemone', kind: 'decision', text: 'kept the parser small', objection: 'the grammar requires nesting', cause: 'capability', unread: true }} onObject={open} />
```
