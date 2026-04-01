# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added centralized command help narratives across core command paths (`Why use this command`, practical examples, and targeted tips) through a shared help composer.
- Added structured CLI error guidance rendering for commander usage failures and runtime `PmCliError` failures with deterministic sections (`What happened`, `What is required`, `Why`, `Examples`, optional `Next steps`).
- Added sparse default TOON rendering that emits command payloads directly and omits `null`/`undefined`/empty arrays/empty objects for token-efficient agent workflows while keeping `--json` payload compatibility.
- `list*` commands now accept `--include-body` to project item `body` into each returned row when needed for metadata completeness analysis.
- Added persistent item reminders via repeatable `--reminder at=<iso|relative>,text=<text>` support on `pm create` and `pm update` (including deterministic `none` clearing semantics).
- Added `pm calendar` (alias: `pm cal`) with deterministic `agenda` (default), `day`, `week`, and `month` views across deadlines and reminders, plus `--past` and range/filter options.
- Added `pm context` (alias: `pm ctx`) as an agent-first project snapshot command that combines deterministic high-level/low-level active work focus with agenda/reminder context, including blocked fallback when active work is empty.
- Added persistent item scheduled events via repeatable `--event` support on `pm create` and `pm update`, including one-off entries plus recurrence fields (`recur_freq`, `recur_interval`, `recur_count`, `recur_until`, `recur_by_weekday`, `recur_by_month_day`, `recur_exdates`) and deterministic `none` clearing semantics.
- Added bounded recurring occurrence expansion to `pm calendar` so recurring item events are materialized into agenda/day/week/month windows.
- Added calendar source and recurrence controls: `--include`, `--recurrence-lookahead-days`, `--recurrence-lookback-days`, and `--occurrence-limit`.
- Added resilient entry parsing for mutation `--add` and create/update repeatable seed flags: CSV `key=value`, markdown-style `key: value`, and `-` stdin-token ingestion are now supported with deterministic normalization.
- Added stdin token support for `pm append --body -` and structured comment ingestion for `pm comments --add` (plain text remains supported).
- Added runtime-configurable item type registry support: `settings.item_types.definitions` plus extension `registerItemTypes(...)` registrations now drive allowed type values, aliases, per-type required create fields/repeatables, option schemas, and type folder routing.
- Added `--type-option` / `--type_option` support on `pm create` and `pm update` for validated per-type metadata (`key=value` or `key=<name>,value=<value>`, with `none` clear semantics).
- Added per-type `command_option_policies` support (settings + extension item-type registrations) for `create`/`update` option-level `required`, `enabled`, and `visible` behavior controls.
- Added type-aware help policy sections for `pm create --help` / `pm update --help` when `--type <value>` is supplied, including required/disabled/hidden option summaries from active settings/extensions.
- Added extension-first command routing for deterministic core-command replacement when extension handlers register matching command paths.
- Added richer command lifecycle hook payload parity (`beforeCommand` / `afterCommand`) including command options, global options, and final command result context.
- Added live runtime wiring for extension search/vector selectors (`settings.search.provider`, `settings.vector_store.adapter`) in `pm search` and `pm reindex`.
- Added extension item-field default/validation wiring on create/update write paths from `registerItemFields(...)`.
- Added stable SDK package exports at `@unbrained/pm-cli/sdk` with public extension type contracts and `defineExtension(...)` helper.
- Added Ollama-aware semantic auto-default resolution for `pm search`/`pm reindex` when semantic settings are unset and local Ollama is installed, including compatibility-safe fallback to keyword mode for implicit default search when auto semantic execution fails.
- Added `pm health` history drift diagnostics (`history_drift`) that detect missing/unreadable history streams and item/hash mismatches against latest history `after_hash`.
- Added `pm health` vectorization diagnostics (`vectorization`) with targeted stale-ID semantic refresh and deterministic vectorization ledger tracking (`search/vectorization-status.json`).

