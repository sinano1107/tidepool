# Domain-verb MCP tools; out-of-authority operations convert to approval questions, not errors

The MCP surface exposes domain verbs (`get_current_task`, `log_decision`, `escalate`, `decompose`, `complete_task`, `register_task`, …) and deliberately no generic CRUD (`update_task` does not exist). Invariants — handoff doc required on work completion, authority checks, event emission — live inside the verbs, so they cannot be bypassed by how an agent chooses to call the API.

When a call exceeds the caller's authority (child risk above parent, assignee outside `assignable_to`), the server does not return an error: it converts the call into an approval question-task to the human, holding the operation pending. Agents never implement an "ask first, then do" two-step, so there is no protocol for them to get wrong; escalation semantics are enforced in one place. A future reader expecting a REST-ish task CRUD should read this before "fixing" the API.

Rejected alternative: thin CRUD tools with authority checks as validation errors — rejected because error-shaped denials push retry/escalation logic into every agent's prompt, and because a generic update path makes invariant bypass an agent-behavior bug instead of a structural impossibility.
