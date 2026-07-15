# SDK Customization Primitives

Tracked by [pm-3mna](../.agents/pm/features/pm-3mna.toon),
[pm-cpja](../.agents/pm/features/pm-cpja.toon), and
[pm-9x6e](../.agents/pm/tasks/pm-9x6e.toon).

The SDK owns the configuration, project-profile, initialization, and agent-guidance engines used by the CLI. Package authors and embedded hosts can therefore compose those command families without spawning `pm` or importing their presentation adapters. Initialization still delegates optional bundled-package installation to the extension subsystem, so `runInit({ withPackages: true })` preserves the CLI's package lifecycle rather than duplicating it.

## Public primitives

```ts
import {
  applyInvocationAuthorOverride,
  createPmCliProgram,
  runConfig,
  runInit,
  runInitAgentGuidance,
  runProfileApply,
  runProfileLint,
  runProfileList,
  runProfileShow,
  scanHistoryAuthorAttribution,
} from "@unbrained/pm-cli/sdk";
```

The barrel also exports the corresponding option and result contracts, including `ConfigCommandOptions`, `ConfigResult`, `InitCommandOptions`, `InitResult`, `InitAgentGuidanceSummary`, `ProfileApplyCommandOptions`, and each profile result variant. The legacy `src/cli/commands/*` paths are compatibility re-exports; new integrations should use the SDK entrypoint.

`createPmCliProgram(version)` creates a fresh Commander root with pm's universal global contract. It is suitable for embedded hosts that need the standard output, path, extension, profiling, and author flags before registering custom command families.

## Invocation-wide author attribution

Every command accepts a root-level author override:

```bash
pm --author release-agent create --title "Prepare release" --type Task
pm update <id> --author review-agent --message "Address review feedback"
```

The override applies to every mutation performed during that invocation, including nested SDK-backed operations and extension hooks. Embedded hosts can use `applyInvocationAuthorOverride(author)` and call the returned idempotent restore function in `finally`; this prevents one request's identity from leaking into the next request in a long-lived process.

Author precedence is:

1. explicit command or invocation `--author`;
2. `PM_AUTHOR`;
3. project `author_default`;
4. command-specific safe fallback.

New trackers persist a non-empty `author_default`. `pm init --author <id>` and `PM_AUTHOR` take precedence; otherwise init derives a stable local `username@hostname` identity. Existing projects can configure the value without editing storage:

```bash
pm config project set author_default stable-agent-id
```

`scanHistoryAuthorAttribution(pmRoot)` reports missing or literal `unknown` authors in readable JSONL history streams with bounded samples. `pm health` and `pm validate` surface the same condition as an advisory warning. They never rewrite append-only history; remediation configures attribution for future mutations.

## Custom initialization and profiles

```ts
import { runInit, runProfileApply } from "@unbrained/pm-cli/sdk";

await runInit(
  undefined,
  { path: pmRoot },
  {
    defaults: true,
    author: "bootstrap-agent",
    typePreset: "ops",
    agentGuidance: "add",
  },
);

await runProfileApply("ops", { author: "profile-agent" }, { path: pmRoot });
```

These calls use the same schema scaffolding, settings validation, locks, hooks, templates, workspace cache policy, and deterministic result envelopes as their CLI equivalents. `runConfig` likewise exposes typed project/global get, set, list, and export behavior, while the profile read primitives let custom tools inspect catalog composition and lint extension-contributed profiles before applying them.

## Import-boundary guarantee

The CLI modules for config, init, init-agent-guidance, and profile contain compatibility exports only. The static quality gate removes their former private-core import allowances from the committed boundary baseline, so future presentation-layer logic cannot silently grow back into those command paths.