### Changed
- Commander error output now emits a single high-signal structured guidance payload (duplicate default commander stderr lines are suppressed).
- `pm comments` now accepts optional positional text shorthand (`pm comments <ID> "<text>"`) as an intuitive alias for `--add <text>`, and tolerates bare `--author` by falling back to existing author resolution (`PM_AUTHOR` -> settings default -> `unknown`).
- Default `list*` output remains front-matter-only; `body` projection is now explicit and opt-in via `--include-body` to preserve lightweight list payloads.
- Calendar command output now defaults to markdown for agent/human readability while preserving explicit `--format toon|json|markdown` and global `--json` overrides; all other commands keep existing TOON-default behavior.
- Calendar markdown summaries now include scheduled-event counts and event rendering includes recurring/location metadata where present.
- Mutation parsing errors for entry-style flags now include actionable format guidance and explicit stdin-token usage hints to reduce malformed-input retries.
- Type validation/filtering/completion now resolve from the runtime registry across create/update/list/search/calendar/completion/init/health/storage paths while preserving built-in defaults when no custom type config exists.
- Commander required-option UX for missing `--type` now includes rationale, active allowed values, and concrete fix examples.
- Dynamic extension command help now supports `registerFlags` policy metadata (`required`, `enabled`, `visible`) with additive markers and hidden-flag suppression.
- Search and reindex semantic execution now supports extension provider/adapter primary paths with deterministic fallback to built-in provider/vector configuration when available.
- `pm reindex --mode semantic|hybrid` now rewrites `search/vectorization-status.json` to keep health-time vector freshness checks synchronized with indexed corpus state.
- Date/deadline parsing now accepts month-relative offsets (`+6m`) and normalized date-string variants (for example `2026-03-31T13-59` and `20260331T135900Z`) across deadline, reminder, event, list/search filter, and calendar date inputs while preserving canonical ISO persistence.
- `pm beads import --file -` now fails fast when stdin is an interactive TTY and returns explicit piped-input/EOF guidance instead of waiting for manual stream termination.
- CLI top-level error handling now preserves canonical exit-code mapping via graceful `process.exitCode` semantics to reduce buffered output truncation risk in emulated terminal environments.
- Linked test runtime execution now closes child stdin for non-interactive runs and appends deterministic timeout/maxBuffer diagnostics when subprocess execution fails.

## [2026.3.12] - 2026-03-12

### Changed

#### Release Versioning and Distribution
- npm package identity switched to scoped publish target `@unbrained/pm-cli` to avoid naming collisions with existing unscoped packages while keeping the `pm` executable unchanged.
- Versioning policy now follows calendar SemVer-compatible releases: `YYYY.M.D` for the first release of a day and `YYYY.M.D-N` for subsequent same-day releases (`N >= 2`).
- Installer defaults now target `@unbrained/pm-cli` while preserving `PM_CLI_PACKAGE` override support for local/tarball smoke tests.

#### CI/CD and Release Guardrails
- Added automated version policy enforcement script (`scripts/release-version.mjs`) with tag/version consistency checks and registry-aware same-day release sequencing.
- Added tracked-file credential leak scanner (`scripts/check-secrets.mjs`) and wired it into CI/release gates.
- Added packaged `npx` smoke test (`scripts/smoke-npx-from-pack.mjs`) to verify tarball executability before release publish.
- Release workflow now uses the GitHub `release` Environment, validates version sequencing before publish, and creates a GitHub Release with generated notes after npm publish.

#### CLI UX
- `pm list` now excludes terminal statuses (`closed`, `canceled`) by default, showing only the active working-set of items. Use `pm list-all` to include all items regardless of status. This aligns with common CLI conventions (analogous to `docker ps` vs `docker ps -a`) and makes `pm list` the intuitive day-to-day view without having to type `pm list-open` or filter manually. `pm list-all` is unchanged and continues to return all items.

### Added

#### CI and Release Automation
- Automated npm publish workflow (`.github/workflows/release.yml`) triggered on `v*.*.*` version tags: runs full build, typecheck, test, and coverage suite before publishing to npm; requires `NPM_TOKEN` secret.
- npm provenance attestation enabled (`--provenance` on `npm publish`) linking each release to its source commit and build pipeline via Sigstore; consumers can verify supply chain integrity and npm shows a Provenance badge.
- Node 24 added to CI matrix (`ci.yml` and `nightly.yml`) ensuring forward compatibility with the Node 24 LTS line.
- Node 25 (current release) added to nightly CI matrix for early forward-compatibility detection.
- Dependabot configured (`.github/dependabot.yml`) for weekly npm and GitHub Actions dependency updates.

#### Developer Documentation
- `docs/ARCHITECTURE.md` — comprehensive internal architecture guide covering source tree, item storage, mutation contract, history/restore, extension system, search architecture, and testing.
- `docs/EXTENSIONS.md` — extension development guide covering manifest format, full `ExtensionApi` reference, lifecycle hooks, built-in extensions, and a minimal example.
- `docs/**` added to `package.json` `files` allowlist so documentation ships with the npm package.
- README links to new `docs/` guides from the Repository Structure section.

