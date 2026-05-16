---
name: pm-extensions
description: Manages pm-cli package/extension lifecycle operations (explore, install, activate, diagnose, and release-safe validation). Use when building, integrating, or troubleshooting pm packages, extensions, and extension-provided commands.
license: MIT
compatibility: Requires pm package/extension commands and local project/global extension directories.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: extension-workflow
---

# pm Packages and Extensions Skill

Use this skill when the request touches package or extension install, activation, command registration, diagnostics, or extension governance.

## Quick Start

```bash
pm install guide-shell --project
pm guide extensions
pm package explore --project
pm package manage --detail summary
pm package doctor --detail deep
```

## Lifecycle Workflow

1. **Inspect state first** (`explore`, `manage`, `doctor`).
2. **Apply lifecycle mutation** (`install`, `adopt`, `activate`, `deactivate`, `uninstall`).
3. **Verify command/action exposure** with `pm contracts`.
4. **Record evidence** in linked `pm` items.

## Workflow Prompts

### Prompt: Diagnose Package Failure

`Diagnose package activation issues using pm package explore/manage/doctor before making lifecycle changes. Report root cause and minimal remediation commands.`

### Prompt: Install and Validate Package

`Install <package> in project scope, validate with doctor diagnostics, and confirm command/action availability using pm contracts runtime output.`

### Prompt: Safe Deactivation

`Deactivate or uninstall <package> with rollback-safe sequencing and explicit evidence of which commands/actions are removed.`

## Contract Verification

```bash
pm contracts --command package --flags-only
pm contracts --runtime-only --availability-only
pm contracts --command <extension-command> --flags-only
```

## Progressive Disclosure References

- [Extension lifecycle recipes](references/LIFECYCLE.md)
- [Troubleshooting playbook](references/TROUBLESHOOTING.md)
