# Codex Plugin

pm-cli ships a repo-local Codex plugin at [`plugins/pm-cli-codex`](../plugins/pm-cli-codex/README.md).

## Install From This Repo

```bash
codex plugin marketplace add .
```

Restart Codex and install **pm CLI** from the `pm CLI Local` marketplace.

## What It Provides

- `pm-cli-native` MCP server for structured pm operations without invoking the `pm` shell command
- narrow tools for common loops: context, search, list, get, create, update, claim, release, close, comments, files, docs, tests, validate, health, contracts, and guide
- `pm_run` for the rest of the pm surface, including calendar, activity, aggregate, dedupe-audit, normalize, reindex, extensions, templates, history, stats, gc, and test-runs controls
- skills for native tracking, audits, and release workflows
- command prompts for start, close, and audit flows

## Native MCP Notes

The plugin launcher uses the local repository build when `dist/mcp/server.js` is present. When the plugin is cached outside the repo, it falls back to:

```bash
npx -y @unbrained/pm-cli@latest pm-mcp
```

The fallback starts the package MCP server, not the `pm` CLI command. Tool calls import pm command modules and return JSON-compatible structured results.

## Safety

For real repository tracking, leave `path` unset so pm uses the repository `.agents/pm` root. For tests, use a sandbox `cwd` or `path` and isolate `PM_GLOBAL_PATH`.
