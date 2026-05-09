# Configuration

`pm` reads settings from the project tracker root and optional global profile. Use this page for public, user-facing configuration. Use `pm config ... list` and `pm config ... export` for the active runtime shape.

## Agent Quick Context

- Do not override `PM_PATH` for real repository tracking.
- Do set `PM_AUTHOR` for maintainer and agent mutations.
- Use `--json` only when strict parsing is needed.
- Use `pm contracts` for current command/schema metadata.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Configuration Commands

```bash
pm config project list
pm config project export --json
pm config project get item-format --json
pm config project set item-format --format toon
pm config project set test-result-tracking --policy enabled
```

Scopes:

- `project` updates `.agents/pm/settings.json`.
- `global` updates the global profile under `PM_GLOBAL_PATH` or the default global root.

Precedence:

1. CLI flags
2. environment variables
3. project settings
4. global settings
5. built-in defaults

## Common Settings

| Setting | Purpose |
|---------|---------|
| `id_prefix` | generated item ID prefix, default `pm-` |
| `author_default` | fallback mutation author |
| `item_format` | item storage format (`toon` writes; legacy markdown is read/migrate only) |
| `output.default_format` | default renderer, usually `toon` |
| `locks.ttl_seconds` | stale lock threshold |
| `history.missing_stream` | `auto_create` or `strict_error` |
| `testing.record_results_to_items` | persist bounded linked-test summaries |
| `validation.sprint_release_format` | `warn` or `strict_error` |
| `validation.parent_reference` | `warn` or `strict_error` |
| `item_types.definitions[]` | custom item types and type options |
| `search.*` | search mode, scoring, providers, and vector settings |

## Environment Variables

| Variable | Use |
|----------|-----|
| `PM_AUTHOR` | explicit mutation author |
| `PM_PATH` | override project tracker root for tests or sandboxes |
| `PM_GLOBAL_PATH` | override global profile root for tests or sandboxes |
| `PM_OLLAMA_MODEL` | choose default Ollama embedding model |
| `PM_DISABLE_OLLAMA_AUTO_DEFAULTS` | disable implicit Ollama search defaults |

Tests should set both `PM_PATH` and `PM_GLOBAL_PATH` to temporary directories. The wrapper `node scripts/run-tests.mjs ...` does that automatically.

## Item Storage Format

TOON is the default:

```bash
pm config project set item-format --format toon
```

Markdown item files are treated as legacy migration input only. Mutations always write TOON files, and history stays JSONL.

## Output Format

Most commands default to sparse TOON:

```bash
pm list-open --limit 10
```

Use JSON for strict machine parsing:

```bash
pm get <id> --json
pm contracts --json
```

`pm calendar` defaults to markdown because date-centric summaries are easier to scan in that format.

## Validation Policies

```bash
pm config project set sprint-release-format-policy --policy warn
pm config project set parent-reference-policy --policy strict_error
pm config project set history-missing-stream-policy --policy auto_create
pm config project set test-result-tracking --policy enabled
```

Use standalone checks when validating a repository:

```bash
pm validate --check-resolution --check-history-drift
pm validate --check-files --scan-mode tracked-all
pm health --check-only
```

## Search Configuration

Keyword search is always available:

```bash
pm search "release docs" --mode keyword --limit 10
```

Semantic and hybrid search can use built-in OpenAI-compatible or Ollama providers plus vector stores such as Qdrant or LanceDB. If local Ollama is available and semantic settings are unset, `pm` can resolve local defaults automatically.

Useful commands:

```bash
pm search "calendar reminders" --mode hybrid --limit 10
pm reindex --mode hybrid --progress
pm health --check-only
```

## Custom Item Types

Custom item types can be defined in settings and by extensions. Runtime type resolution affects create/update validation, list/search/calendar filters, completions, and storage folders.

Use runtime contracts for exact active types:

```bash
pm contracts --json
pm create --help --type Task
```

## Public Documentation Boundary

Public docs should describe supported user configuration only. Ignored local operations material, unpublished evidence logs, credentials, hostnames, and private service details must stay outside tracked docs and package output.
