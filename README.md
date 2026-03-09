# pm-cli (`pm`)

[![CI](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pm-cli)](https://www.npmjs.com/package/pm-cli)
[![Node >=20](https://img.shields.io/node/v/pm-cli)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Agent-friendly, git-native project management for humans and coding agents.

`pm` stores work items as plain markdown files with JSON front-matter, keeps append-only history, supports safe concurrent mutation with lock + claim semantics, and defaults to token-efficient TOON output.

## Why `pm`

- Git-native: every item is file-backed and reviewable in diffs.
- Deterministic: stable output schema, key ordering, and filtering behavior.
- Agent-optimized: claim/release ownership, append-only history, restore by version/timestamp.
- Extensible: project + global extension loading with predictable precedence.
- Search-ready: keyword search built-in, semantic/hybrid search optional.

## Installation

`pm-cli` targets Node.js 20+ and ships a `pm` executable via npm `bin`.

### npm (recommended)

```bash
npm i -g pm-cli
pm --help
pm --version
```

Update to latest:

```bash
npm i -g pm-cli@latest
```

### Project-local invocation

```bash
npx pm-cli --help
```

### Installer scripts

```bash
# Linux/macOS
bash scripts/install.sh

# Windows PowerShell
pwsh scripts/install.ps1
```

Both installers are idempotent for update flows; rerun them to move to a newer version.
Each installer verifies post-install CLI availability by resolving `pm` and running `pm --version` before reporting success.
Set `PM_CLI_PACKAGE` to override the package source when smoke-testing installer flows.
Scoped package names such as `@scope/pkg` still honor `--version`, while literal specs (`file:`, URLs, local paths/tarballs, or already versioned package specs) are passed to npm unchanged.

One-line bootstrap patterns (use with normal script-review caution):

```bash
curl -fsSL https://raw.githubusercontent.com/unbraind/pm-cli/main/scripts/install.sh | bash
```

```powershell
# safer PowerShell flow: download, inspect, then execute
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/unbraind/pm-cli/main/scripts/install.ps1" -OutFile "install.ps1"
pwsh -File .\install.ps1
```

During development in this repo:

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

## Maintainer Bootstrap (Dogfooding Runs)

```bash
# maintainer identity for mutation history
export PM_AUTHOR="maintainer-agent"

# refresh global pm from this repository and verify availability
npm install -g .
pm --version

# choose invocation based on whether global pm resolves to this build
export PM_CMD="pm"
# export PM_CMD="node dist/cli.js"

# verify command surface before mutation work
$PM_CMD --version
$PM_CMD --help
```

Use repository-default tracking for maintainer runs (do not set `PM_PATH`).
For test runs only, always use sandboxed paths via `node scripts/run-tests.mjs <test|coverage>` so both `PM_PATH` and `PM_GLOBAL_PATH` are isolated.

## Quickstart

```bash
# 1) initialize project tracker storage
pm init

# 2) create work item
pm create \
  --title "Implement restore command" \
  --description "Rebuild item state from history replay." \
  --type Task \
  --status open \
  --priority 1 \
  --tags "history,reliability" \
  --body "" \
  --deadline +1d \
  --estimate 90 \
  --acceptance-criteria "Restore reproduces canonical target bytes." \
  --author "steve" \
  --message "Seed restore task" \
  --assignee none \
  --dep "none" \
  --comment "author=steve,created_at=now,text=Seed restore workflow" \
  --note "author=steve,created_at=now,text=Implement replay and hash verification" \
  --learning "none" \
  --file "path=src/core/history/store.ts,scope=project,note=restore logic target" \
  --test "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240,note=sandbox-safe regression" \
  --doc "path=PRD.md,scope=project,note=authoritative contract"

# 3) list open work
pm list-open --limit 20

# 4) claim ownership
pm claim pm-a1b2

# 5) update + attach context
pm update pm-a1b2 --status in_progress --acceptance-criteria "Exact replay by version/timestamp"
pm files pm-a1b2 --add path=src/history.ts,scope=project
pm test pm-a1b2 --add command="node scripts/run-tests.mjs test",scope=project,timeout_seconds=240

# 6) close with evidence
pm comments pm-a1b2 --add "Evidence: replay tests passed"
pm close pm-a1b2 "Replay tests passed" --author "steve" --message "Close: replay tests passed"

# 7) release ownership
pm release pm-a1b2
```

## Storage Layout

Default root: `.agents/pm` (override with `PM_PATH` or `--path`)  
Global extension root: `~/.pm-cli` (override with `PM_GLOBAL_PATH`)

```text
.agents/pm/
  settings.json
  epics/
  features/
  tasks/
  chores/
  issues/
  history/
  index/
  search/
  extensions/
  locks/
```

## Repository Structure

```text
src/
  cli/
    main.ts
    commands/
  core/
    fs/
    history/
    item/
    lock/
    output/
    store/
  types/
tests/
  unit/
  integration/
scripts/
  install.sh
  install.ps1
  run-tests.mjs
docs/
  ARCHITECTURE.md
  EXTENSIONS.md
.pi/
  extensions/
    pm-cli/
.github/workflows/
  ci.yml
  nightly.yml
```

## Developer Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Internal architecture, source layout, mutation contract, history/restore, search, and testing.
- [docs/EXTENSIONS.md](docs/EXTENSIONS.md) — Extension development guide: manifest format, API reference, hook lifecycle, built-in extensions.

## Item File Format

Each item is stored as `<id>.md` under the folder matching its type:

- `Epic` -> `epics/`
- `Feature` -> `features/`
- `Task` -> `tasks/`
- `Chore` -> `chores/`
- `Issue` -> `issues/`

Format:

1. JSON front-matter object (not YAML)
2. blank line
3. optional markdown body

## Commands

### Core (implemented in v0.1)

- `pm init [PREFIX]`
- `pm install pi [--project|--global]` (install bundled Pi extension to `<project-root>/.pi/extensions/pm-cli/index.ts`, where `project-root` is derived from `--path` when provided, otherwise current working directory; global scope uses `PI_CODING_AGENT_DIR/extensions/pm-cli/index.ts`)
- `pm list` (excludes terminal statuses `closed`/`canceled` by default — the active working-set view), `pm list-all` (all statuses including terminal)
- `pm list-draft`, `pm list-open`, `pm list-in-progress`, `pm list-blocked`, `pm list-closed`, `pm list-canceled`
- `pm get <ID>`
- `pm search <keywords>` (keyword + semantic + hybrid modes; `--include-linked` expands keyword/hybrid lexical scoring with linked content)
- `pm search` shared filters enforce canonical values: `--type` must be `Epic|Feature|Task|Chore|Issue` and `--priority` must be an integer `0..4`
- `pm search --limit 0` returns a deterministic empty result set (after mode/config validation) without embedding/vector query execution
- `pm reindex` (keyword/semantic/hybrid cache artifact rebuild; semantic/hybrid perform provider embedding generation + vector upsert)
- `pm history <ID>`, `pm activity [--limit]`
- `pm restore <ID> <TIMESTAMP|VERSION>`
- `pm config <project|global> set definition-of-done --criterion <text>`
- `pm config <project|global> get definition-of-done`
- `pm create`, `pm update <ID>`, `pm append <ID>`, `pm close <ID> <TEXT>`, `pm delete <ID>`
- `pm claim <ID>`, `pm release <ID>`
- `pm comments <ID>`
- `pm files <ID>`, `pm test <ID>`, `pm docs <ID>`
- `pm test-all`
- `pm stats`
- `pm health`
- `pm gc`
- `pm beads import [--file <path>]` (built-in Beads extension command, import-only)
- `pm todos import [--folder <path>]` (built-in todos extension command)
- `pm todos export [--folder <path>]` (built-in todos extension command)
- `pm completion <bash|zsh|fish>` (generate shell tab-completion script)
- extension-only command paths return not-found when no handler is registered, and generic failure when a matched handler throws; profile diagnostics include deterministic warning codes like `extension_command_handler_failed:<layer>:<name>:<command>`
- extension command names are canonicalized (trimmed, lowercased, repeated internal whitespace collapsed) before registration and dispatch so equivalent command paths resolve deterministically
- `pm test <ID> --add` rejects linked commands that invoke `pm test-all` (including global-flag and package-spec launcher forms like `pm --json test-all`, `npx pm-cli@latest --json test-all`, `pnpm dlx pm-cli@latest --json test-all`, and `npm exec -- pm-cli@latest --json test-all`) to prevent recursive orchestration
- `pm test <ID> --run` skips legacy linked commands that invoke `pm test-all` (including global-flag and package-spec launcher forms such as `npx`, `pnpm dlx`, and `npm exec` launcher variants) and reports deterministic skip diagnostics
- `pm test <ID> --add` rejects sandbox-unsafe test-runner commands (for example `pnpm test`, `pnpm test:coverage`, `npm test`, `npm run test`, `pnpm run test`, `yarn run test`, `bun run test`, `vitest`) unless they use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; chained direct test-runner segments are validated independently, so each direct runner segment must be explicitly sandboxed
- `pm test-all` deduplicates identical linked command/path entries per invocation (keyed by scope+normalized command or scope+path), reports duplicates as skipped, and uses the maximum `timeout_seconds` when duplicate keys disagree on timeout metadata

### `pm list` vs `pm list-all`

- `pm list` — active working-set view: excludes `closed` and `canceled` items by default. Useful for day-to-day use to see what needs attention.
- `pm list-all` — full inventory: includes all items regardless of status. Useful for auditing and historical review.

Both commands accept the same filter flags; `pm list` applies the terminal-status exclusion before any other filters.

### `pm list` filters

All `list*` commands accept these filter flags:

- `--type <value>` — `Epic|Feature|Task|Chore|Issue`
- `--tag <value>` — exact tag match (case-insensitive)
- `--priority <value>` — integer `0..4`
- `--deadline-before <value>` — ISO or relative deadline upper bound
- `--deadline-after <value>` — ISO or relative deadline lower bound
- `--assignee <value>` — exact match on `assignee` field; use `none` to filter for unassigned items
- `--sprint <value>` — exact match on `sprint` field
- `--release <value>` — exact match on `release` field
- `--limit <n>` — max items returned

### Roadmap (post-v0.1 / partial areas)

- semantic/hybrid search enhancements (advanced hybrid relevance tuning, incremental embedding refresh, adapter optimizations)
- Pi agent extension advanced ergonomics (higher-level workflow presets and additional tooling integrations)

### Global flags

- `--json` output JSON instead of TOON
- `--quiet` suppress stdout (errors still on stderr)
- `--path <dir>` override PM path for invocation
- `--no-extensions` disable extension loading
- `--profile` print timing diagnostics
- `--version` print CLI version

### `pm create` explicit-field contract

`pm create` accepts explicit flags for all schema fields (including optional ones) so callers can always pass complete intent:

- required scalar flags:
  - `--title/-t`
  - `--description/-d` (explicit empty allowed)
  - `--type`
  - `--status/-s`
  - `--priority/-p` (`0..4`)
  - `--tags` (explicit empty allowed)
  - `--body/-b` (explicit empty allowed)
  - `--deadline` (ISO, relative, or none)
  - `--estimate/--estimated-minutes/--estimated_minutes` (supports `0`)
  - `--acceptance-criteria`, `--acceptance_criteria`, `--ac` (explicit empty allowed)
  - `--author` (fallbacks still exist, but explicit is recommended)
  - `--message`
  - `--assignee` (explicit; use `none` to clear)
- optional scalar flags (use `none` to unset):
  - `--parent` (item ID reference)
  - `--reviewer`
  - `--risk` (`low|med|medium|high|critical`; `med` persists as `medium`)
  - `--confidence` (`0..100|low|med|medium|high`; `med` persists as `medium`)
  - `--sprint`
  - `--release`
  - `--blocked-by/--blocked_by` (item ID or free-text)
  - `--blocked-reason/--blocked_reason`
  - `--unblock-note/--unblock_note` (unblock rationale note)
  - `--reporter`
  - `--severity` (`low|med|medium|high|critical`; `med` persists as `medium`)
  - `--environment`
  - `--repro-steps/--repro_steps`
  - `--resolution`
  - `--expected-result/--expected_result`
  - `--actual-result/--actual_result`
  - `--affected-version/--affected_version`
  - `--fixed-version/--fixed_version`
  - `--component`
  - `--regression` (`true|false|1|0`)
  - `--customer-impact/--customer_impact`
  - `--definition-of-ready/--definition_of_ready` (explicit empty allowed)
  - `--order/--rank` (integer rank/order)
  - `--goal`
  - `--objective`
  - `--value`
  - `--impact`
  - `--outcome`
  - `--why-now/--why_now`
- required repeatable seed flags (pass each at least once; use `none` for explicit empty intent):
  - `--dep`
  - `--comment`
  - `--note`
  - `--learning`
  - `--file`
  - `--test`
  - `--doc`

Explicit unset behavior:

- scalar `none` means unset/omit that optional field
- repeatable seed value `none` means explicit empty list intent
- explicit unset intent is recorded in mutation history message metadata

### `pm update` explicit-field contract

`pm update <ID>` accepts explicit mutation flags for canonical front-matter fields:

- `--title/-t`
- `--description/-d`
- `--status/-s` (supports non-terminal values and `canceled`; use `pm close <ID> <TEXT>` for closure)
- `--priority/-p`
- `--type`
- `--tags`
- `--deadline`
- `--estimate/--estimated-minutes/--estimated_minutes`
- `--acceptance-criteria`, `--acceptance_criteria`, `--ac`
- `--assignee`
- `--parent`
- `--reviewer`
- `--risk` (`low|med|medium|high|critical`; `med` persists as `medium`)
- `--confidence` (`0..100|low|med|medium|high`; `med` persists as `medium`)
- `--sprint`
- `--release`
- `--blocked-by/--blocked_by`
- `--blocked-reason/--blocked_reason`
- `--unblock-note/--unblock_note`
- `--reporter`
- `--severity` (`low|med|medium|high|critical`; `med` persists as `medium`)
- `--environment`
- `--repro-steps/--repro_steps`
- `--resolution`
- `--expected-result/--expected_result`
- `--actual-result/--actual_result`
- `--affected-version/--affected_version`
- `--fixed-version/--fixed_version`
- `--component`
- `--regression` (`true|false|1|0`)
- `--customer-impact/--customer_impact`
- `--definition-of-ready/--definition_of_ready`
- `--order/--rank`
- `--goal`
- `--objective`
- `--value`
- `--impact`
- `--outcome`
- `--why-now/--why_now`
- `--author`
- `--message`
- `--force`

### Exit codes

- `0` success
- `1` generic failure
- `2` invalid usage/arguments
- `3` not found
- `4` conflict (lock/claim)
- `5` dependency failed (e.g. test-all failure)

## Output Modes

Default output is TOON (token-efficient, deterministic).  
Use `--json` for machine pipelines expecting JSON.

Examples:

```bash
pm list-open --limit 5
pm list-open --limit 5 --json
pm get pm-a1b2 --quiet; echo $?
```

## Configuration

Primary config: `.agents/pm/settings.json`

Typical keys:

- `id_prefix`
- `author_default`
- `locks.ttl_seconds`
- `output.default_format`
- `workflow.definition_of_done`
- `extensions.enabled / disabled`
- `search.score_threshold`
- `search.hybrid_semantic_weight`
- `search.max_results`
- `search.embedding_model`
- `search.embedding_batch_size`
- `search.scanner_max_batch_retries`
- `search.tuning` (optional object)
- provider + vector-store blocks

`search.score_threshold` defaults to `0` and applies mode-specific minimum-score filtering (`keyword` raw lexical score, `semantic` vector score, `hybrid` normalized blended score).
`search.hybrid_semantic_weight` defaults to `0.7` and controls hybrid semantic-vs-lexical blending (`0..1`).
`search.tuning` optionally overrides deterministic lexical weighting (`title_exact_bonus`, `title_weight`, `description_weight`, `tags_weight`, `status_weight`, `body_weight`, `comments_weight`, `notes_weight`, `learnings_weight`, `dependencies_weight`, `linked_content_weight`) for keyword mode and the hybrid lexical component; invalid/negative values fall back to defaults.
`workflow.definition_of_done` defaults to `[]` and stores deterministic team-level close-readiness criteria strings. The baseline config command surface is:

```bash
pm config project set definition-of-done \
  --criterion "tests pass" \
  --criterion "linked files/tests/docs present"

pm config project get definition-of-done
pm config global get definition-of-done --json
```

### Environment variables

- `PM_PATH` - project storage override
- `PM_GLOBAL_PATH` - global extension root override
- `PM_AUTHOR` - default mutation author

Precedence:

1. CLI flags
2. env vars
3. settings.json
4. defaults

## Search and Extension System

Keyword search is part of the implemented command surface, `pm search --include-linked` expands keyword scoring across readable linked docs/files/tests content while enforcing scope-root containment (`scope=project` and `scope=global` paths must stay within their allowed roots after both resolve-path and symlink-resolved-realpath checks; out-of-scope or realpath-escape paths are skipped), and `pm reindex` rebuilds deterministic keyword cache artifacts (`index/manifest.json` and `search/embeddings.jsonl`). Provider abstraction baseline is also in place for deterministic OpenAI/Ollama configuration resolution, request-target resolution (including OpenAI-compatible `base_url` normalization for root, `/v1`, and explicit `/embeddings` forms), provider-specific request payload/response normalization (including deterministic OpenAI data-entry index ordering), deterministic request-execution helper behavior, deterministic per-request normalized-input deduplication with output fan-out back to original input cardinality/order, and deterministic embedding cardinality validation (normalized input count must match returned vector count after dedupe expansion). Vector-store abstraction baseline is also in place for deterministic Qdrant/LanceDB configuration resolution, request-target planning, request payload/response normalization, deterministic Qdrant request-execution helper behavior, deterministic LanceDB local query/upsert/delete helper behavior, deterministic local snapshot persistence + reload across process boundaries, and deterministic query-hit ordering normalization (score descending with id ascending tie-break).

Command-path semantic/hybrid baseline is now implemented: `pm reindex --mode semantic|hybrid` generates provider embeddings for canonical item corpus records and upserts vectors to the active store, while `pm search --mode semantic|hybrid` executes vector-query ranking with deterministic hybrid lexical+semantic blending in hybrid mode. Semantic embedding generation runs in deterministic batches using `settings.search.embedding_batch_size`, and each embedding batch retries failures up to `settings.search.scanner_max_batch_retries` before surfacing deterministic warnings/errors. Keyword/hybrid lexical scoring includes a deterministic exact-title token boost (full-token title matches receive additive lexical bonus weight) plus configurable multi-factor lexical tuning through `settings.search.tuning` (`title_exact_bonus`, `title_weight`, `description_weight`, `tags_weight`, `status_weight`, `body_weight`, `comments_weight`, `notes_weight`, `learnings_weight`, `dependencies_weight`, `linked_content_weight`; invalid/negative values fall back to defaults). Search scoring also honors `settings.search.score_threshold` as a mode-aware minimum score filter (`keyword` raw lexical score, `semantic` vector score, `hybrid` normalized blended score), and hybrid blending weight is configurable with `settings.search.hybrid_semantic_weight` (`0..1`, default `0.7`). Successful item-mutation command paths now invalidate stale keyword cache artifacts (`index/manifest.json` and `search/embeddings.jsonl`) and perform best-effort semantic embedding refresh for affected item IDs when embedding-provider and vector-store configuration are available; missing/deleted affected IDs trigger best-effort vector pruning from the active store. Refresh failures degrade to deterministic warnings. Broader advanced semantic/hybrid relevance tuning remains roadmap work.

Built-in extension command handlers now provide import/export adapters: `pm beads import [--file <path>]` (import-only) ingests Beads JSONL records into PM items with deterministic defaults and `op: "import"` history entries, while `pm todos import|export [--folder <path>]` maps todos markdown files (JSON front-matter + body) to and from PM items using deterministic defaults for missing PM fields, preserves explicit imported IDs verbatim including hierarchical suffixes such as `pm-legacy.1.2`, and preserves canonical optional `ItemFrontMatter` metadata when present, including planning/workflow fields (`definition_of_ready`, `order`, `goal`, `objective`, `value`, `impact`, `outcome`, `why_now`, `reviewer`, `risk`, `confidence`, `sprint`, `release`, `blocked_by`, `blocked_reason`, `unblock_note`) and issue fields (`reporter`, `severity`, `environment`, `repro_steps`, `resolution`, `expected_result`, `actual_result`, `affected_version`, `fixed_version`, `component`, `regression`, `customer_impact`). `confidence`, `risk`, and `severity` aliases normalize deterministically (`med` -> `medium`). The Pi integration contract is provided as a Pi agent extension module at `.pi/extensions/pm-cli/index.ts`, which registers a `pm` tool for action-based invocations and returns `content` + `details` envelopes. Current Pi wrapper action coverage includes the v0.1 command-aligned set (`init`, `config`, `create`, `list`, `list-all`, `list-draft`, `list-open`, `list-in-progress`, `list-blocked`, `list-closed`, `list-canceled`, `get`, `search`, `reindex`, `history`, `activity`, `restore`, `update`, `close`, `delete`, `append`, `comments`, `files`, `docs`, `test`, `test-all`, `stats`, `health`, `gc`, `completion`, `claim`, `release`) plus extension aliases (`beads-import`, `todos-import`, `todos-export`) and workflow presets (`start-task`, `pause-task`, `close-task`). For create/update parity, the wrapper accepts camelCase counterparts for the canonical CLI scalar metadata surface, completion parity field `shell` (`action=completion` -> `pm completion <shell>`), workflow/planning fields (`parent`, `reviewer`, `risk`, `confidence`, `sprint`, `release`, `blockedBy`, `blockedReason`, `unblockNote`, `definitionOfReady`, `order`, `goal`, `objective`, `value`, `impact`, `outcome`, `whyNow`) and issue fields (`reporter`, `severity`, `environment`, `reproSteps`, `resolution`, `expectedResult`, `actualResult`, `affectedVersion`, `fixedVersion`, `component`, `regression`, `customerImpact`), and forwards them deterministically to the corresponding `pm create`/`pm update` flags. Runtime extension loading includes deterministic manifest discovery, settings-aware enable/disable filtering, global-to-project precedence, extension-entry sandbox enforcement (entry paths and resolved symlink targets must remain inside their extension directory), and failure-isolated imports. `pm health` extension checks run the same load/activation probe used at runtime, including enabled built-in extensions, and surface deterministic diagnostics for manifest/entry warnings plus load and activation failures (for example `extension_entry_outside_extension:<layer>:<name>`, `extension_load_failed:<layer>:<name>`, and `extension_activate_failed:<layer>:<name>`).

Hook lifecycle baseline includes `activate(api)` registration with deterministic ordering, registration-time hook handler validation (non-function payloads fail extension activation deterministically), per-hook context snapshot isolation so hook-side mutation cannot leak across callbacks or back into caller state, command-lifecycle `beforeCommand`/`afterCommand` execution with failure containment (including `afterCommand` dispatch on failed commands with `ok=false` and error context), and runtime read/write/index hook dispatch for core item-store reads/writes, create/restore item and history writes, settings read/write operations, history/activity history-directory scans and history-stream reads, health history-directory scans plus history-stream path dispatch, search item/linked reads, reindex flows, stats/health/gc command file-system paths (including `pm gc` onIndex dispatch with mode `gc` and deterministic cache-target totals), lock file read/write/unlink operations, init directory bootstrap ensure-write dispatch, and built-in beads/todos import-export source/item/history file operations.

Extension API baseline now includes deterministic command result override registration for existing core commands, command-handler registration for declared command paths (including built-in `beads import` and `todos import|export` paths plus extension-defined non-core command paths surfaced at runtime), command-handler execution with cloned `args`/`options`/`global` snapshots to prevent mutation leakage back into caller command state, command-override execution with cloned command `args`/`options`/`global` snapshots plus `pm_root` metadata and isolated prior-result snapshots, renderer execution with the same cloned command-context snapshots plus isolated result snapshots, renderer override registration for `toon`/`json` output formatting with safe fallback to built-in rendering on failures, and registration-time validation plus metadata capture for `registerFlags`, `registerItemFields`, `registerMigration`, `registerImporter`, `registerExporter`, `registerSearchProvider`, and `registerVectorStoreAdapter`. `registerImporter`/`registerExporter` registrations now also wire deterministic extension command-handler paths `<name> import` and `<name> export` (canonicalized with trim + lowercase + internal-whitespace collapse), and those handlers execute with the same isolated command-context snapshots as explicit `registerCommand` handlers. Dynamically surfaced extension command paths now include deterministic help sections derived from `registerFlags` metadata while preserving loose option parsing for runtime dispatch, with parser hardening that ignores unsafe prototype keys (`__proto__`, `constructor`, `prototype`) and uses null-prototype option maps before handing parsed options to extension handlers. Extension API and hook registration calls now enforce manifest capability declarations (`commands`, `renderers`, `hooks`, `schema`, `importers`, `search`) and fail activation deterministically when registrations exceed declared capabilities. Unknown capability names are ignored for registration gating and emit deterministic discovery diagnostics `extension_capability_unknown:<layer>:<name>:<capability>`. Activation diagnostics now include deterministic registration summaries for these registries, and health diagnostics include deterministic migration status summaries derived from registered migration definitions (`status=\"failed\"` -> failed, `status=\"applied\"` -> applied, otherwise pending). Core write command paths now enforce deterministic mandatory-migration blocking when registered migration definitions declare `mandatory=true` and status is not `applied` (case-insensitive), with explicit `--force` bypass support on force-capable write commands. Broader runtime wiring for other newly registered definitions remains tracked in `PRD.md`.

## Pi Agent Extension

`pm-cli` ships a Pi agent extension source module at `.pi/extensions/pm-cli/index.ts`.

Install it via `pm` (recommended):

```bash
# current project scope (default)
pm install pi

# explicit project scope
pm install pi --project

# global Pi scope (~/.pi/agent unless PI_CODING_AGENT_DIR is set)
pm install pi --global
```

Load it in Pi:

```bash
pi -e ./.pi/extensions/pm-cli/index.ts
```

Or place/copy it into a Pi auto-discovery folder such as `.pi/extensions/`.

The extension registers one tool, `pm`, with action-based parameters and returns:

- `content: [{ type: "text", text: "..." }]`
- `details: { ... }`

For search parity, wrapper parameters support `includeLinked` and map it to `pm search --include-linked`.
For project tracking access in Pi TUI, run Pi from the project root (so `pm` resolves the repo `.agents/pm`), or pass wrapper `path` to target another PM store.
For command-shape parity, explicit empty-string values are forwarded for empty-allowed flags (for example `--description ""` and `--body ""`) instead of being dropped.
For numeric-flag parity, wrapper parameters accept either JSON numbers or strings for `priority`, `estimate`, `limit`, and `timeout`, and stringify them before CLI invocation.
For claim/release parity, wrapper parameters `author`, `message`, and `force` are forwarded to `pm claim|release --author/--message/--force`.
For packaging resilience (implemented), the wrapper attempts `pm` first and falls back to `node <package-root>/dist/cli.js` when `pm` is unavailable.

## Shell Completion

`pm` supports tab-completion for bash, zsh, and fish shells.

### Bash

```bash
# Add to ~/.bashrc or ~/.bash_profile
eval "$(pm completion bash)"
```

### Zsh

```bash
# Add to ~/.zshrc
eval "$(pm completion zsh)"
```

### Fish

```bash
# Generate and save the completion file
pm completion fish > ~/.config/fish/completions/pm.fish
```

### JSON output

```bash
pm completion bash --json
# => { "shell": "bash", "script": "...", "setup_hint": "..." }
```

Completion covers all `pm` subcommands, their flags, and common argument values (item types, statuses, priorities, search modes, shell names).

## FAQ

### Why JSON front-matter instead of YAML?

Deterministic parsing/serialization and fewer parser ambiguities for agent tooling.

### Why TOON by default?

TOON reduces token usage and keeps structure predictable for LLM workflows.

### Can I use `pm` without semantic search?

Yes. Keyword mode is always available.

### Is a database required?

No for core tracking. Core is file-backed. Vector DB is optional for semantic search.

### Can I restore previous versions?

Yes. `pm` supports restoring an item to a prior state by timestamp or history version:

```bash
pm restore <ID> <TIMESTAMP|VERSION>
```

Restore replays append-only history to the target point, rewrites the item atomically, and appends a new `restore` history event.

## Troubleshooting

### Item not found

- Use normalized id and check:
  - `pm list-all --limit 100 --json`

### Command appears missing

- Check `pm --help` for the implemented command surface in this version.
- Confirm whether the command is listed under "Roadmap (post-v0.1 / partial areas)".

## Testing and Coverage Policy

- All tests must run with a sandbox `PM_PATH` (never the repository's real `.agents/pm`).
- PM-linked test execution should use `node scripts/run-tests.mjs <test|coverage> [-- <vitest args...>]` so both `PM_PATH` and `PM_GLOBAL_PATH` are sandboxed per run; forwarded args target Vitest directly (for example: `node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts`).
- `pm test <ID>` linked command entries must not invoke `pm test-all` (including global-flag and package-spec launcher forms like `pm --json test-all`, `npx pm-cli@latest --json test-all`, `pnpm dlx pm-cli@latest --json test-all`, and `npm exec -- pm-cli@latest --json test-all`); the CLI rejects recursive orchestration entries at add-time.
- `pm test <ID> --run` defensively skips legacy linked command entries that invoke `pm test-all` (including global-flag and package-spec launcher forms such as `npx`, `pnpm dlx`, and `npm exec` launcher variants) and reports deterministic skipped results.
- `pm test <ID>` linked test-runner command entries must use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; the CLI rejects sandbox-unsafe variants at add-time, including unsandboxed package-manager run-script forms like `npm run test` / `pnpm run test` and chained direct test-runner segments that are not explicitly sandboxed.
- `pm test-all` runs each unique linked command/path key once per invocation and marks duplicates as skipped for deterministic orchestration output; duplicate-key timeout conflicts resolve to the maximum `timeout_seconds` for that key.
- Integration tests spawn the built CLI (`node dist/cli.js ...`) with test-specific `PM_PATH`, `PM_GLOBAL_PATH`, and `PM_AUTHOR`.
- Coverage thresholds are enforced at `100%` for lines, branches, functions, and statements.
- `pm` project data in `.agents/pm` is reserved for living planning/logging only.

## Community and Governance Files

Release-ready repository baseline includes:

- `LICENSE` (MIT)
- `CHANGELOG.md` (Keep a Changelog + SemVer note + `[Unreleased]`)
- `CONTRIBUTING.md` (development and contribution workflow)
- `SECURITY.md` (security reporting policy)
- `CODE_OF_CONDUCT.md` (contributor behavior baseline)

## Release Readiness Checklist

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:coverage
node scripts/run-tests.mjs coverage
npm pack
```

Manual smoke checks:

- install packed tarball globally and run `pm --help`
- run `bash scripts/install.sh`
- run `pwsh scripts/install.ps1`

### Automated Release

Pushing a version tag triggers the automated npm publish workflow:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `.github/workflows/release.yml` workflow runs the full CI suite and publishes to npm when all checks pass. Requires `NPM_TOKEN` secret configured in the repository settings.

## Project Status

Release-hardening is active.
`PRD.md`, `AGENTS.md`, and this README define the current public and contributor contracts.
