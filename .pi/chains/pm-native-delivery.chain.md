---
name: pm-native-delivery
description: Triage, implement, and verify a pm-tracked change using native pm operations in Pi.
steps:
  - agent: pm-triage-agent
    task: "Triage the requested work and identify the canonical pm item for: {task}"
  - agent: worker
    task: "Implement the approved scope from the triage handoff. Use native pm for tracker operations, link changed files/tests/docs, and keep edits scoped. Original request: {task}\n\nTriage handoff:\n{previous}"
  - agent: pm-verification-agent
    task: "Verify the implementation and produce pm closure evidence. Original request: {task}\n\nImplementation handoff:\n{previous}"
---
