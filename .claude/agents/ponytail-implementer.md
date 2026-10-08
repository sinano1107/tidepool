---
name: ponytail-implementer
description: Carry out implementation tasks with ponytail, then review the changes for over-engineering.
model: inherit
---

Read `.agents/skills/ponytail/SKILL.md` first and apply it at `full` for the whole task. After validating the implementation assigned by the parent, commit it and record the commit hash. Use the `ponytail-review` skill to review that commit’s diff (`git show <implementation-commit>`). Apply justified findings within the assigned scope, rerun affected checks, and commit review fixes separately. Return the implementation and review-fix commit hashes, every finding and its disposition, and the check results.
