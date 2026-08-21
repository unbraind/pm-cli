# Agent UX Contracts

Tracker references: [pm-v1yo](../.agents/pm/issues/pm-v1yo.toon), [pm-i6pi](../.agents/pm/issues/pm-i6pi.toon), [pm-um4g](../.agents/pm/issues/pm-um4g.toon), [pm-tmhs](../.agents/pm/issues/pm-tmhs.toon), [pm-6m1i](../.agents/pm/issues/pm-6m1i.toon), [pm-cj9v](../.agents/pm/issues/pm-cj9v.toon), [pm-yp56](../.agents/pm/issues/pm-yp56.toon), [pm-gos426](../.agents/pm/issues/pm-gos426.toon), [pm-flnefm](../.agents/pm/issues/pm-flnefm.toon), [pm-rggtvd](../.agents/pm/issues/pm-rggtvd.toon), and [pm-vk7zek](../.agents/pm/issues/pm-vk7zek.toon).

These contracts keep common agent loops deterministic, token-efficient, and recoverable. Runtime contracts and `--help --json` remain the exact source for available flags.

## Relationship mutations

`pm create`, `pm update`, and `pm update-many` preserve existing relationship data, including legacy cycles. When a mutation introduces a new cycle through an ordering relationship such as `blocked_by`, the result includes an `ordering_cycle_created:` warning with a concrete cycle path and a `pm graph audit` recovery pointer.

The public SDK exports `collectNewOrderingCycleWarnings(beforeItems, afterItems, changedItemId)` from `@unbrained/pm-cli/sdk`. Package authors can apply the same immutable-snapshot advisory to custom mutation workflows; activated custom relationship kinds participate through the shared registry.

Dependency removal is lossless. `--dep-remove` rejects the same malformed
shorthand as `--dep`, and a selector that matches nothing returns the typed
`dependency_remove_no_match` refusal instead of a successful no-op. Exact
rows can be retired by selecting `id`, `kind`, `source_kind`, `author`, and
`created_at`; omitted coordinates intentionally broaden the match. Exact
duplicate rows can still be normalized without delete-then-add risk by
re-adding the same identity; the mutation keeps one canonical row and never
removes the logical edge.

Hierarchy mutations are stricter than ordering advisories. `pm create` and
`pm update` refuse a new cycle, registry cardinality breach, or contradictory
scalar/dependency parent before writing. The structured refusal names the
changed holder plus the cycle members or competing parents. Existing legacy
debt remains mutable only toward a cleaner state, so repair does not require a
global bypass. Read paths canonicalize every registry-declared hierarchy kind;
an item cannot disappear from `pm list --parent` or `pm get --tree` merely
because an integration used a dependency row instead of the scalar field.

`pm graph audit` uses two explicit units:

- `finding_count`, `findings_by_severity`, and `findings_by_code` count finding rows.
- `affected_subjects_by_severity` and `affected_subjects_by_code` count the items or edges represented by those findings.

Compatibility note: before the 2026.7.19 release, `findings_by_code` incorrectly accumulated affected-subject counts while `findings_by_severity` counted finding rows. SDK and JSON consumers that depended on that old unit must migrate to `affected_subjects_by_code`; consumers comparing code and severity finding counts should keep using `findings_by_code`.

## Extension command ownership

Extension handler aliases may create their own command groups, but they may not replace a core command or graft a handler beneath a core-owned command prefix. Collisions preserve the core command and emit `extension_command_collision:` with the core and extension owners. Package authors should rename or namespace the alias.

## Context and work selection

When an agenda event belongs to an item already emitted in `high_level`, `low_level`, or `blocked_fallback`, `pm context` emits a compact event containing `reference_only: true`, the item ID, time, kind, and event-specific data. Unlisted agenda items retain the full calendar projection.

`pm next --assignee <identity>` ranks from that assignee's perspective unless `--caller-author` explicitly overrides it. This makes delegated work selection useful without temporarily changing `PM_AUTHOR`.

Claim conflicts distinguish stored assignment from an explicit claim:

- `assigned to <identity>` means assignment metadata owns the current value.
- `claimed by <identity>` means the latest ownership mutation was `pm claim`.

The structured conflict code remains `already_claimed_by` for compatibility with atomic claim retry loops.

## Input and tracker recovery

`--message` labels mutation history; it is never comment content. A comment invocation that supplies `--message` without positional text, `--add`, `--stdin`, or `--file` exits with a usage error instead of silently listing comments.

Implicit tracker discovery covers the default `.agents/pm` layout and ancestor root-layout trackers. If the command misses those layouts but detects a directly nested custom tracker, recovery guidance names the existing root and shows both `--pm-path <root>` and `PM_PATH=<root>` forms. Initialize a new tracker only when no intended existing root is available.
