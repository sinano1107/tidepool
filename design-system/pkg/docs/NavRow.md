A row in a drilldown index — label on the left, current-state summary on the right, chevron. Stack them inside a Card; `first` / `last` give the stack its corners and `divider` draws the hairline between rows. Not a list item for data — that's QueueItem.

```jsx
<NavRow label="Agents" summary="4 agents" first onClick={openAgents} />
<NavRow agentName="reef-crab" agentIcon="🦀" summary="implementer" divider last onClick={openAgent} />
```
