# SDK

The supported programmatic surface is `@unbrained/pm-cli/sdk`.

Use this package for extension authoring, command/action contract discovery, and deterministic app or CI automation. Do not import private `src/core/...` modules from external integrations.

## Install

```bash
npm install @unbrained/pm-cli
```

## Core Exports

### Extension authoring

- `defineExtension`
- `EXTENSION_CAPABILITIES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_CAPABILITY_CONTRACT_VERSION`
- `EXTENSION_CAPABILITY_LEGACY_ALIASES`
- `EXTENSION_POLICY_MODES`
- `EXTENSION_POLICY_SURFACES`
- `EXTENSION_TRUST_MODES`
- `EXTENSION_SANDBOX_PROFILES`

### Command and action contracts

- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_PI_TOOL_PARAMETERS_SCHEMA`
- `PM_TOOL_ACTION_PARAMETER_CONTRACTS`

### Runtime contract constants

- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`
- `PM_EXTENSION_POLICY_MODE_CONTRACTS`
- `PM_EXTENSION_POLICY_SURFACE_CONTRACTS`
- `PM_EXTENSION_TRUST_MODE_CONTRACTS`
- `PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS`

### Type guards

- `isPmToolAction`
- `isPmExtensionCapabilityContract`
- `isPmExtensionServiceNameContract`
- `isPmExtensionPolicyModeContract`
- `isPmExtensionPolicySurfaceContract`

## Capability Mapping

- `commands` -> `registerCommand`
- `schema` -> `registerFlags`, `registerItemFields`, `registerItemTypes`, `registerMigration`
- `importers` -> `registerImporter`, `registerExporter`
- `search` -> `registerSearchProvider`, `registerVectorStoreAdapter`
- `hooks` -> `api.hooks.*`
- `parser` -> `registerParser`
- `preflight` -> `registerPreflight`
- `services` -> `registerService`
- `renderers` -> `registerRenderer`

## Extension Example

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "release audit",
      action: "release-audit",
      description: "Collect release-readiness diagnostics.",
      intent: "Produce deterministic gate payloads for CI.",
      flags: [{ long: "--strict", description: "Enable strict gate mode." }],
      run: async (context) => ({
        ok: true,
        command: context.command,
        strict: context.options.strict === true,
      }),
    });
  },
});
```

## Contracts-First Automation

Use runtime contracts for extension-aware schemas:

```bash
pm contracts --json
pm contracts --schema-only --json
pm contracts --command package --flags-only --json
pm contracts --action create --schema-only --json
```

Minimal script pattern:

```ts
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS, isPmToolAction } from "@unbrained/pm-cli/sdk";
import { spawnSync } from "node:child_process";

const action = "package-reload";
if (!isPmToolAction(action)) throw new Error("Unsupported action");
const contract = PM_TOOL_ACTION_PARAMETER_CONTRACTS[action];
console.log(contract.required, contract.optional);