#### Community and npm Package Hygiene
- `package.json` now includes `repository`, `bugs`, `homepage`, and `author` fields for proper npm page display and discoverability.
- Keywords expanded: added `ai`, `git-native`, `task-tracker`, `coding-agents`.
- GitHub issue templates added (`.github/ISSUE_TEMPLATE/bug-report.yml` and `feature-request.yml`) for structured bug reports and feature requests.
- Pull request template added (`.github/PULL_REQUEST_TEMPLATE.md`) to guide contributors through the checklist including pm item links, test evidence, and docs updates.

#### Shell Completion
- `pm completion bash` — outputs a bash tab-completion script. Source it or add `eval "$(pm completion bash)"` to `~/.bashrc`.
- `pm completion zsh` — outputs a zsh tab-completion script. Add `eval "$(pm completion zsh)"` to `~/.zshrc`.
- `pm completion fish` — outputs a fish tab-completion script. Pipe to `~/.config/fish/completions/pm.fish`.
- `pm completion <shell> --json` — returns structured `{ shell, script, setup_hint }` for programmatic use.
- Completion covers all subcommands, global flags, list filters (`--type`, `--assignee`, `--sprint`, `--release`, `--priority`, etc.), search modes, item types, statuses, priorities, and shell names.

#### List Command Filters
- `--assignee <value>` filter for all `list*` commands — exact match on `assignee` field; use `none` to filter for unassigned items.
- `--sprint <value>` filter for all `list*` commands — exact match on `sprint` field.
- `--release <value>` filter for all `list*` commands — exact match on `release` field.

#### Core CLI Commands
- Full command surface: `init`, `create`, `get`, `update`, `append`, `close`, `delete`, `claim`, `release`, `list`, `list-all`, `list-draft`, `list-open`, `list-in-progress`, `list-blocked`, `list-closed`, `list-canceled`, `comments`, `files`, `docs`, `test`, `test-all`, `stats`, `health`, `gc`, `history`, `activity`, `restore`, `search`, `reindex`.
- `pm config <project|global> set definition-of-done --criterion <text>` and `pm config <project|global> get definition-of-done` for team-level Definition of Done criteria management.
- `pm beads import [--file <path>]` built-in Beads JSONL import command (extension-packaged).
- `pm todos import [--folder <path>]` and `pm todos export [--folder <path>]` built-in todos markdown import/export commands (extension-packaged).

#### Item Schema
- Canonical front-matter schema with required fields: `id`, `title`, `description`, `type`, `status`, `priority`, `tags`, `created_at`, `updated_at`.
- Full optional metadata surface: `deadline`, `assignee`, `author`, `estimated_minutes`, `acceptance_criteria`, `definition_of_ready`, `order`, `goal`, `objective`, `value`, `impact`, `outcome`, `why_now`, `parent`, `reviewer`, `risk`, `confidence`, `sprint`, `release`, `blocked_by`, `blocked_reason`, `unblock_note`.
- Issue-specific metadata fields: `reporter`, `severity`, `environment`, `repro_steps`, `resolution`, `expected_result`, `actual_result`, `affected_version`, `fixed_version`, `component`, `regression`, `customer_impact`.
- Deterministic key ordering and stable canonical serialization across all item mutations.
- `tags` sorted lexicographically and deduplicated on every write.
- `risk`/`severity`/`confidence` accept `med` alias normalizing to stored `medium`.
- `regression` accepts `true|false|1|0` boolean inputs.
- Linked arrays (`dependencies`, `comments`, `notes`, `learnings`, `files`, `tests`, `docs`) all have deterministic sort orders.
- Relative deadline inputs (`+6h`, `+1d`, `+2w`) resolved to absolute ISO timestamps at write time.
- Sentinel value `none` (case-insensitive) for any scalar option unsets/omits the field and records intent in history.

