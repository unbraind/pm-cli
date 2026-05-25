# Codex Plugin

pm-cli ships a repo-local Codex plugin at [`plugins/pm-codex`](../plugins/pm-codex/README.md).

## Install From This Repo

```bash
codex plugin marketplace add .
```

Restart Codex and install **pm CLI** from the `pm CLI Local` marketplace.

## What It Provides

The canonical tool, skill, command, and safety inventory lives in the plugin README:

- [pm CLI Codex Plugin](../plugins/pm-codex/README.md)

Keep this page as the public docs router so the MCP tool/action list has one maintained source.

## Native MCP Notes

The plugin launcher uses the local repository build when `dist/mcp/server.js` is present. When the plugin is cached outside the repo, it falls back to:

```bash
npx -y @unbrained/pm-cli@latest pm-mcp
```

The fallback starts the package MCP server, not the `pm` CLI command. Tool calls import pm command modules and return JSON-compatible structured results.

## Safety

For real repository tracking, leave `path` unset so pm uses the repository `.agents/pm` root. For tests, use a sandbox `cwd` or `path` and isolate `PM_GLOBAL_PATH`.
