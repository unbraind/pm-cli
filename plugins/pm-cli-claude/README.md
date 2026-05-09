# pm CLI — Claude Code Plugin

Native pm CLI integration for Claude Code. Use pm project management tools directly through Claude Code's MCP protocol — no shell invocations, no context switching.

## What's Included

| Component | What it provides |
|-----------|----------------|
| **18 MCP tools** | Full pm surface: context, search, list, get, create, update, claim, release, close, comments, files, docs, test, validate, health, contracts, guide + `pm_run` for everything else |
| **5 skills** | `pm-workflow`, `pm-developer`, `pm-release`, `pm-audit`, `pm-planner` — auto-loaded as Claude Code skills |
| **9 slash commands** | `/pm-status`, `/pm-start-task`, `/pm-close-task`, `/pm-triage`, `/pm-audit`, `/pm-search`, `/pm-new`, `/pm-list`, `/pm-calendar` |
| **Session hook** | Injects active pm item summary at session start when pm is initialized |
| **pm-coordinator agent** | Subagent for coordinating multi-item and batch operations |

## Installation

### Option A: Plugin marketplace (recommended)

```
/plugin marketplace add unbraind/pm-cli
/plugin install pm-cli@pm-cli
```

This clones the repository, reads the marketplace catalog, and installs the plugin including all MCP tools, skills, slash commands, and the session hook — no separate download needed.

### Option B: Global MCP server via Claude Code CLI (MCP tools only)

```bash
claude mcp add --transport stdio pm-cli-native -- npx -y @unbrained/pm-cli pm-mcp
```

This gives you the 18 MCP tools but not the skills, slash commands, or session hook.

### Option C: Direct `.mcp.json` (project-scoped MCP only)

Add to your project's `.mcp.json` for MCP tools in a single project:

```json
{
  "mcpServers": {
    "pm-cli-native": {
      "command": "npx",
      "args": ["-y", "@unbrained/pm-cli@latest", "pm-mcp"],
      "env": {
        "PM_AUTHOR": "claude-code-agent"
      }
    }
  }
}
```

## Quick Start

After installation, restart Claude Code. All tools are available immediately:

```
Can you show me the current pm project status?
→ Claude uses pm_context + pm_run(calendar) automatically

Start working on the authentication bug.
→ Claude searches pm, finds or creates an item, claims it

Close pm-xxxx — the fix is complete.
→ Claude runs /pm-close-task pm-xxxx with evidence linking
```

## Slash Commands

| Command | What it does |
|---------|-------------|
| `/pm-status` | Quick status snapshot — active items + calendar |
| `/pm-start-task [id or keywords]` | Find, claim, and start a pm item |
| `/pm-close-task [id]` | Verify, evidence, close, and release an item |
| `/pm-triage <request>` | Triage a new request into pm tracking |
| `/pm-audit` | Full repository audit with findings |
| `/pm-search <query>` | Search pm items by keywords, tags, or status |
| `/pm-new <title>` | Quick-create a new pm item (with duplicate check) |
| `/pm-list [filter]` | List active or filtered pm items |
| `/pm-calendar [view]` | Show upcoming deadlines and calendar events |

## Skills

| Skill | When Claude uses it |
|-------|-------------------|
| `pm-workflow` | Any pm-tracked work — orient, claim, implement, close |
| `pm-developer` | Implementation tasks — code, tests, docs changes |
| `pm-release` | Release preparation — gates, tagging, publish |
| `pm-audit` | Repository health audits — validate, dedupe, aggregate |
| `pm-planner` | Planning — decompose epics, prioritize backlog, triage |

## MCP Tools Reference

### Narrow tools (prefer these)

| Tool | Purpose |
|------|---------|
| `pm_context` | Active work snapshot |
| `pm_search` | Keyword/semantic/hybrid search |
| `pm_list` | Filtered item list |
| `pm_get` | Single item detail |
| `pm_create` | Create new item |
| `pm_update` | Update metadata |
| `pm_claim` | Claim for active work |
| `pm_release` | Release claim |
| `pm_close` | Close with reason |
| `pm_comments` | List or add comments |
| `pm_files` | Link/unlink files |
| `pm_docs` | Link/unlink docs |
| `pm_test` | Link or run tests |
| `pm_validate` | Run validation checks |
| `pm_health` | Run health diagnostics |
| `pm_contracts` | Inspect command contracts |
| `pm_guide` | Read guide topics |

### General tool

| Tool | Purpose |
|------|---------|
| `pm_run` | Any pm action not covered above — pass `action` field |

**`pm_run` actions:** `init`, `calendar`, `activity`, `aggregate`, `dedupe-audit`, `normalize`, `reindex`, `extension`, `history`, `stats`, `append`, `notes`, `learnings`, `test-all`, `comments-audit`, `gc`, `templates-list`, `templates-save`, `templates-show`, `test-runs-list`, `test-runs-status`, `test-runs-logs`, `test-runs-stop`, `test-runs-resume`, `config`, `completion`

## Safety

- Never pass `path` during real repository tracking — only use it for sandbox/test runs.
- Set `author: "claude-code-agent"` on all mutations.
- Run `pm_validate` before closing items.
- For tests, pass a sandbox `cwd` and set `PM_GLOBAL_PATH` to an isolated path.

## Requirements

- Node.js ≥ 20
- pm CLI available via npx (auto-resolved) or installed globally: `npm install -g @unbrained/pm-cli`
- Project initialized with `pm init`

## Links

- [pm CLI docs](https://github.com/unbraind/pm-cli/tree/main/docs)
- [Command reference](https://github.com/unbraind/pm-cli/blob/main/docs/COMMANDS.md)
- [Architecture guide](https://github.com/unbraind/pm-cli/blob/main/docs/ARCHITECTURE.md)
- [CHANGELOG](https://github.com/unbraind/pm-cli/blob/main/CHANGELOG.md)