const result = spawnSync("pm", ["contracts", "--json"], { encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
```

## Compatibility Metadata

`pm contracts --json` includes compatibility metadata for extension integrations:

- `extension_contracts.trust_modes`
- `extension_contracts.sandbox_profiles`
- `extension_contracts.manifest_versions`
- `extension_contracts.compatibility`
- `action_availability[].policy_state`

Current compatibility model:

- manifest current: `v2`
- supported previous: `v1`
- strategy: `versioned_breaking`

## Runnable Examples

- `docs/examples/sdk-contract-consumer/`
- `docs/examples/sdk-app-embedding/`
- `docs/examples/ci/`

## Related Docs

- `docs/EXTENSIONS.md`
- `docs/CLAUDE_CODE_PLUGIN.md`
# SDK

The supported programmatic surface is `@unbrained/pm-cli/sdk`.

Use this for:

- extension authoring (`defineExtension`)
- command/action schema discovery (`PM_TOOL_PARAMETERS_SCHEMA`)
- runtime action contracts (`PM_TOOL_ACTION_PARAMETER_CONTRACTS`)
- capability/policy/trust/sandbox contract constants

Do not import private `src/core/...` modules from external integrations.

## Install

```bash
npm install @unbrained/pm-cli
```

## Key Exports

### Extension Authoring

- `defineExtension`
- `EXTENSION_CAPABILITIES`
- `EXTENSION_POLICY_MODES`
- `EXTENSION_POLICY_SURFACES`
- `EXTENSION_TRUST_MODES`
- `EXTENSION_SANDBOX_PROFILES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_CAPABILITY_CONTRACT_VERSION`
- `EXTENSION_CAPABILITY_LEGACY_ALIASES`

### Command/Action Contracts

- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_PI_TOOL_PARAMETERS_SCHEMA`
- `PM_TOOL_ACTION_PARAMETER_CONTRACTS`

### Extension Runtime Contract Constants

- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`
- `PM_EXTENSION_POLICY_MODE_CONTRACTS`
- `PM_EXTENSION_POLICY_SURFACE_CONTRACTS`
- `PM_EXTENSION_TRUST_MODE_CONTRACTS`
- `PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS`

### Type Guards

- `isPmToolAction`
- `isPmExtensionCapabilityContract`
- `isPmExtensionServiceNameContract`
- `isPmExtensionPolicyModeContract`
- `isPmExtensionPolicySurfaceContract`

## Extension Example

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "release audit",
      action: "release-audit",
      description: "Collect release-readiness diagnostics.",
      intent: "Produce deterministic gate payloads for CI.",
      run: async (context) => ({
        ok: true,
        command: context.command,
      }),
    });
  },
});
```

## Contracts-First Automation Pattern

```ts
import { PM_TOOL_ACTION_PARAMETER_CONTRACTS, isPmToolAction } from "@unbrained/pm-cli/sdk";
import { spawnSync } from "node:child_process";

const action = "extension-reload";
if (!isPmToolAction(action)) throw new Error("Unsupported action");
const contract = PM_TOOL_ACTION_PARAMETER_CONTRACTS[action];
console.log(contract.required, contract.optional);

const contracts = spawnSync("pm", ["contracts", "--json"], { encoding: "utf8" });
if (contracts.status !== 0) throw new Error(contracts.stderr);
```

## Runtime Metadata Added For v2

`pm contracts --json` now includes richer extension metadata:

- `extension_contracts.trust_modes`
- `extension_contracts.sandbox_profiles`
- `extension_contracts.manifest_versions`
- `extension_contracts.compatibility`
- `action_availability[].policy_state` for extension-backed actions

Use these fields to gate CI and to route compatibility behavior in embedded runtimes.

## Versioned-Breaking Compatibility

Current contract compatibility model:

- `manifest` current: `v2`
- supported previous: `v1`
- strategy: `versioned_breaking`

Recommended migration flow:

1. read runtime contracts (`pm contracts --json`)
2. branch behavior by compatibility metadata
3. migrate manifests/policy to v2
4. enforce trust/sandbox policy gates in CI

## Runnable Examples

- contracts consumer: `docs/examples/sdk-contract-consumer/`
- app embedding runner: `docs/examples/sdk-app-embedding/`
- CI gates: `docs/examples/ci/`

## Related Docs

- `docs/EXTENSIONS.md`
- `docs/CLAUDE_CODE_PLUGIN.md`
# SDK

The stable integration surface is `@unbrained/pm-cli/sdk`. Use it for extension authoring, action/flag contract discovery, and deterministic app/CI automation.

## Install

```bash
npm install @unbrained/pm-cli
```

```ts
import {
  defineExtension,
  EXTENSION_CAPABILITIES,
  EXTENSION_POLICY_MODES,
  EXTENSION_POLICY_SURFACES,
  PM_TOOL_ACTIONS,
  PM_TOOL_PARAMETERS_SCHEMA,
  PM_TOOL_ACTION_PARAMETER_CONTRACTS,
  PM_EXTENSION_CAPABILITY_CONTRACTS,
  PM_EXTENSION_SERVICE_NAME_CONTRACTS,
  PM_EXTENSION_POLICY_MODE_CONTRACTS,
  PM_EXTENSION_POLICY_SURFACE_CONTRACTS,
  isPmToolAction,
  isPmExtensionCapabilityContract,
} from "@unbrained/pm-cli/sdk";
```

## What Is Exported

Core authoring exports:

- `defineExtension`
- `EXTENSION_CAPABILITIES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_POLICY_MODES`
- `EXTENSION_POLICY_SURFACES`

Command/action contract exports:

- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_PI_TOOL_PARAMETERS_SCHEMA`
- `PM_TOOL_ACTION_PARAMETER_CONTRACTS`

Extension runtime contract exports:

- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`
- `PM_EXTENSION_POLICY_MODE_CONTRACTS`
- `PM_EXTENSION_POLICY_SURFACE_CONTRACTS`

Type guards:

- `isPmToolAction(value)`
- `isPmExtensionCapabilityContract(value)`
- `isPmExtensionServiceNameContract(value)`
- `isPmExtensionPolicyModeContract(value)`
- `isPmExtensionPolicySurfaceContract(value)`

## Capability Mapping

- `commands` -> `registerCommand`
- `schema` -> `registerFlags`, `registerItemFields`, `registerItemTypes`, `registerMigration`
- `importers` -> `registerImporter`, `registerExporter`
- `search` -> `registerSearchProvider`, `registerVectorStoreAdapter`
- `hooks` -> `api.hooks.*`
- `parser` -> `registerParser`
- `preflight` -> `registerPreflight`
- `services` -> `registerService`
- `renderers` -> `registerRenderer`

## Extension Authoring Example

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "release audit",
      action: "release-audit",
      description: "Collect release readiness diagnostics.",
      intent: "provide deterministic audit payloads for CI gates",
      examples: ["pm release audit --strict"],
      failure_hints: ["Run pm package doctor --detail deep --trace on activation failures."],
      flags: [{ long: "--strict", description: "Enable strict gate mode." }],
      run: async (context) => ({
        ok: true,
        command: context.command,
        strict: context.options.strict === true,
      }),
    });
  },
});
```

## Programmatic Contracts (App/Script)

Use runtime `pm contracts` for extension-aware schemas:

```bash
pm contracts --json
pm contracts --schema-only --json
pm contracts --command package --flags-only --json
pm contracts --action create --schema-only --json
```

The result includes:

- `actions`: runtime-invocable action list
- `action_availability`: invocable/disabled reasons
- `schema`: strict action-scoped JSON schema
- `command_flags`: merged core + extension + runtime field flags
- `extension_contracts`: capabilities/services/policy mode/surface contract metadata

## Robust Script Pattern

See runnable example: `docs/examples/sdk-contract-consumer/inspect-contracts.mjs`.

Minimal pattern:

1. Read contracts JSON.
2. Validate action exists in `actions`.
3. Validate required fields with `PM_TOOL_ACTION_PARAMETER_CONTRACTS`.
4. Execute the action only after preflight passes.

## CI/CD Pattern

Recommended gate sequence:

```bash
pnpm build
pm contracts --schema-only --json > /tmp/pm-contracts.json
pm package doctor --project --detail summary --strict-exit
node scripts/run-tests.mjs test -- tests/unit/contracts-command.spec.ts
node scripts/run-tests.mjs coverage
```

Reference workflow file:

- `docs/examples/ci/github-actions-pm-extension-gate.yml`

## Pi / Tooling Compatibility

For provider-safe schemas, use `PM_PI_TOOL_PARAMETERS_SCHEMA`. It is flat, non-`oneOf`, and designed for tool providers that reject advanced schema constructs.

The bundled Pi wrapper (`.pi/extensions/pm-cli/index.js`) consumes this schema directly to reduce contract drift.

## Related Docs

- `docs/EXTENSIONS.md`
- `docs/examples/starter-extension/README.md`
- `docs/examples/sdk-contract-consumer/README.md`
# SDK

The public SDK is exported from `@unbrained/pm-cli/sdk`. Use it for extension authoring and command-contract introspection. Do not import internal `src/core/...` modules from extensions.

## Agent Quick Context

- Primary import: `@unbrained/pm-cli/sdk`.
- Runtime extension lifecycle is documented in [Extensions](EXTENSIONS.md).
- Exact command/action contracts are available through `pm contracts`.
- Local deep-dive routing is available through `pm guide sdk --depth deep`.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Import Surfaces

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Supported package exports:

- `@unbrained/pm-cli/sdk` - stable extension authoring API and CLI contract exports.
- `@unbrained/pm-cli/cli` - runtime CLI module entrypoint for package resolution, not a typed library API.

## Public Exports

Source of truth:

- [`src/sdk/index.ts`](../src/sdk/index.ts)
- [`src/sdk/cli-contracts.ts`](../src/sdk/cli-contracts.ts)

Common authoring exports:

- `defineExtension`
- `EXTENSION_CAPABILITIES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_CAPABILITY_CONTRACT_VERSION`
- `EXTENSION_CAPABILITY_LEGACY_ALIASES`
- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`

