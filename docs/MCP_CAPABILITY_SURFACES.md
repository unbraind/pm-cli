# Runtime capability surfaces

Tracker: [pm-xwah](../.agents/pm/chores/pm-xwah.toon), [pm-kxci8x](../.agents/pm/tasks/pm-kxci8x.toon), [pm-mu8m](../.agents/pm/tasks/pm-mu8m.toon), [pm-9k90](../.agents/pm/features/pm-9k90.toon), [pm-m4ikkz](../.agents/pm/features/pm-m4ikkz.toon), [pm-yf07b7](../.agents/pm/features/pm-yf07b7.toon)

The SDK exports one agent capability contract for command visibility, MCP tool profiles, resources, and workflow prompts. CLI-facing generators and MCP hosts should project from these contracts instead of maintaining independent allowlists.

## MCP profiles

Set `PM_MCP_PROFILE` for the `pm-mcp` process:

- `core` is the default, token-bounded surface for orientation and the common item lifecycle.
- `standard` adds project configuration, relationships, evidence, and health workflows.
- `full` exposes every built-in narrow tool plus the generic package action tool.
- `custom` exposes exactly the comma-separated tool names in `PM_MCP_TOOLS`. Unknown or empty allowlists fail with exit code 64.

An activated extension command makes `pm_run` discoverable outside a custom profile. Its action is added to the live `pm_run` action enumeration. Custom profiles remain exact allowlists.

Package authors can declare `tier: "core" | "standard" | "full" | "internal"` on `registerCommand()` definitions. The default is `standard`; `internal` commands remain callable by native dispatch but are not advertised by normal MCP profiles.

## Workspace schema projection

`getWorkspaceContracts()` reports configured types, statuses, runtime fields, and activated extension commands. MCP `tools/list` uses those live contracts to:

- constrain type and status enums;
- advertise declared custom fields on the create and update tools;
- move provided custom-field values into the runtime option bag before dispatch; and
- advertise activated extension actions through `pm_run`.

Unexpected inputs are warnings, but the warning explicitly says an undeclared value may be ignored. It never claims an input was honored without runtime evidence.

## Resources and prompts

The MCP server advertises bounded resources for project context, active focus, active claims, and repository-local agent guidance. It also provides canonical prompts for orientation, claim/start, and evidence/close workflows. Tool-only clients continue to work unchanged.

The generated command-tier table lives at [generated/AGENT_COMMAND_SURFACE.md](generated/AGENT_COMMAND_SURFACE.md). Run `pnpm contracts:agent-surfaces:check` to reject drift.
