# Extension Author Contracts

Tracker: pm-at83

This page records runtime contracts package authors need when they build on the public SDK. For the install, manifest, lifecycle, and troubleshooting overview, see [Packages and Extensions](EXTENSIONS.md).

## Flag Spelling and Output Assertions

Tracked by [pm-gh1461](../.agents/pm/issues/pm-gh1461.toon) and
[pm-gh1462](../.agents/pm/features/pm-gh1462.toon).
Value grammar corrections are tracked by [pm-gh1466](../.agents/pm/issues/pm-gh1466.toon)
and [pm-gh1467](../.agents/pm/issues/pm-gh1467.toon).
Prefer `{ long: "--repo", value_name: "project", value_type: "string" }`.
Legacy `--repo <project>`, `--repo=<project>` and `--label [name]` declarations
retain one canonical identity, one value placeholder and one help listing.
Optional brackets permit presence without a value. Explicit `value_name` wins
over the inline label. Canonical `boolean` flags are switches, including when an
inline label is present. Legacy `bool` declarations retain their value grammar:
`--enabled false`, `--enabled 0`, and their short forms consume and coerce the
value. A bare legacy `bool` permits presence without a value, preserving the
published switch form too. An explicit `--enabled <value>` still requires its
operand; `--enabled [value]` permits omission. A canonical
boolean switch leaves subsequent positional values intact. Existing equals and
negated forms remain supported; loose negated flags remain in `context.args`.
Use `--` to distinguish a positional operand immediately after an optional-valued
legacy `bool`, for example `--enabled -- operand`.
The SDK's explicit `value_arity` distinguishes `none`, `required`, and `optional`
from the scalar `value_type`. `required` describes flag presence: an optional
value remains optional even when the flag itself is required. Help, Commander,
recovery and machine contracts consume the shared SDK value declaration.
Explicit legacy `value_name` metadata remains discoverable on switches for
compatibility; `value_arity: "none"` still means that no value token is consumed.
Typed authors should use canonical `value_type` names (`boolean`, `number`, `string`).

Use `decodeToon` from `@unbrained/pm-cli/sdk/testing` to assert on host output
semantically; `encodeToon` and the native codec option types are available from
that subpath and `/sdk`. They use the host's pinned implementation, so a package
does not need a separate TOON dependency or a private `dist/` import.

## Telemetry Capture Level

Every `pm` command records a telemetry event. Extension commands use the same telemetry pipeline as core commands and inherit `telemetry.capture_level` from the active settings.

Allowed values:

| Value | Meaning |
|-------|---------|
| `redacted` | Default. Records sanitized command args, options, result summary, and runtime environment. |
| `minimal` | Records structural metadata and one-way digests only. No readable command text, args, options, result summary, or runtime environment is kept. |
| `max` | Same as `redacted`, but raises the per-string truncation cap from 512 to 2048 characters. Redaction still applies. |

All levels redact inline secrets, bearer tokens, private paths, emails, private IPv4 addresses, and object keys whose names look sensitive. `minimal` additionally digests arg and option values with HMAC-SHA-256 so extension authors cannot reconstruct user input.

Inspect and change the level:

```bash
pm health --json | jq '.details.capture_level'
pm config set telemetry.capture_level minimal
pm config set telemetry.capture_level redacted
pm config set telemetry.capture_level max
```

The setting lives in the global pm settings file (`~/.pm-cli/settings.json` by default), not in the project tracker.

## Item Write Paths

`pm` has two item write paths. Hook, service, and migration authors should treat them as different contracts.

Create path:

- Used by `pm create` and importer-created items.
- Acquires the item lock, writes the item file atomically, appends the create history entry, fires `onWrite` for the item file and history stream, records the after-command affected-item snapshot, then releases the lock.
- Does not fire `onRead`, because there is no existing item.
- Does not call the `item_store_write` service override. Use `onWrite` with `op="create"` if a package needs to observe new items.

`mutateItem` path:

- Used by `pm update`, `pm close`, `pm claim`, `pm release`, `pm restore`, `pm delete`, and other mutations of existing items.
- Locates the item, acquires the lock, reads the item through the `onRead` hook, enforces ownership and history policy, applies the mutation, consults `item_store_write`, writes the item atomically, appends history, fires `onWrite` for the item and history stream, records the after-command affected-item snapshot, then releases the lock.
- `item_store_write` handlers can redirect the target path, replace serialized contents, or skip the physical item write.

Both paths guarantee:

- Atomic item writes.
- Lock coverage across item write and history append.
- History append after the item write, with rollback if history append fails.
- `onWrite` hooks only after item and history commits.
- Non-fatal hook failures reported as `extension_hook_failed:<layer>:<name>:onWrite`.

`changed_fields` sentinel values:

| Value | Meaning |
|-------|---------|
| `["imported"]` | Item came from an importer. |
| `["restored"]` | Item was restored from a previous state. |
| `["deleted"]` | Item was deleted. |

Surface matrix:

| Surface | Create path | `mutateItem` path |
|---------|-------------|-------------------|
| `onRead` hook | No | Yes |
| `item_store_write` service override | No | Yes |
| `history_append` service override | Yes | Yes |
| `onWrite` item hook | Yes, `op="create"` | Yes, `op=<mutation op>` |
| `onWrite` history hook | Yes, `op="create:history"` | Yes, `op="<mutation op>:history"` |
