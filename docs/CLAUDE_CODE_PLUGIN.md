# pm CLI — Claude Code Plugin

Native pm integration for Claude Code via the Model Context Protocol (MCP). Claude can use all pm operations as native tools — no shell invocation, no context switching.

## Architecture

```
pm-cli/ (repo root)
├── .claude-plugin/
│   └── marketplace.json     # Root marketplace catalog — read by /plugin marketplace add
├── plugins/pm-cli-claude/
│   ├── .claude-plugin/
│   │   └── plugin.json      # Claude Code plugin manifest (name: "pm-cli")
│   ├── .mcp.json            # MCP server config using ${CLAUDE_PLUGIN_ROOT}
│   ├── skills/
│   │   ├── pm-workflow/     # Auto-invoked: orient → claim → implement → close
│   │   ├── pm-developer/    # Developer execution loop with evidence requirements
│   │   ├── pm-release/      # Release gate sequence and evidence linking
│   │   ├── pm-audit/        # Comprehensive audit suite
│   │   └── pm-planner/      # Planning: decompose, prioritize, triage
│   ├── commands/
│   │   ├── pm-status.md     # /pm-status
│   │   ├── pm-start-task.md # /pm-start-task [id|keywords]
│   │   ├── pm-close-task.md # /pm-close-task [id]
│   │   ├── pm-triage.md     # /pm-triage <request>
│   │   ├── pm-audit.md      # /pm-audit
│   │   ├── pm-search.md     # /pm-search <query>
│   │   ├── pm-new.md        # /pm-new <title>
│   │   ├── pm-list.md       # /pm-list [filter]
│   │   └── pm-calendar.md   # /pm-calendar [view]
│   ├── hooks/
│   │   ├── hooks.json       # SessionStart hook definition
│   │   └── session-start.mjs # Injects pm context at session start
│   ├── agents/
│   │   └── pm-coordinator.md # Subagent for multi-item coordination
│   ├── scripts/
│   │   └── pm-mcp-server.mjs # MCP server launcher (repo → npx fallback)
│   └── README.md            # User-facing installation guide
└── scripts/
    └── smoke-claude-plugin.mjs  # Full plugin smoke test (run in CI)
```

The MCP server itself lives at `src/mcp/server.ts` (compiled to `dist/mcp/server.js`) and is bundled with the npm package as the `pm-mcp` binary.

## MCP Server Tools

The server exposes 18 native tools that call pm library functions directly:

| Tool | pm Operation | Key Args |
|------|-------------|----------|
| `pm_context` | `pm context` | `options.limit`, `options.depth` |
| `pm_search` | `pm search` | `query` (required), `options.limit` |
| `pm_list` | `pm list` | `options.status`, `options.type`, `options.limit` |
| `pm_get` | `pm get` | `id` (required) |
| `pm_create` | `pm create` | `options.title`, `options.description`, `options.type` |
| `pm_update` | `pm update` | `id` (required), `options.*` |
| `pm_claim` | `pm claim` | `id` (required), `force` |
| `pm_release` | `pm release` | `id` (required), `force` |
| `pm_close` | `pm close` | `id` (required), `reason` (required) |
| `pm_comments` | `pm comments` | `id` (required), `options.add` |
| `pm_files` | `pm files` | `id` (required), `options.add`, `options.remove` |
| `pm_docs` | `pm docs` | `id` (required), `options.add`, `options.remove` |
| `pm_test` | `pm test` | `id` (required), `options.add`, `options.run` |
| `pm_validate` | `pm validate` | `options.checkResolution`, `options.checkFiles` |
| `pm_health` | `pm health` | `options.checkOnly` |
| `pm_contracts` | `pm contracts` | `options.command`, `options.json` |
| `pm_guide` | `pm guide` | `options.topic`, `options.depth` |
| `pm_run` | any pm action | `action` (required), `id`, `query`, `reason`, `options.*` |