Common types:

- `ExtensionApi`
- `ExtensionManifest`
- `CommandDefinition`
- `FlagDefinition`
- `SchemaFieldDefinition`
- `SchemaItemTypeDefinition`
- `SearchProviderDefinition`
- `VectorStoreAdapterDefinition`
- `GlobalOptions`
- `PmSettings`

## Capability Requirements

| Registration | Manifest capability |
|--------------|---------------------|
| `registerCommand` | `commands` |
| inline command flags | `schema` |
| `registerFlags` | `schema` |
| `registerItemFields` | `schema` |
| `registerItemTypes` | `schema` |
| `registerMigration` | `schema` |
| `registerImporter` | `importers` |
| `registerExporter` | `importers` |
| `registerParser` | `parser` |
| `registerPreflight` | `preflight` |
| `registerService` | `services` |
| `registerRenderer` | `renderers` |
| lifecycle hooks | `hooks` |
| `registerSearchProvider` | `search` |
| `registerVectorStoreAdapter` | `search` |

## Minimal Command Extension

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "hello",
      description: "Return a deterministic hello payload.",
      intent: "verify SDK extension activation",
      examples: ["pm hello"],
      run: async () => ({ ok: true, message: "hello" }),
    });
  },
});
```

Manifest:

```json
{
  "name": "hello",
  "version": "0.1.0",
  "entry": "./index.js",
  "capabilities": ["commands"]
}
```

## Custom Item Type

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerItemTypes([
      {
        name: "Incident",
        folder: "incidents",
        aliases: ["incident"],
        required_create_fields: ["title", "description", "severity"],
        options: [
          { key: "severity", values: ["critical", "major", "minor"], required: true },
          { key: "service", values: ["api", "web", "worker"] },
        ],
      },
    ]);

    api.registerItemFields([
      { name: "severity", type: "string" },
      { name: "service", type: "string", optional: true },
    ]);
  },
});
```

