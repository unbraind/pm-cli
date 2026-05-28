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

`config set <key> <value>` also accepts the value as a positional argument; pm routes
it to the right typed flag based on the key (so `--policy`/`--format`/`--criterion`
remain optional for single values):

```bash
pm config set telemetry-tracking off          # off|on|true|false map to disabled|enabled
pm config set item-format toon                # same as --format toon
pm config set governance-preset strict        # same as --policy strict
pm config set definition-of-done "Tests pass" # same as --criterion "Tests pass"
```

The `context` key has no single value and still uses `--default-depth`,
`--activity-limit`, `--stale-threshold-days`, and `--section-<name>` flags. Use
`--criterion` (repeatable) to set more than one criteria-list value at once.

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
| `governance.create_default_type` | default `--type` used by the `pm create "title"` positional shortcut (defaults to `Task`) |
| `search.*` | search mode, scoring, providers, embedding timeout, and vector settings |

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
pm health --check-only --summary --json
```

## Search Configuration

Keyword search is always available:

```bash
pm search "release docs" --mode keyword --limit 10
```

Semantic and hybrid search can use built-in OpenAI-compatible or Ollama providers plus vector stores such as Qdrant or LanceDB. If local Ollama is available and semantic settings are unset, `pm` can resolve local defaults automatically.

For local Ollama or slower embedding providers, tune `search.embedding_batch_size`, `search.embedding_timeout_ms`, and `search.scanner_max_batch_retries` in project config before assuming semantic search is broken. Keyword search remains the fast baseline while semantic indexing catches up.

Useful commands:

```bash
pm search "calendar reminders" --mode hybrid --limit 10
pm reindex --mode hybrid --progress
pm health --check-only
```

### Custom search providers

pm supports any OpenAI-compatible API or Ollama-style provider via configuration. No code changes needed. Each leaf below can be set with `pm config <scope> set <key> <value>` (the corresponding `settings.json` dotted path is shown in parentheses).

**Ollama** (local, default for offline embedding):

```bash
pm config project set ollama_base_url http://localhost:11434
pm config project set ollama_model nomic-embed-text
pm config project set search_provider ollama
```

**OpenAI**:

```bash
pm config project set openai_api_key sk-...
pm config project set openai_model text-embedding-3-small
pm config project set search_provider openai
```

**LM Studio (OpenAI-compatible)** — point pm at LM Studio's local OpenAI-compatible endpoint:

```bash
pm config project set openai_base_url http://localhost:1234/v1
pm config project set openai_model nomic-embed-text-v1.5
pm config project set search_provider openai
```

Set `openai_api_key` to any non-empty value if LM Studio is configured to require one.

**vLLM (OpenAI-compatible)** — point pm at a vLLM server serving an embedding model:

```bash
pm config project set openai_base_url http://localhost:8000/v1
pm config project set openai_model BAAI/bge-large-en-v1.5
pm config project set search_provider openai
```

**Vector store** — choose where vector embeddings live. LanceDB is file-backed and zero-setup; Qdrant runs as a service:

```bash
pm config project set vector_store_adapter lancedb
pm config project set lancedb_path .agents/pm/search/lancedb

# or, with Qdrant:
pm config project set vector_store_adapter qdrant
pm config project set qdrant_url http://localhost:6333
pm config project set qdrant_api_key <key-if-required>
```

After changing any of these, run `pm reindex --mode hybrid` so the vector index reflects the new provider/store. `pm search ... --mode semantic|hybrid` emits a `vector_index_stale` warning when items have been modified since the last reindex.

## Custom Item Types

Custom item types can be defined in settings and by extensions. Runtime type resolution affects create/update validation, list/search/calendar filters, completions, and storage folders.

Use runtime contracts for exact active types:

```bash
pm contracts --json
pm create --help --type Task
```

## Public Documentation Boundary

Public docs should describe supported user configuration only. Ignored local operations material, unpublished evidence logs, credentials, hostnames, and private service details must stay outside tracked docs and package output.
