---
name: pm-native
description: Use only when an existing Codex workflow explicitly invokes pm-native. This compatibility skill routes to the canonical pm-workflow and pm-planner skills.
license: MIT
---

# pm Native Compatibility

Use pm-workflow for orientation, claim, evidence, and handoff. Use pm-planner
for durable Plan steps. The native pm MCP server exposes the same public SDK
contracts in both workflows.

Read live pm_context and pm_search before creating or mutating items. Claim
only active work, preserve linked evidence, and release the claim when done.