Manifest capability: `schema`.

## Search Provider

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerSearchProvider({
      name: "example-search",
      async query(context) {
        return context.documents
          .filter((doc) => doc.metadata.title?.toLowerCase().includes(context.query.toLowerCase()))
          .map((doc) => ({ id: doc.metadata.id, score: 0.5, matched_fields: ["title"] }));
      },
    });
  },
});
```

Manifest capability: `search`.

## Command Contracts

For machine clients:

```bash
pm contracts --json
pm contracts --command create --flags-only --json
pm contracts --action create --schema-only --json
```

Use the runtime command because active extensions can add command/action metadata.

## CLI Simplification Migration

The conservative full-surface simplification pass updated invocation parsing and error envelopes. Integration details are documented in:

- [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md)

For SDK and automation consumers, the key runtime change is the optional `recovery` object in CLI usage/error JSON payloads:

- `attempted_command`
- `normalized_args`
- `provided_fields`
- `missing`
- `suggested_retry`

Treat `recovery.suggested_retry` as the first-choice deterministic replay command when present.

## Authoring Pattern

- Keep handlers deterministic and JSON-like.
- Return data, not pre-rendered terminal text, unless implementing a renderer.
- Keep service and preflight overrides narrow.
- Declare only capabilities in use.
- Include examples and failure hints in dynamic commands.
- Add `pm extension doctor` diagnostics to testing instructions.

## Related Docs

- [Extensions](EXTENSIONS.md)
- [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md)
- [Architecture](ARCHITECTURE.md)
- [starter extension](examples/starter-extension/README.md)
