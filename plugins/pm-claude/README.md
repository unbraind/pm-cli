# pm CLI — Claude Code Plugin

Native pm CLI integration for Claude Code. Use pm project management tools directly through Claude Code's MCP protocol — no shell invocations, no context switching, no `pm` CLI required.

## What's Included

| Component | What it provides |
|-----------|----------------|
| **18 MCP tools** | Full pm surface: context, search, list, get, create, update, claim, release, close, comments, files, docs, test, validate, health, contracts, guide + `pm_run` for everything else |
| **5 skills** | `pm-workflow`, `pm-developer`, `pm-release`, `pm-audit`, `pm-planner` — auto-loaded as Claude Code skills |
| **14 slash commands** | Full lifecycle coverage — status, start, close, triage, audit, search, new, list, calendar, developer, planner, release, workflow, init |
| **3 subagents** | `pm-coordinator` (batch/multi-item), `pm-triage-agent` (duplicate-safe item creation), `pm-verification-agent` (evidence + close readiness), and a `pm-delivery-chain` orchestrator |
| **Hybrid TUI tracking** | pm items sync to Claude Code's task panel — pm is the persistent store, the task panel is the live session view |
| **Session hook** | Injects active pm item summary at session start when pm is initialized (uses native modules, no CLI required) |

## Installation

### Option A: Plugin marketplace — canonical install (recommended)

```
/plugin install pm-cli@pm
```

First time: add the marketplace if it's not configured yet:

```bash
claude plugin marketplace add /path/to/pm-cli
# or after npm publish:
# claude plugin marketplace add unbraind/pm-cli
```

This installs all 18 MCP tools, 5 skills, 14 slash commands, 3 subagents, hybrid TUI tracking, and the session hook in one step.

### Option B: Legacy marketplace alias (also works)

```
/plugin install pm-cli@pm-cli
```

Both `pm` and `pm-cli` marketplace IDs resolve to the same plugin.

### Option C: Global MCP server via Claude Code CLI (MCP tools only)

```bash
claude mcp add --transport stdio pm-mcp -- npx -y @unbrained/pm-cli pm-mcp
```

This gives you the 18 MCP tools but not the skills, slash commands, or session hook.

### Option D: Direct `.mcp.json` (project-scoped MCP only)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "pm-mcp": {
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
→ Claude searches pm, finds or creates an item, claims it, syncs to task panel

Close pm-xxxx — the fix is complete.
→ Claude runs /pm-close-task pm-xxxx with evidence linking, closes pm item, marks task panel entry completed

Triage this request: add dark mode toggle to settings screen
→ Claude spawns pm-triage-agent, checks duplicates, creates pm item with AC, hands off to /pm-developer
```

## Hybrid TUI Task Tracking

pm items automatically sync to Claude Code's task panel during active sessions:

- **pm** = persistent cross-session store (git-native, tracked in `.agents/pm/`)
- **Claude Code task panel** = live session view with spinners and status

When you `/pm-start-task` or `/pm-developer`:
1. The pm item is claimed (`pm_claim`)
2. A matching entry appears in Claude Code's task panel with a spinner (`TaskCreate`)
3. Work progresses; evidence is linked in pm
4. On `/pm-close-task`, pm is closed AND the task panel entry shows ✔ completed

This means you get full history in pm (survives restarts, visible in `pm list`) and live visual feedback in the Claude Code session.

## Slash Commands

| Command | What it does |
|---------|-------------|
| `/pm-status` | Quick status snapshot — active items + calendar |
| `/pm-start-task [id or keywords]` | Find, claim, and start a pm item (with TUI sync) |
| `/pm-close-task [id]` | Verify, evidence, close, and release an item (marks TUI completed) |
| `/pm-triage <request>` | Triage a new request into pm tracking |
| `/pm-audit` | Full repository audit with findings (TUI tracked) |
| `/pm-search <query>` | Search pm items by keywords, tags, or status |
| `/pm-new <title>` | Quick-create a new pm item (with duplicate check) |
| `/pm-list [filter]` | List active or filtered pm items |
| `/pm-calendar [view]` | Show upcoming deadlines and calendar events |
| `/pm-developer [id or keywords]` | Full developer loop — claim, implement, verify, close |
| `/pm-planner [scope]` | Plan and decompose work — survey, create hierarchy, prioritize |
| `/pm-release [version or id]` | Release gates — build, tests, coverage, CI, publish |
| `/pm-workflow [id or description]` | General pm workflow loop with TUI tracking |
| `/pm-init [project name]` | Initialize pm in the current project |

## Skills

| Skill | When Claude uses it |
|-------|-------------------|
| `pm-workflow` | Any pm-tracked work — orient, claim, implement, close |
| `pm-developer` | Implementation tasks — code, tests, docs changes |
| `pm-release` | Release preparation — gates, tagging, publish |
| `pm-audit` | Repository health audits — validate, dedupe, aggregate |
| `pm-planner` | Planning — decompose epics, prioritize backlog, triage |

## Subagents

| Agent | Role |
|-------|------|
| `pm-coordinator` | Multi-item and batch coordination — batch updates, audit workflows, release gate sequences |
| `pm-triage-agent` | Duplicate-safe item creation — orient, search, establish lineage, produce implementation-ready item |
| `pm-verification-agent` | Closure evidence — read item, check AC, run tests, validate, produce structured close recommendation |
| `pm-delivery-chain` | End-to-end orchestrator — runs triage → implement → verify as a single tracked loop |

Use subagents via Claude Code's built-in `Agent` tool:
```
Spawn pm-triage-agent to set up the pm item for: add OAuth2 login support
```

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

## Hybrid TUI Sync Pattern

All skills and commands implement this pattern for every claimed item:

```
1. pm_claim → [pm stores claim]
2. TaskCreate { subject: "[pm-xxxx] title", activeForm: "Working on pm-xxxx" }
   → [spinner appears in Claude Code task panel]
3. TaskUpdate { status: "in_progress" }
4. ... do work, link evidence in pm ...
5. pm_close → pm_release → [pm stores closure]
6. TaskUpdate { status: "completed" }
   → [✔ appears in Claude Code task panel]
```

## Session Context Injection

At session start, the hook runs natively (no `pm` CLI required):
- Uses `npx @unbrained/pm-cli` without requiring a global install
- Injects a compact summary of in-progress/open/blocked items

Example output:
```
pm tracker: 2 in_progress, 1 open
  • [pm-abc1] Add OAuth2 login (in_progress)
  • [pm-abc2] Fix test flakiness (in_progress)
  • [pm-abc3] Update docs (open)
Use pm_context tool or /pm-status for full details.
```

## Safety

- Never pass `path` during real repository tracking — only use it for sandbox/test runs.
- Set `author: "claude-code-agent"` on all mutations.
- Run `pm_validate` before closing items.
- For tests, pass a sandbox `cwd` and set `PM_GLOBAL_PATH` to an isolated path.

## Requirements

- Node.js ≥ 20
- pm CLI resolved automatically via local dist (in repo) or `npx @unbrained/pm-cli` (no global install needed)
- Project initialized with `pm init` (or use `/pm-init`)

## Links

- [pm CLI docs](https://github.com/unbraind/pm-cli/tree/main/docs)
- [Architecture guide](https://github.com/unbraind/pm-cli/blob/main/docs/ARCHITECTURE.md)
- [Extension guide](https://github.com/unbraind/pm-cli/blob/main/docs/EXTENSIONS.md)
- [CHANGELOG](https://github.com/unbraind/pm-cli/blob/main/CHANGELOG.md)
