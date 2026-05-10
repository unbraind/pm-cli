# Pi Native Package & Claude Code Plugin

pm-cli ships both an official Pi package and a Claude Code plugin so AI coding agents can use pm through native integrations instead of shelling out to the `pm` CLI.

## Claude Code Plugin

The Claude Code plugin (`plugins/pm-cli-claude/`) provides full native pm integration for Claude Code without any CLI dependency.

### Install

```
/plugin install pm-cli@pm
```

Both `pm` and `pm-cli` marketplace IDs work:

```
/plugin install pm-cli@pm      # canonical
/plugin install pm-cli@pm-cli  # legacy alias
```

To add the marketplace first (local checkout):

```bash
claude plugin marketplace add /path/to/pm-cli
```

After npm publish, the marketplace will be available via GitHub:

```bash
claude plugin marketplace add unbraind/pm-cli
```

### Plugin Components

| Component | Path | What it provides |
|-----------|------|-----------------|
| MCP server | `scripts/pm-mcp-server.mjs` | 18 native MCP tools |
| Skills | `skills/` | 5 workflow skills auto-loaded in Claude Code |
| Commands | `commands/` | 14 slash commands |
| Agents | `agents/` | 3 subagents + 1 delivery chain |
| Hooks | `hooks/` | Session-start context injection |

### MCP Tools (18)

Narrow tools: `pm_context`, `pm_search`, `pm_list`, `pm_get`, `pm_create`, `pm_update`, `pm_claim`, `pm_release`, `pm_close`, `pm_comments`, `pm_files`, `pm_docs`, `pm_test`, `pm_validate`, `pm_health`, `pm_contracts`, `pm_guide`

General tool: `pm_run` (with explicit `action` for everything else)

### Subagents (4)

| Agent | Description |
|-------|-------------|
| `pm-coordinator` | Multi-item batch coordination |
| `pm-triage-agent` | Duplicate-safe item creation with lineage |
| `pm-verification-agent` | Evidence collection and close readiness |
| `pm-delivery-chain` | Full triage → implement → verify orchestration |

### Session Hook

The session-start hook runs natively:
1. Walks up from plugin root to find `dist/pi/native.js` in a repo checkout
2. Falls back to `npx @unbrained/pm-cli` if no local dist
3. No `pm` CLI global install required in either path

---

## Pi Native Package

The Pi package at `.pi/` exposes pm through Pi's native extension API.

### Install

After the package is published:

```bash
pi install npm:@unbrained/pm-cli
```

From a local checkout:

```bash
pnpm build
pi install -l .
# or try without writing settings
pi --no-extensions -e .
```

`pnpm build` is required for local checkouts because the Pi extension imports the compiled native integration from `dist/pi/native.js`.

### Package Resources

The root `package.json` declares the Pi manifest:

- `pi.extensions`: `.pi/extensions/pm-cli/index.js`
- `pi.skills`: `.pi/skills`
- `pi.prompts`: `.pi/prompts`

The extension registers:

- native `pm` tool using pm command modules directly, not the `pm` shell command
- custom TUI rendering for pm tool calls/results (context, list/search, item details, history/activity)
- `/pm-context`, `/pm-board`, `/pm-item`, `/pm-history`, `/pm-start`, `/pm-close`, `/pm-actions`, and `/pm-workflows` helper commands
- `@pm-...` item autocomplete layered on top of Pi's editor completion
- footer status and a small below-editor widget (`pm native ready`) in interactive mode

### Native Tool Usage

Use the Pi `pm` tool with an `action` field. Examples:

```json
{ "action": "context", "limit": 10 }
{ "action": "search", "query": "pi extension", "limit": 10 }
{ "action": "start-task", "id": "pm-1234", "author": "pi-agent" }
{ "action": "files", "id": "pm-1234", "add": ["path=src/file.ts,scope=project,note=implementation"], "author": "pi-agent" }
{ "action": "close-task", "id": "pm-1234", "text": "Verified and complete", "author": "pi-agent", "validateClose": "warn" }
```

For real project tracking, leave `path` unset. For tests, set `path` to a sandbox pm root and isolate `PM_GLOBAL_PATH`.

### Pi TUI Commands

```text
/pm-board [limit]        # context dashboard with active items
/pm-item <pm-id>         # item details and recent comments
/pm-history <pm-id>      # item history panel
/pm-actions              # installed native action list
/pm-workflows            # suggested native pm workflows
```

### Pi Skills and Subagents

- Skills: `pm-native`, `pm-release`
- Prompt template: `/pm-workflow`
- Subagent files: `.pi/agents/pm-triage-agent.md`, `.pi/agents/pm-verification-agent.md`, `.pi/chains/pm-native-delivery.chain.md`

---

## Supported Surface

Both integrations cover the core pm action set: init/config/extensions, item creation and lifecycle, list/search/context/calendar/activity, files/docs/deps/tests, validation/health/gc/contracts, templates, test-runs, guide workflows, bundled beads/todos import/export, and lifecycle shortcuts (`start-task`, `pause-task`, `close-task`).
