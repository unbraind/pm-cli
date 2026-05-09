---
name: pm-sdk
description: Implements pm-cli integrations using @unbrained/pm-cli/sdk and runtime contracts. Use when authoring extensions, wrappers, or automation that must stay aligned with command/action schema changes.
license: MIT
compatibility: Requires Node.js and access to pm contracts output for runtime parity checks.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: sdk-integration
---

# pm SDK Skill

Use this skill when integrating against `@unbrained/pm-cli/sdk` or validating external wrappers.

## Quick Start

```bash
pm guide sdk
pm contracts --schema-only
pm contracts --runtime-only --availability-only
pm contracts --command <command> --flags-only
```

## Integration Workflow

1. Capture current runtime schema and command contracts.
2. Map integration payload fields to contract keys.
3. Implement with SDK exports (no internal `src/core/...` imports).
4. Validate command/action availability in runtime-only mode.
5. Add regression tests for schema-bound behavior.

## Workflow Prompts

### Prompt: Build New Integration

`Implement <integration> using @unbrained/pm-cli/sdk and pm contracts output as the source of truth. Add tests that fail when required command/action fields drift.`

### Prompt: Contract Drift Investigation

`Compare integration assumptions with current pm contracts output, identify drift, and patch mapping logic and tests to restore parity.`

### Prompt: Extension Authoring

`Author extension registration using defineExtension and declared capabilities only, then verify activation and command availability with pm contracts.`

## Progressive Disclosure References

- [Integration checklist](references/INTEGRATION_CHECKLIST.md)
- [SDK prompt templates](references/PROMPTS.md)
