# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
- `pm todos import` correctly preserves hierarchical IDs (e.g. `pm-legacy.1.2`) from todos front-matter verbatim.
- `pm todos import` correctly round-trips canonical optional metadata fields (planning/workflow and issue metadata).
- Pi extension packaged CLI fallback path resolves correctly from the package root.
- `pm search --mode semantic|hybrid --limit 0` short-circuits without executing provider embedding queries.
- Embedding provider request deduplication preserves correct output fan-out back to original input cardinality and order.
- LanceDB snapshot persistence correctly reloads across process boundaries.

## [0.1.0] - 2026-02-17

### Added
- Initial `pm-cli` v0.1.0 command surface and release-hardening baseline.
