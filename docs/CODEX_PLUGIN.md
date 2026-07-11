# Codex Plugin

pm-cli ships a repo-local Codex plugin at [`plugins/pm-codex`](../plugins/pm-codex/README.md).

It is a real Codex plugin package: the repo marketplace installs it and Codex registers its skills and bundled
MCP server. It is not yet a self-contained cached runtime or an Apps SDK-backed ChatGPT app. The official-source
audit, verified gaps, and phased remediation plan are documented in
[Native ChatGPT and Codex Plugin Implementation Plan](CHATGPT_CODEX_PLUGIN_IMPLEMENTATION.md).

## Install From This Repo

```bash
codex plugin marketplace add .
```

Restart Codex and install **pm CLI** from the `pm CLI Local` marketplace.

## What It Provides

The canonical tool, skill, command, and safety inventory lives in the plugin README:

- [pm CLI Codex Plugin](../plugins/pm-codex/README.md)

Keep this page as the public docs router so the MCP tool/action list has one maintained source.

## Current MCP Runtime Note

The plugin launcher uses the local repository build when `dist/mcp/server.js` is present. When the plugin is cached outside the repo, it falls back to:

```bash
npx -y --package=@unbrained/pm-cli@latest pm-mcp
```

The fallback starts the package MCP server, not the `pm` CLI command. Tool calls import pm command modules and return JSON-compatible structured results.

This is current behavior, not the target distribution contract. A normal cached install has no repository
`dist/` ancestor, so it depends on npm availability and can run a newer server than the installed plugin. Track
the self-contained, version-coherent runtime work under
[pm-95d7](../.agents/pm/features/pm-95d7.toon).

## Safety

For real repository tracking, leave `path` unset so pm uses the repository `.agents/pm` root. For tests, use a sandbox `cwd` or `path` and isolate `PM_GLOBAL_PATH`.
