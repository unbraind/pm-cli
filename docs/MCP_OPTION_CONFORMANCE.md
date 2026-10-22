# MCP Option Conformance

Tracked by [pm-v0s2rm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-v0s2rm.toon), [pm-gh1538](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1538.toon), and [pm-ap7ilf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ap7ilf.toon).
These repository-only tracking records are excluded from npm.

An integration test can pass while an undeclared option is ignored. That leaves
the test asserting a behavior it never exercised. The repository therefore
treats emitted MCP unknown-option diagnostics as test failures, while the
production server retains its advisory warning behavior for clients.

`pm_create` and `pm_update` accept the canonical mutation fields advertised by
their input schemas either at the top level or inside `options`. `pm_run` with
the corresponding action uses the same SDK normalization. Explicit nested
options take precedence, including CLI
aliases for the same field. Repeatable inputs, numeric values, and linked-resource
aliases use the shared mutation contracts before persistence. Native SDK `run`
callers continue to put update fields inside `options`.

Malformed option containers, values discarded from known scalar fields, and malformed repeatable
entries refuse before execution with `invalid_argument_value` and
`changed: false`. `force` must be a boolean. These checks preserve project-defined
custom fields and template-based type resolution while preventing a bad field
from disappearing as a sibling field is written.
Array values that become CLI CSV inputs, such as `tags`, must contain only
strings and are checked before conversion. Validation follows nested precedence:
an explicit valid nested value replaces a flat value before either is normalized.

For example, `{ "id": "pm-one", "options": {}, "priority": 4 }` changes priority;
with `"options": { "priority": 2 }`, priority becomes `2`. Create also honors its
advertised explicit `id`, `deadline`, and other metadata. Regressions check the
discovered schema, persisted values and verified history, and compare item and
history bytes after invalid mutations to prove atomic refusal.

Every run using [vitest.config.ts](../vitest.config.ts) installs
[McpContractReporter](../scripts/mcp-contract-reporter.mts). The reporter records
the emitting file, full test name, option, tool, and action, and rejects the run
after execution even when all assertions pass. Unattributed warnings also fail.
Diagnostics retain option names, never option values.

The sandboxed test runner also retains the reporter when command-line reporter
selection overrides the config, including CI coverage shards that emit blobs.

Intentional negative tests must have an exact entry in
`MCP_OPTION_WARNING_ALLOWLIST`, including a reason. A matching file or test alone
does not exempt other warning identities. The current exemption verifies that
mutation-shaped options cannot mutate a read tool. New integration behavior
should use declared parameters and assert the actual resulting state.

The [gate registry](../scripts/release/gate-registry.json) registers this check
as `mcp-option-contracts`. Its
[negative control](../tests/unit/scripts/mcp-contract-reporter.spec.ts) starts a
real Vitest child process whose assertion passes but whose undeclared-option
diagnostic must produce exit status 1. Run the gate and its integration consumers
with the sandboxed repository runner:

```bash
node scripts/run-tests.mjs test -- tests/unit/scripts/mcp-contract-reporter.spec.ts tests/integration/mcp-dynamic-package-actions.spec.ts tests/unit/mcp/mcp-server-nested-options.spec.ts
```

Published MCP acceptance also isolates project and global configuration, tracked
by [pm-prmt1y](../.agents/pm/issues/pm-prmt1y.toon). The npm, npx, and bunx checks
use temporary tracker roots for both stdio and HTTP servers. This prevents a
caller's installed skills from changing discovery pagination and hiding the
bundled skills being verified. Protocol and skill-content assertions remain
mandatory; acceptance processes disable production telemetry and Sentry.