#### `pm create` Flags
- All schema fields passable explicitly: required seed flags (`--dep`, `--comment`, `--note`, `--learning`, `--file`, `--test`, `--doc`); `--ac`/`--acceptance-criteria`/`--acceptance_criteria` alias; `--estimate`/`--estimated-minutes`/`--estimated_minutes` alias; snake_case aliases for all hyphenated flags.
- `--unblock-note`/`--unblock_note` for recording unblock rationale.
- Issue metadata flags: `--reporter`, `--severity`, `--environment`, `--repro-steps`, `--resolution`, `--expected-result`, `--actual-result`, `--affected-version`, `--fixed-version`, `--component`, `--regression`, `--customer-impact`.
- Planning/workflow flags: `--parent`, `--reviewer`, `--risk`, `--confidence`, `--sprint`, `--release`, `--blocked-by`, `--blocked-reason`, `--definition-of-ready`, `--order`/`--rank`, `--goal`, `--objective`, `--value`, `--impact`, `--outcome`, `--why-now`.

#### `pm update` Flags
- All `pm create` optional fields also supported on `pm update`, including `--title`/`-t` and `--ac` aliases.
- `--type` mutation support for changing item type after creation.
- `--status closed` rejected with clear error directing callers to `pm close <ID> <TEXT>`.

#### History and Restore
- Append-only RFC6902 patch history per item in `.agents/pm/history/<id>.jsonl`.
- SHA-256 before/after hash chain per history entry for integrity verification.
- `pm history <ID> [--limit]` and `pm activity [--limit]` commands.
- `pm restore <ID> <TIMESTAMP|VERSION>` replays history to exact target state and appends a `restore` history event.
- Hash verification on restore with loud failure on mismatch.

#### Concurrency and Safety
- Lock-file (`locks/<id>.lock`) with TTL-based stale detection and PID/owner/timestamp metadata.
- Atomic writes via temp-file + rename for all item mutations.
- Claim/release ownership model with conflict exit code `4`.
- `--force` for stale-lock steal and terminal-status claim override.
- Conflict guard for mutations against items owned by another assignee.

#### Search
- `pm search <keywords>` in keyword, semantic, and hybrid modes with deterministic ordering.
- `--include-linked` flag expands keyword/hybrid lexical corpus with linked docs/files/tests content; scope-root containment enforced with both resolved-path and symlink-realpath checks.
- `--limit 0` returns a deterministic empty result without executing provider embedding queries.
- Deterministic exact-title token lexical boost for keyword and hybrid lexical component.
- Configurable multi-factor lexical tuning via `search.tuning` settings object (`title_exact_bonus`, `title_weight`, `description_weight`, `tags_weight`, `status_weight`, `body_weight`, `comments_weight`, `notes_weight`, `learnings_weight`, `dependencies_weight`, `linked_content_weight`).
- `search.score_threshold` for mode-aware minimum score filtering (default `0`).
- `search.hybrid_semantic_weight` for configurable semantic-vs-lexical blend in hybrid mode (default `0.7`).
- `pm reindex` rebuilds deterministic keyword cache artifacts (`index/manifest.json`, `search/embeddings.jsonl`); `--mode semantic|hybrid` generates embeddings and upserts to the active vector store.
- Embedding provider abstraction for OpenAI-compatible and Ollama providers with deterministic per-request input deduplication, cardinality validation, configurable batch sizing (`search.embedding_batch_size`), and per-batch retry semantics (`search.scanner_max_batch_retries`).
- Vector store adapter abstraction for Qdrant and LanceDB with deterministic snapshot persistence + reload across process boundaries, query-hit ordering (score desc, id asc tie-break), and upsert/delete operations.
- Mutation-triggered stale keyword artifact invalidation and best-effort semantic embedding refresh for affected item IDs (including vector pruning for deleted items).

#### Extension System
- Global (`~/.pm-cli/extensions`) and project (`.agents/pm/extensions`) extension directories with deterministic load order and project-over-global precedence.
- Extension manifest with capability declarations (`commands`, `renderers`, `hooks`, `schema`, `importers`, `search`); registrations outside declared capabilities fail activation deterministically.
- `api.registerCommand`, `api.registerRenderer`, `api.registerFlags`, `api.registerItemFields`, `api.registerMigration`, `api.registerImporter`, `api.registerExporter`, `api.registerSearchProvider`, `api.registerVectorStoreAdapter` registration surface.
- `api.registerImporter`/`api.registerExporter` auto-wire `<name> import`/`<name> export` extension command paths with isolated handler execution.
- Hook lifecycle: `beforeCommand`, `afterCommand`, `onWrite`, `onRead`, `onIndex` with per-hook context snapshot isolation and failure containment.
- Command result override and renderer override with cloned context snapshots to prevent mutation leakage.
- Dynamically surfaced extension command paths include help metadata derived from `registerFlags` definitions.
- Mandatory migration blocking: `mandatory=true` migrations with non-applied status block write commands (bypassable with `--force` on force-capable commands).
- Extension entry paths enforced to remain within extension directory via symlink-resolved realpath check.
- Loose-option parser hardening: null-prototype option maps and prototype key rejection (`__proto__`, `constructor`, `prototype`).
- `pm health` reports extension load/activation diagnostics and migration status summaries.

