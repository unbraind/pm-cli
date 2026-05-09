# pm CLI Codex Plugin

This plugin packages pm-cli for Codex with:

- a native stdio MCP server (`pm-cli-native`) backed by pm command modules, not shell `pm` invocations
- skills for developer, user, extension, SDK, release, and audit workflows
- command prompts for common planning and verification loops
- repo marketplace metadata for one-step local installation in Codex

## Install

From this repository:

```bash
codex plugin marketplace add .
```

Restart Codex, then install **pm CLI** from the repo marketplace. The bundled MCP server starts through `plugins/pm-cli-codex/scripts/pm-mcp-server.mjs`.

For a published package install, keep `@unbrained/pm-cli` available through npm. The launcher uses the local repo build when present and falls back to `npx -y @unbrained/pm-cli@latest pm-mcp` when the plugin is cached outside the repository.

## Native Tools

Prefer the narrow tools when they match the task: `pm_context`, `pm_search`, `pm_list`, `pm_get`, `pm_create`, `pm_update`, `pm_claim`, `pm_release`, `pm_close`, `pm_comments`, `pm_files`, `pm_docs`, `pm_test`, `pm_validate`, `pm_health`, `pm_contracts`, and `pm_guide`.

Use `pm_run` for the remaining pm surface. Supported actions include `init`, `calendar`, `activity`, `aggregate`, `dedupe-audit`, `normalize`, `reindex`, `extension`, `history`, `stats`, `append`, `notes`, `learnings`, `test-all`, `comments-audit`, `gc`, templates, and test-runs controls.

## Safety

Do not pass `path` for real repository tracking. For tests, pass a sandbox `cwd` or `path`, and keep `PM_GLOBAL_PATH` isolated when running commands that execute linked tests.
