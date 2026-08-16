# Context Integrity Contracts

Tracker references: [pm-4fwgaz](../.agents/pm/issues/pm-4fwgaz.toon), [pm-qqoumq](../.agents/pm/issues/pm-qqoumq.toon), [pm-fpdk37](../.agents/pm/issues/pm-fpdk37.toon), [pm-jn1x30](../.agents/pm/issues/pm-jn1x30.toon), and [pm-0wfdim](../.agents/pm/issues/pm-0wfdim.toon).

## Agent Quick Context

Project management is context management. A successful read or analysis must not silently erase an item's identity, reinterpret a reference, reverse a relationship, accept an ignored compatibility spelling, or rewrite history into a format an older supported CLI cannot read. These rules are implemented in shared SDK/core primitives so the CLI, packages, extensions, and MCP hosts inherit the same behavior.

## Sparse Read Identity

`pm get <id> --fields ...` always returns `item.id`, even when `id` was not explicitly requested. Explicitly requested collection metadata is materialized as an empty array when absent. This distinguishes “the requested collection is empty” from “the field was not read” without forcing callers to request a larger projection.

```bash
pm get pm-example --fields comments,notes,learnings,tests,docs --json
```

The result retains the canonical ID and the five requested empty groups. Unrequested groups remain omitted, preserving the token-saving projection contract.

## Extension Manifest Compatibility

Extension manifests use the canonical top-level `pm_min_version` and optional `pm_max_version` fields. `compatibility.pm`, `engines.pm`, or other alternate spellings do not establish the loader's pm version floor.

`checkExtensionManifestCompatibility` now performs a closed top-level schema inspection before evaluating bounds. It reports deterministic advisory findings for unknown keys and, when an ignored spelling leaves both canonical bounds absent, a second migration finding. A recognized `compatibility` spelling includes `suggested_key: "pm_min_version"`. Runtime discovery emits matching `extension_manifest_*` warnings, which means `pm extension doctor` cannot silently report a clean manifest after discarding an unknown compatibility block.

Warnings are advisory; malformed or unmet canonical bounds retain their existing blocking behavior.

## Lossless Remote Documentation Links

`pm docs <id> --add` accepts structured `path=...,scope=...,note=...` values, bare paths, Markdown links, and CSV label/URL pairs:

```bash
pm docs pm-example --add '[Pull request](https://github.com/org/repo/pull/42)'
pm docs pm-example --add 'Issue report,https://github.com/org/repo/issues/17'
```

Both examples create one project-scoped documentation reference. The URL is preserved byte-for-byte as the path and the label becomes the note. File-link parsing is unchanged, and ordinary comma-separated bare document paths continue to expand as before.

## Direction-Locked Graph Impact

Dependency storage is oriented from the item that declares a relationship (`source`) to the referenced item (`target`). Impact analysis uses that stored orientation even for associative kinds:

- `incoming` follows source items that point at the current target: dependents and requesters.
- `outgoing` follows targets referenced by the current source: prerequisites and context dependencies.
- `both` is the deterministic union of the complete incoming and outgoing traversals. Each branch keeps its starting direction; traversal never reverses through an associative edge halfway through a path.

This prevents a shared `related` item from bridging an incoming impact query into an unrelated epic. Rows retain shortest explanation paths, bounded pagination, truncation, and query-cost receipts.

## Cross-Version History Epochs

History writers using item-hash epoch 2 always emit `item_hash_version: 2`. An entry without an explicit epoch is therefore legacy epoch 1, including documents whose hashes happen to be identical under both algorithms. Verification and repair no longer guess the newest epoch for an ambiguous implicit stream.

Repair keeps implicit legacy streams implicit and byte-stable when no drift exists. Unsupported explicit epochs still fail with a typed `unsupported_item_hash_version` diagnostic instead of being rewritten.

## Verification Boundary

The regression suite covers each contract at its public SDK or command boundary. Release verification additionally installs the packed package into a temporary project and exercises sparse reads, remote docs, graph impact, extension diagnostics, and history repair without touching the repository tracker.
