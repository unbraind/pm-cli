# pm CLI Codex Plugin

This plugin packages pm-cli for Codex with:

- a native stdio MCP server (`pm-mcp`) backed by pm command modules, not shell `pm` invocations
- five portable skills for orientation, implementation, planning, review, and release
- command prompts for common planning and verification loops
- repo marketplace metadata for one-step local installation in Codex

The root `plugin.json` and typed `mcp.json` are the portable package entrypoints.
The `.codex-plugin/plugin.json` and `.mcp.json` files support existing hosts.
Both MCP configurations start the same pinned launcher. The five shared skills are generated with the Claude package from
`templates/agent-skills/`. The older `pm-native` and `pm-auditor` entrypoints
are generated compatibility skills that route to `pm-workflow`, `pm-planner`,
and `pm-audit`. `node scripts/gen-agent-plugin-skills.mjs --check` guards all
published copies against drift.

## Install

From this repository:

```bash
codex plugin marketplace add .
```

Restart Codex, then install **pm CLI** from the repo marketplace. The bundled MCP server starts through `plugins/pm-codex/scripts/pm-mcp-server.mjs`.

The launcher uses the local repo build when present. In a copied plugin cache it installs the exact `@unbrained/pm-cli` version declared in this plugin's `package.json` into the plugin data directory, then starts that server directly with Node. The runtime is reused offline after the first installation. If the pinned version is unavailable, startup fails with an install error instead of silently running a different release.

## Native Tools

Prefer the narrow tools when they match the task: `pm_context`, `pm_search`, `pm_list`, `pm_get`, `pm_create`, `pm_copy`, `pm_focus`, `pm_update`, `pm_append`, `pm_claim`, `pm_release`, `pm_close`, `pm_comments`, `pm_files`, `pm_docs`, `pm_notes`, `pm_learnings`, `pm_deps`, `pm_test`, `pm_validate`, `pm_health`, `pm_contracts`, `pm_schema`, `pm_config`, and `pm_plan`.


`pm_plan` exposes Codex-style ExecPlans as a first-class `Plan` item type with ordered steps, evidence, decisions, discoveries, validation, and materialization. See the `pm-planner` skill for the planning workflow.
For `init` automation, pass `options.agentGuidance` (`ask|add|skip|status`) when you need deterministic AGENTS/CLAUDE guidance behavior in non-interactive runs.

## Safety

Do not pass `path` for real repository tracking. For tests, pass a sandbox `cwd` or `path`, and keep `PM_GLOBAL_PATH` isolated when running commands that execute linked tests.
