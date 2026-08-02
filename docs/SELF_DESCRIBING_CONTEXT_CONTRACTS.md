# Self-Describing Context Contracts

Tracker references: [pm-cxr0jb](../.agents/pm/features/pm-cxr0jb.toon), [pm-11phn1](../.agents/pm/issues/pm-11phn1.toon), [pm-kxci8x](../.agents/pm/tasks/pm-kxci8x.toon), [pm-6j7r1a](../.agents/pm/issues/pm-6j7r1a.toon), and [pm-x4nn3z](../.agents/pm/features/pm-x4nn3z.toon).

## Agent Quick Context

`pm` treats project management as context management. Its CLI, SDK, MCP, and package surfaces therefore publish the same answers to four questions:

1. Which command or alias is invocable?
2. How is each flag supplied?
3. Which bounded context projection fits the caller's intent?
4. Which stable error code and recovery path can be returned?

Use `pm contracts --summary --json` for the bounded bootstrap and `pm contracts --full --json` for the complete context-intent, error-code, runtime, and MCP catalogs.

## Intent-Scoped Reads

The read primitives accept `--for <intent>`:

| Command                 | Built-in intent     | Purpose                                          |
| ----------------------- | ------------------- | ------------------------------------------------ |
| `context`               | `orient`, `handoff` | Active hierarchy or continuation context         |
| `get`                   | `inspect`           | Complete item lifecycle and relationship context |
| `list` and list aliases | `triage`            | Compact governance and ownership fields          |
| `next`                  | `execute`           | One actionable recommendation                    |
| `search`                | `discover`          | Ranked canonical-lineage candidates              |

Explicit projection and token flags win over intent defaults:

```bash
pm context --for orient --section hierarchy --token-budget 900
pm next --for execute --ready-only --json
pm search "output projection" --for discover --json
```

Active package modules declare intents by exporting `contextIntents` (or `context_intents`) as an array of contracts; the runtime collects and composes them automatically for each request. Workspaces may declare an array, or `{ "intents": [...] }`, in `.agents/pm/context-intents.json`. Package declarations extend the built-ins; workspace declarations have final precedence and can intentionally override a matching command/intent pair. Invalid or duplicate declarations fail closed. Unknown CLI intent names return nearest-name guidance.

```ts
export const contextIntents = [
  {
    command: "search",
    intent: "security-triage",
    description: "Find likely security lineage with a bounded evidence set.",
    included_field_groups: ["identity", "status", "relevance", "evidence"],
    token_budget: 900,
  },
];
```

Discovery is request-scoped for concurrent SDK clients: built-ins, active packages, and the selected workspace cannot leak declarations into another request. See [Universal Read Output Contracts](READ_OUTPUT_CONTRACTS.md) for the four output dimensions shared by every read surface.

## Flag Invocation Metadata

A command-scoped `command_flags` row retains the stable vocabulary in `flags` and adds `flag_invocations`. The unscoped and `--full` projections omit this repeated semantic payload; select a command to retrieve its invocation metadata within the context budget. Each invocation row declares:

- description and aliases;
- whether it consumes and requires a value;
- value name and type;
- option requiredness and repeatability;
- accepted input channels (`argv`, `stdin`, or `file`);
- the `-` stdin sentinel where supported.

For example, `--description -` reads multiline text from stdin for `create` and `update`; `--body-file` declares file input; and `--stdin-json` declares stdin-only input.

## Visibility and Enumeration

Every command surface carries one tier: `core`, `standard`, `full`, or `internal`. The same declaration drives SDK/MCP profiles and generated agent docs. Contract enumeration includes accepted aliases rather than silently compacting them, and each row reports its canonical command.

The default summary stays bounded. Larger intent and error catalogs are emitted only by `--full`.

## Error Vocabulary

`PM_ERROR_CODE_CATALOG` is generated from executable structured error declarations. Each row includes:

- the stable snake-case code;
- meaning and stability;
- CLI exit code;
- recovery guidance;
- source modules that emit the code.

Run the drift gate after adding or removing a structured error:

```bash
pnpm contracts:errors:update
pnpm contracts:errors:check
```

Package consumers can import the primitive catalog and validators from `@unbrained/pm-cli/sdk/contracts` without loading the CLI runtime.
