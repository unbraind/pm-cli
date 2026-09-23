# Codex Plugin

pm-cli ships a repo-local Codex plugin at [`plugins/pm-codex`](../plugins/pm-codex/README.md).

It is a real Codex plugin package: the repo marketplace installs it and Codex registers its skills and bundled
MCP server. Its cached runtime installs the exact version declared by the plugin manifest and works offline after that first install. It is not yet an Apps SDK-backed ChatGPT app. The official-source
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

The plugin launcher uses the local repository build when `dist/mcp/server.js` is present. A copied plugin installs the exact `@unbrained/pm-cli` version in its `package.json` to persistent plugin data, then starts its `pm-mcp` server directly with Node. The installed runtime can be reused offline. Track the remaining native-plugin and ChatGPT app work under
[pm-95d7](../.agents/pm/features/pm-95d7.toon).

Run `pnpm build && pnpm smoke:plugin-cache` to verify both copied plugin
bundles against a real packed install with npm unavailable at MCP startup.

## Safety

For real repository tracking, leave `path` unset so pm uses the repository `.agents/pm` root. For tests, use a sandbox `cwd` or `path` and isolate `PM_GLOBAL_PATH`.
