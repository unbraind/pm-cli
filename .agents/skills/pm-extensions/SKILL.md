---
name: pm-extensions
description: Manages pm-cli package and extension lifecycle — explore, install, activate, author, diagnose, and release-safe validation. Use when building, integrating, or troubleshooting pm packages, extensions, and extension-provided commands.
license: MIT
compatibility: Requires pm package/extension commands and local project/global extension directories.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: extension-workflow
---

# pm Packages and Extensions Skill

Extensions are how pm becomes specific to a project without forking it. They
register commands, item types, importers, exporters, search providers, and
profiles over the same substrate.

## Load Order

| Tier | Load                                              | Cost      | When                          |
| ---- | ------------------------------------------------- | --------- | ----------------------------- |
| 0    | This file                                         | ~650 tok  | Always.                       |
| 1    | `pm package explore --project`                    | ~0.5-2k   | See what is installed.        |
| 1    | `pm package doctor --detail deep`                 | ~1-3k     | Diagnose activation failures. |
| 2    | `pm contracts --runtime-only --availability-only` | ~1-2k     | What this install exposes.    |
| 3    | `references/*.md` below                           | ~0.3-1k   | Procedure detail.             |
| 4    | `docs/EXTENSIONS.md`, `docs/EXTENSION_LIFECYCLE.md` | varies  | Only when routed there.       |

Optional deep routing that never goes stale:

```bash
pm package install guide-shell --project
pm guide extensions
```

## Non-Negotiables

- Author identity is detected automatically. **Never pass `--author`, never set
  `PM_AUTHOR`.**
- Declare the minimum capability set; anything undeclared is not granted.
- Never mirror a public SDK type inside a package — import it or derive it.
- Inspect before mutating; verify exposure after.

## Before Creating A Package

Check whether an existing package already owns the capability. Extending a
published package is almost always correct; a near-duplicate package is the
most expensive mistake in an ecosystem.

```bash
pm package explore --project
pm package explore --global
pm contracts --runtime-only --availability-only
```

## Lifecycle Loop

```bash
pm package explore --project              # inspect state first
pm package manage --detail summary
pm package doctor --detail deep
pm package install <package> --project            # then mutate
pm contracts --command <extension-command> --flags-only
pm package doctor --detail deep           # verify after
```

Order matters: inspect, mutate, verify exposure, record evidence on the linked
pm item. Deactivation and uninstall are reversible only if you recorded what
they removed.

## Authoring

Author with `defineExtension` and declared capabilities. A capability the
manifest does not declare is not granted at activation, which is what keeps a
third-party extension from silently widening its own reach.

```bash
pm contracts --command package --flags-only
pm contracts --schema-only
```

Packages ship TypeScript entries and are loaded through native type stripping,
so there is no separate build step for a package's own sources. Installed npm
extensions are not tracked in the host repository; only the managed-extension
manifest is.

## Verification

```bash
pm package doctor --detail deep
pm contracts --runtime-only --availability-only
pm health --check-only
pm validate --check-resolution
```

An extension is correctly integrated when `pm contracts` reports its commands
and actions as available and `pm <command> --help --json` returns a complete
flag contract for each one.

## References

| Need                              | Load                                                | Cost     |
| --------------------------------- | ---------------------------------------------------- | -------- |
| Lifecycle recipes                  | [Extension lifecycle](references/LIFECYCLE.md)       | ~450 tok |
| Failure diagnosis playbook         | [Troubleshooting](references/TROUBLESHOOTING.md)     | ~300 tok |
| Authoring an extension end to end  | [Authoring](references/AUTHORING.md)                 | ~900 tok |
