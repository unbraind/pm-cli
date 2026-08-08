# SDK Runtime Boundaries

Tracker: [pm-1eted6](../.agents/pm/issues/pm-1eted6.toon),
[pm-3lhth4](../.agents/pm/issues/pm-3lhth4.toon), and
[pm-0xmajx](../.agents/pm/issues/pm-0xmajx.toon).

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
existing catch boundary. Non-errno failures are returned unchanged and must
not be relabeled as environment faults.

Existing SDK surfaces can supply category-specific `codes` to preserve their
published error vocabulary while still sharing classification, path redaction,
and recovery guidance. Workspace snapshots use this compatibility path for
their stable storage, resource, and permission fault codes.

## CLI refusal ownership

CLI adapters preserve SDK error codes, exit semantics, and actionable recovery
guidance when presenting refusals as human-readable or structured output.
Host-only validation remains at the transport boundary, while rules shared by
packages and commands live in public SDK primitives so callers receive the
same refusal contract regardless of entrypoint.
