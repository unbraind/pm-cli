# Configuration

`pm` reads settings from the project tracker root and optional global profile. Use this page for public, user-facing configuration. Use `pm config ... list` and `pm config ... export` for the active runtime shape.

## Agent Quick Context

- Do not override `PM_PATH` for real repository tracking.
- Do set `PM_AUTHOR` for maintainer and agent mutations.
- Use `--json` only when strict parsing is needed.
- Use `pm contracts` for current command/schema metadata.

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon).

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

When `settings.json` cannot be loaded, `pm` falls back to built-in defaults and prints a one-time `settings_read_invalid_json` or `settings_read_invalid_schema` warning to stderr (stdout output is unchanged); run `pm health` for remediation.

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
| `governance.create_default_type` | default `--type` used by `pm create "title"` when `--type` is omitted (defaults to `Task`); must resolve to a known item type |
| `governance.workflow_enforcement` | per-type transition enforcement mode for `pm update --status` (`off` default, `warn`, or `strict`) |
| `schema.type_workflows[]` | per-type allowed status transitions (see Per-Type Workflows below) |
| `search.*` | search mode, scoring, providers, embedding timeout, and vector settings |

Runtime item types are context primitives. Use `pm schema list` to inspect the merged registry and `pm schema show <Type>` to inspect one type's folder, aliases, defaults, required options, and extension provenance. `pm init --type-preset agile|ops|research` writes reusable domain types into `.agents/pm/schema/types.json`; this is equivalent to persisted project schema, not an extension-only runtime overlay.

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
pm get <id> --full --json
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

## Per-Type Workflows

Restrict which status transitions are allowed for a given item type. Rules live in
`schema/workflows.json` alongside the lifecycle `workflow` block, and enforcement is
gated by `governance.workflow_enforcement` (default `off`, so existing projects are
unaffected until you opt in).

```jsonc
// .agents/pm/schema/workflows.json
{
  "workflow": { "open_status": "open", "close_status": "closed", "canceled_status": "canceled" },
  "type_workflows": [
    {
      "type": "Story",
      "allowed_transitions": [
        ["open", "in_progress"],
        ["in_progress", "closed"]
      ]
    }
  ]
}
```

```bash
pm config project set governance-workflow-enforcement strict   # off | warn | strict
pm config project set governance-create-default-type Issue     # default create type
```

Semantics:

- A type with **no** `type_workflows` entry is unrestricted (every transition allowed).
- A type **with** an entry allows only the listed `[from, to]` pairs. `from`/`to` are
  matched case-insensitively and resolved through the status registry's aliases.
- A same-status no-op (`from === to`) is always allowed.
- `workflow_enforcement: strict` rejects a disallowed transition (including transitions
  toward the close status, gated before close-routing) with the allowed-transition hint.
- `workflow_enforcement: warn` still applies the change but adds a
  `workflow_transition_not_allowed` warning to the update result.
- `workflow_enforcement: off` (default) ignores all `type_workflows` rules.

## Search Configuration

Keyword search is always available:

```bash
pm search "release docs" --mode keyword --limit 10
```

`search.tuning` controls deterministic lexical weighting in keyword mode and the lexical component of hybrid mode. Default runtime weights:

- `title_exact_bonus=10`
- `title_weight=8`, `description_weight=5`, `tags_weight=6`, `status_weight=2`
- `body_weight=1`, `comments_weight=1`, `notes_weight=1`, `learnings_weight=1`
- `reminders_weight=2`, `events_weight=2`
- `dependencies_weight=3`, `linked_content_weight=1`

Semantic and hybrid search can use built-in OpenAI-compatible or Ollama providers plus vector stores such as Qdrant or LanceDB. If local Ollama is available and semantic settings are unset, `pm` can resolve local defaults automatically.

For local Ollama or slower embedding providers, tune `search.embedding_batch_size`, `search.embedding_timeout_ms`, and `search.scanner_max_batch_retries` in project config before assuming semantic search is broken. Keyword search remains the fast baseline while semantic indexing catches up.

Mutation commands invalidate keyword search caches immediately. Semantic vector refresh is controlled by `search.mutation_refresh_policy`:

| Policy | Behavior |
|--------|----------|
| `semantic_configured` | default; refresh vectors during mutations only when semantic provider/store settings are explicitly configured |
| `cache_only` | fastest writes; invalidate keyword caches and leave vector refresh to `pm reindex` or `pm health --refresh-vectors` |
| `semantic_auto` | also apply implicit local Ollama/LanceDB defaults during mutations |

Useful commands:

```bash
pm config project set search_mutation_refresh_policy cache_only
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
pm config project set openai_base_url https://api.openai.com/v1
pm config project set openai_api_key '<OPENAI_API_KEY>'
pm config project set openai_model text-embedding-3-small
pm config project set search_provider openai
```

The base URL defaults to empty, so it must be set explicitly even for the canonical OpenAI endpoint.

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
pm config project set qdrant_api_key '<QDRANT_API_KEY>'   # omit on unauthenticated dev servers
```

After changing any of these, run `pm reindex --mode hybrid` so the vector index reflects the new provider/store. `pm search ... --mode semantic|hybrid` emits a `vector_index_stale` warning when items have been modified since the last reindex.

**Refresh contract (important for agents):** by default a mutation (`pm create`/`pm update`) does **not** synchronously re-embed the changed item, so a brand-new item is absent from `--mode semantic|hybrid` results until the next `pm reindex`. This keeps writes fast. Control the tradeoff with `search.mutation_refresh_policy`: `cache_only` (never refresh on write — fastest), `semantic_auto` (refresh when implicit Ollama/LanceDB defaults are active), or `semantic_configured` (refresh only when semantic search is explicitly configured). Keyword mode (`--mode keyword`, the default) always reflects writes immediately because it reads items directly.

## Custom Item Types

Custom item types can be defined in settings and by extensions. Runtime type resolution affects create/update validation, list/search/calendar filters, completions, and storage folders.

Use runtime contracts for exact active types:

```bash
pm contracts --json
pm create --help --type Task
```

## Public Documentation Boundary

Public docs should describe supported user configuration only. Ignored local operations material, unpublished evidence logs, credentials, hostnames, and private service details must stay outside tracked docs and package output.
