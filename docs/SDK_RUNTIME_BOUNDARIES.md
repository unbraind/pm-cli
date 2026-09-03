# SDK Runtime Boundaries

Tracker: [pm-1eted6](../.agents/pm/issues/pm-1eted6.toon),
[pm-3lhth4](../.agents/pm/issues/pm-3lhth4.toon), and
[pm-0xmajx](../.agents/pm/issues/pm-0xmajx.toon), with forward history-epoch
protection tracked by
[pm-aka8m7](../.agents/pm/issues/pm-aka8m7.toon). Refusal reachability and
recovery completeness are tracked by
[pm-elmpav](../.agents/pm/features/pm-elmpav.toon),
[pm-185870](../.agents/pm/issues/pm-185870.toon), and
[pm-yqe0mo](../.agents/pm/issues/pm-yqe0mo.toon).

These SDK primitives keep host and project-runtime policy consistent across the
bundled CLI, packages, and automation without requiring consumers to reproduce
private CLI parsing rules.

## Project runtime compatibility

Packages and automation can call `inspectProjectRuntimeCompatibility` before a
mutation, or `assertProjectRuntimeCompatibility` when refusal semantics are
preferred. The SDK discovers the strongest project-local pm version pin from
the package manifest, installed package metadata, and supported lockfiles. A
CLI older than that pin refuses mutation with
`project_runtime_stale_mutation`; read commands stay available so an agent can
recover context before upgrading. Stale reads, including `context` and
read-only `health` invocations, emit the non-blocking
`project_runtime_stale_read` warning. JSON modes write a single structured
warning object to stderr, leaving the command's normal stdout envelope valid;
human modes identify both versions, the redaction-safe pin source, and a
package-manager-neutral recovery action. SDK callers receive the same warning
inside `ProjectRuntimeCompatibilityResult`. `PM_ALLOW_STALE_CLI=1` is the
explicit, auditable emergency override.

The boundary is bidirectional for history storage. A current runtime also
refuses a mutation when any package declaration or lockfile pin cannot select a
runtime that reads the writer epoch. Every manifest section is evaluated, so a
newer permissive declaration cannot hide an older exact pin. Upper-bounded
ranges that exclude the first compatible reader also fail closed, including
inclusive hyphen ranges. Disjunctive ranges evaluate each alternative, so one
branch that can select a compatible reader keeps the declaration writable. The
original incompatible declaration is preserved in the diagnostic rather than
being reduced to its representative lower bound. The typed
`project_runtime_history_epoch_incompatible` error reports the writer epoch,
the incompatible declaration, its redaction-safe source, and the minimum
upgrade. Reads remain available, and the same emergency override is reserved
for an intentionally coordinated fleet migration.

The public `isProjectMutatingInvocation` classifier applies the same decision
to package hosts and the bundled CLI. It resolves mixed command families by
their effective action: configuration, merge, schema, profile, package,
telemetry, workspace snapshot, template, VCS, validation, health, test, linked
artifact, and changelog reads remain available while their write forms are
fenced. Help, checks, previews, and dry runs remain reads, so compatibility
enforcement does not turn diagnostics into writes.

## Host-environment fault boundary

Use `withHostEnvironmentBoundary` around filesystem and resource operations
that cross into the host. It translates recognized Node errno failures into
the stable, path-redacted `host_environment_capacity_fault`,
`host_environment_permission_fault`, or `host_environment_resource_fault`
contracts. `classifyHostEnvironmentFault` supports diagnostics that need a
non-throwing classification, while `translateHostEnvironmentFault` supports an
existing catch boundary. The classifier accepts both symbolic Node `code`
values and declared numeric `errno` values from `node:os.constants.errno`; this
also recognizes platform errors that Node renders only as a number, such as a
Linux `-122` quota failure. Non-errno failures are returned unchanged and must
not be relabeled as environment faults.

Linked-test tracker seeding uses this boundary. A required sandbox copy that
exceeds temporary-filesystem capacity fails with a stable recovery contract,
while linked tests whose effective context is schema avoid materializing
tracker data at all.

Existing SDK surfaces can supply category-specific `codes` to preserve their
published error vocabulary while still sharing classification, path redaction,
and recovery guidance. Workspace snapshots use this compatibility path for
their stable storage, resource, and permission fault codes.

Package archives use one bounded validation and extraction boundary whether
they come from a local path or `npm pack`. The SDK rejects links, escaping
paths, unsupported entry types, oversized archives, and decompression growth
before extraction. If npm reports an archive it did not create, callers receive
the path-redacted `npm_package_archive_missing` refusal instead of a raw system
`tar` exception; an archive reported outside the isolated pack destination is
rejected as `npm_package_archive_unsafe`. This keeps package install behavior
portable and prevents an untrusted registry artifact or package-manager result
from bypassing the local-archive policy.

## CLI refusal ownership

CLI adapters preserve SDK error codes, exit semantics, and actionable recovery
guidance when presenting refusals as human-readable or structured output.
Host-only validation remains at the transport boundary, while rules shared by
packages and commands live in public SDK primitives so callers receive the
same refusal contract regardless of entrypoint.

`createUnknownSubcommandError` is the shared constructor for positional command
families. It emits `unknown_subcommand` with the stable
`unknown_positional_token` reason, a complete sorted `allowed_values` set, the
attempted command, and a nearest copy-pasteable retry when edit distance gives
an unambiguous candidate. CLI, direct SDK dispatch, MCP, and package hosts use
the same primitive. The CLI also recognizes split schema actions such as
`schema add type Name` and recommends the declared `schema add-type Name`
form instead of collapsing the failure into a generic arity error.
Core graph, config, plan, schema, profile, merge, telemetry, workspace, and
package/extension lifecycle dispatchers use this contract. The bundled
templates package demonstrates the same primitive for package-registered
families; custom packages can import it from the public SDK instead of
inventing a private refusal envelope. The former `unknown_lifecycle_action`
catalog name remains a compatibility alias of `unknown_subcommand`.

`PmErrorCodeContract.owned_states` declares concrete refusal states, their
probe ids, reachable entrypoints, and expected exit classes. The generated
catalog joins those declarations to the discovered error-code inventory.
Package and test harnesses can pass real-entrypoint observations to
`verifyPmRefusalReachability`; missing probes, wrong codes, wrong exit classes,
and undeclared observations fail closed. This makes an error code's existence
and its runtime reachability independently testable.

Unknown-option recovery separates human and machine budgets. Human guidance
shows the first three ranked command paths plus an explicit remainder count.
The structured envelope returns up to twelve ranked paths alongside
`candidate_commands_total` and `candidate_commands_truncated`, ordered by
shared option vocabulary and then command path. Consumers must inspect another
command contract before changing operations; candidate discovery is not an
instruction to run a different command.