#### Built-in Extensions
- Built-in Beads import: maps Beads JSONL records to PM items with deterministic defaults and `op: "import"` history entries.
- Built-in todos import/export: round-trips todos markdown (JSON front-matter + body) with deterministic field defaults, canonical optional metadata preservation (planning/workflow and issue fields), hierarchical ID preservation (e.g. `pm-legacy.1.2`), and `med` alias normalization.
- Built-in Pi agent extension at `.pi/extensions/pm-cli/index.ts`: registers a `pm` tool with full v0.1 action dispatch parity, camelCase wrapper parameters for all canonical scalar metadata, explicit empty-string passthrough for empty-allowed flags, numeric-flag stringification, claim/release parameter forwarding, and packaged CLI fallback (`node <package-root>/dist/cli.js` when `pm` is unavailable).

#### Safety Guardrails for Linked Tests
- `pm test <ID> --add` rejects entries invoking `pm test-all` (including `npx`, `pnpm dlx`, `npm exec` launcher forms) to prevent recursive orchestration loops.
- `pm test <ID> --run` defensively skips legacy `pm test-all` entries and reports deterministic skip diagnostics.
- `pm test <ID> --add` rejects sandbox-unsafe test-runner commands (`npm run test`, `pnpm run test`, `yarn run test`, `bun run test`, `vitest` direct runners) unless explicitly sandboxed with `node scripts/run-tests.mjs ...` or both `PM_PATH` and `PM_GLOBAL_PATH`.
- `pm test-all` deduplicates linked entries per run (keyed by scope + normalized command or scope + path); duplicate-key timeout conflicts resolve to the maximum `timeout_seconds`.

#### Tooling and CI
- TypeScript source with ESM modules and `tsc` compilation; strict null checks and no implicit any.
- Vitest test suite (52 files, 473 tests) with 100% lines/branches/functions/statements coverage gate enforced in CI.
- Sandboxed test runner `scripts/run-tests.mjs` creates a temporary directory, sets both `PM_PATH` and `PM_GLOBAL_PATH`, runs the requested Vitest command, and cleans up afterward.
- CI matrix across Ubuntu, macOS, and Windows on Node 20; additional Ubuntu run on Node 22.
- Nightly validation workflow for Node 20 and 22.
- Installer scripts `scripts/install.sh` (Linux/macOS) and `scripts/install.ps1` (Windows PowerShell) with idempotent update flows and post-install `pm --version` verification.
- npm packaging allowlist (`files` in `package.json`) and `prepublishOnly` build guard.
- Repository governance baseline: `LICENSE` (MIT), `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.

### Changed
- `pm create` and `pm update` explicit-field contracts expanded to cover all optional schema fields so callers can always pass complete intent without relying on defaults.
- Documentation contracts (`PRD.md`, `README.md`, `AGENTS.md`) fully updated to cover all implemented command surfaces, schema fields, extension API, safety guardrails, and contributor workflow.

### Fixed
- Status parsing now accepts `in-progress` and normalizes to canonical `in_progress` across `pm create`, `pm update`, `pm calendar`, and `pm test-all` filters.
- Item/front-matter and built-in import normalization now resolve `in-progress` to `in_progress` to avoid validation failures while preserving deterministic stored status values.
- `pm todos import` correctly preserves hierarchical IDs (e.g. `pm-legacy.1.2`) from todos front-matter verbatim.
- `pm todos import` correctly round-trips canonical optional metadata fields (planning/workflow and issue metadata).
- Pi extension packaged CLI fallback path resolves correctly from the package root.
- `pm search --mode semantic|hybrid --limit 0` short-circuits without executing provider embedding queries.
- Embedding provider request deduplication preserves correct output fan-out back to original input cardinality and order.
- LanceDB snapshot persistence correctly reloads across process boundaries.

## [0.1.0] - 2026-02-17

### Added
- Initial `pm-cli` v0.1.0 command surface and release-hardening baseline.