All tools accept `cwd` (workspace directory), `path` (pm data root override), and `author` (mutation author).

## Installation Methods

### 1. Plugin marketplace (recommended — full feature set)

Add the pm-cli GitHub repo as a marketplace source, then install:

```
/plugin marketplace add unbraind/pm-cli
/plugin install pm-cli@pm-cli
```

This clones the repo, reads `.claude-plugin/marketplace.json` at the root, installs the plugin from `./plugins/pm-cli-claude/`, and configures the MCP server, 5 skills, 9 slash commands, and the session hook automatically.

### 2. Global MCP via Claude Code CLI (MCP tools only)

```bash
claude mcp add --transport stdio pm-cli-native -- npx -y @unbrained/pm-cli pm-mcp
```

Gives you the 18 MCP tools without skills or slash commands.

### 3. Direct project `.mcp.json` (project-scoped MCP only)

Add to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "pm-cli-native": {
      "command": "node",
      "args": ["./plugins/pm-cli-claude/scripts/pm-mcp-server.mjs"],
      "env": { "PM_AUTHOR": "claude-code-agent" }
    }
  }
}
```

The repo root `.mcp.json` uses this approach — activates automatically when Claude Code opens this repository.

## MCP Server Launcher

`plugins/pm-cli-claude/scripts/pm-mcp-server.mjs` resolves the server in order:

1. `PM_CLI_MCP_SERVER` env var (explicit override)
2. `dist/mcp/server.js` walking up from the launcher (repo checkout)
3. `npx -y @unbrained/pm-cli@latest pm-mcp` (npm-installed fallback)

This means the plugin works both from a repo checkout and from an npm-cached plugin install.

## Session Start Hook

`hooks/session-start.mjs` runs at the start of each Claude Code session. It:

1. Checks for `.agents/pm/settings.json` in the current workspace.
2. Exits silently if pm is not initialized.
3. Runs `pm context --limit 5 --json` with a 5-second timeout.
4. Injects a compact status line into the session context.

Example injection:
```
pm tracker: 3 in_progress, 2 open
  • [pm-xxxx] Fix authentication bug (in_progress)
  • [pm-yyyy] Add calendar feature (in_progress)
  • [pm-zzzz] Update docs (open)
Use pm_context tool or /pm-status for full details.
```

## Testing the Plugin

### Full Claude Code plugin smoke test (runs in CI)

```bash
node scripts/smoke-claude-plugin.mjs
# or:
pnpm smoke:claude-plugin
```

Verifies: file structure (23 files), manifest name consistency, MCP initialize, 18 tools present, full workflow (init → create → claim → update → link files/docs/tests → get → context → search → validate → health), and session-start hook.

### MCP server smoke test

```bash
node scripts/smoke-codex-plugin-mcp.mjs
# or:
pnpm smoke:codex-plugin
```

### Validate manifests

```bash
claude plugin validate .claude-plugin/marketplace.json
claude plugin validate plugins/pm-cli-claude/.claude-plugin/plugin.json
```

### Manual verification

After installing the plugin:

1. Start Claude Code: `claude` (in a pm-initialized directory)
2. Ask: "What's the current pm project status?"
   → Verify Claude uses `pm_context` (not Bash)
3. Try `/pm-status` — active items + calendar
4. Try `/pm-search authentication` — search results
5. Try `/pm-new Fix the login timeout bug` — duplicate-checked create
6. Try `/pm-start-task pm-xxxx` — claim and start
7. Try `/pm-calendar week` — upcoming deadlines
8. Try `/pm-close-task pm-xxxx` — verify, evidence, close

## Compatibility

| pm-cli version | Plugin version | Claude Code version |
|---------------|----------------|---------------------|
| 2026.5.x+ | 1.0.0 | Any current |

The MCP server uses JSON-RPC 2.0 over stdio with protocol version `2025-06-18`.
