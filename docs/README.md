# pm-cli Documentation

This directory is the public documentation home for `pm-cli`. It is organized for progressive disclosure: read the smallest page that answers the current question, then follow links only when more detail is needed.

## CLI Guide Router

`pm guide` exposes the same documentation routes from inside the CLI:

```bash
pm guide
pm guide quickstart
pm guide commands --depth standard
pm guide sdk --depth deep --format markdown
pm guide release --json
```

## Read Path

| Reader | First page | Then read |
|--------|------------|-----------|
| New user | [Quickstart](QUICKSTART.md) | [Command Reference](COMMANDS.md) |
| Coding agent | [Agent Guide](AGENT_GUIDE.md) | [Configuration](CONFIGURATION.md), then command help |
| Maintainer | [Contributing](../CONTRIBUTING.md) | [Testing](TESTING.md), [Releasing](RELEASING.md), [Architecture](ARCHITECTURE.md) |
| Extension author | [Extensions](EXTENSIONS.md) | [SDK](SDK.md), [starter extension](examples/starter-extension/README.md) |
| Pi user | [Pi Package](PI_PACKAGE.md) | [Agent Guide](AGENT_GUIDE.md), then [Command Reference](COMMANDS.md) |
| Codex user | [Codex Plugin](CODEX_PLUGIN.md) | [Agent Guide](AGENT_GUIDE.md), then [Command Reference](COMMANDS.md) |
| Machine client | `pm guide commands` | [Command Reference](COMMANDS.md#machine-contracts), then `pm contracts --json` |

## Documentation Map

- [Quickstart](QUICKSTART.md) - install, initialize, create, claim, link, test, close.
- [Agent Guide](AGENT_GUIDE.md) - canonical agent loop, tracker linking, and token-minimal command choices.
- [Command Reference](COMMANDS.md) - command families with examples and when to use each family.
- [Configuration](CONFIGURATION.md) - settings, storage formats, output, search, validation, and environment variables.
- [Testing](TESTING.md) - sandbox-safe local tests and linked-test orchestration.
- [Architecture](ARCHITECTURE.md) - contributor internals: storage, mutation flow, search, extensions, and command contracts.
- [Extensions](EXTENSIONS.md) - runtime extension lifecycle and API reference.
- [SDK](SDK.md) - public import surfaces and typed authoring examples.
- [Pi Package](PI_PACKAGE.md) - official Pi package install, native tool, skills, prompts, and workflows.
- [Codex Plugin](CODEX_PLUGIN.md) - native MCP plugin install, tools, skills, and safety notes.
- [Releasing](RELEASING.md) - maintainer release checklist and failure handling.
- [starter extension](examples/starter-extension/README.md) - compact extension scaffold reference.

## Guide Topic Map

| `pm guide` topic | Primary docs |
|------------------|--------------|
| `quickstart` | [Quickstart](QUICKSTART.md), [Command Reference](COMMANDS.md) |
| `commands` | [Command Reference](COMMANDS.md), [Configuration](CONFIGURATION.md) |
| `workflows` | [Agent Guide](AGENT_GUIDE.md), [Testing](TESTING.md) |
| `sdk` | [SDK](SDK.md), [Architecture](ARCHITECTURE.md) |
| `extensions` | [Extensions](EXTENSIONS.md), [starter extension](examples/starter-extension/README.md) |
| `skills` | [Agent Guide](AGENT_GUIDE.md) plus `.agents/skills/*` |
| `harnesses` | [Agent Guide](AGENT_GUIDE.md) plus `.agents/skills/HARNESS_COMPATIBILITY.md` |
| `release` | [Releasing](RELEASING.md), [CHANGELOG](../CHANGELOG.md) |

Community files:

- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Changelog](../CHANGELOG.md)
- [License](../LICENSE)

## Agent Routing Rules

1. Start with [Agent Guide](AGENT_GUIDE.md) for workflow rules.
2. Use [Command Reference](COMMANDS.md) for command families, not exhaustive flag memory.
3. Use `pm <command> --help --json` or `pm contracts --command <name> --flags-only --json` for exact flags.
4. Use [Architecture](ARCHITECTURE.md) only when changing internals or debugging behavior.
5. Use [SDK](SDK.md) and [Extensions](EXTENSIONS.md) only when authoring or troubleshooting extensions.

## Tracker References

This documentation structure is tracked through:

- [pm-3042](../.agents/pm/epics/pm-3042.toon)
- [pm-r9gu](../.agents/pm/features/pm-r9gu.toon)
- [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon)

When changing docs, link files back to the active item:

```bash
pm docs <item-id> --add path=docs/README.md,scope=project,note="documentation index"
pm comments <item-id> "Docs updated; links and build verified."
```

## Public Boundary

Public docs must not link to ignored local operations artifacts, unpublished evidence logs, credentials, host-specific runbooks, or private service details. Keep those materials local and out of packaged releases.

## Maintenance Checklist

- Keep links relative and GitHub-compatible.
- Keep README short; move detail into focused pages.
- Put a short "Agent Quick Context" near the top of deep docs.
- Prefer commands that agents can copy exactly.
- Use `pm` item IDs as durable references when docs explain tracked work.
- Run link/search checks before closing documentation tasks.
