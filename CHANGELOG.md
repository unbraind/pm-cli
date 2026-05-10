# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2026.5.10] - 2026-05-10

### Changed
- Added top-level `ok` fields to `pm test --run --json` and `pm test-all --json` so agents can gate linked-test execution without parsing every result row.
- Capped and truncated semantic reindex embedding payloads for local Ollama providers, with adaptive timeout splitting, to avoid full-corpus reindex failures on large item bodies.

## [2026.5.6] - 2026-05-06

### Changed
- Hardened daily auto-release publishing so a newly pushed tag dispatches and waits for the tag-aware Release workflow, avoiding `GITHUB_TOKEN` push-trigger suppression.
- Clarified GitHub-hosted Sentry issue-threshold gating so release uploads can use CI-scoped Sentry tokens while issue-read checks require `SENTRY_PERSONAL_ADMIN_TOKEN`.
- Made the Release workflow retry-safe after partial publication by skipping `npm publish` when the target version already exists and by passing the explicit release tag to GitHub Release creation.

### Fixed
- Stabilized the linked-test timeout regression on Windows runners by keeping bounded-completion coverage while allowing slower process teardown.
- Fixed telemetry queue flushing to preserve events appended while another flush is in flight on Windows runners.

## [2026.5.5] - 2026-05-05

### Added
- Added mixed-frontmatter compatibility coverage to the release gate so previous-version `json_markdown` workspaces with YAML wrappers before JSON item data are migrated in a temp project before release.
- Added `--repair` to bundled install scripts to clear stale global `pm` shims before reinstalling from the npm registry.

### Changed
- Hardened release post-publish verification so npm/npx/bunx checks run from a clean temp directory and fail the release workflow if package execution does not converge.
- Hardened the daily auto-release pipeline so `.agents/pm`-only tracker commits are ignored for publish eligibility, preventing post-release tracker closure from creating a package-only release.
- Hardened the Sentry/telemetry release gate so GitHub runners use portable token-based Sentry API checks instead of host-local wrappers, with clearer captured-output diagnostics on gate failures.
- Documented npm registry installs as the supported global update path and added recovery guidance for broken git-sourced global installs.

### Fixed
- Fixed item-format migration to ignore leading YAML wrappers before JSON front matter, continue past unreadable item files with deterministic warnings, and avoid writing `item_format` settings before migration completes.

## [2026.5.4] - 2026-05-04

### Changed
- Relaxed release workflow npx/bunx post-publish checks to emit warnings instead of hard-failing the pipeline when registry/executor convergence lags, while keeping npm publication metadata as a blocking verification gate.

## [2026.5.3-8] - 2026-05-03

### Changed
- Updated release workflow npx verification to run the explicit package binary command (`npx @unbrained/pm-cli@<version> pm --version`) to avoid npm exec binary resolution drift on GitHub-hosted runners.

## [2026.5.3-7] - 2026-05-03

### Changed
- Updated release post-publish verification commands to execute the package `pm` binary explicitly (`npm exec --package ... -- pm --version` and `bunx ... pm --version`) and parse terminal line output robustly.

## [2026.5.3-6] - 2026-05-03

### Changed
- Added npm/npx/bunx propagation retries to release publication verification so post-publish checks wait for registry availability instead of failing immediately on transient 404 windows.

## [2026.5.3-5] - 2026-05-03

### Changed
- Hardened release workflow reliability gating so Sentry threshold checks are skipped when the runner does not provide the `sentry` CLI binary, preventing false-negative publish blocks on GitHub-hosted runners.

## [2026.5.3-4] - 2026-05-03

### Changed
- Relaxed tag release version policy guard in `.github/workflows/release.yml` to validate tag/version consistency without blocking same-day retry tags when a previous tag run failed before npm publication.
- Hardened `scripts/release/run-release-pipeline.mjs` same-day retry version resolution so local retry cuts always advance beyond the currently checked-out package version when npm has not yet observed failed prior tags.

## [2026.5.3-3] - 2026-05-03

### Fixed
- Relaxed release compatibility health evaluation so compatibility gating only blocks on failing health checks, not warning-only health states, preventing false negatives on GitHub-hosted release runs.

## [2026.5.3-2] - 2026-05-03

### Added
- Added a scheduled auto-release workflow (`.github/workflows/auto-release.yml`) with one-release-per-UTC-day defaults, manual same-day override controls, and a shared release pipeline driver.
- Added release automation scripts under `scripts/release/` for changelog promotion, strict static quality checks, temporary-project backward-compatibility validation, Sentry/telemetry threshold gating, unified release gate execution, and full local pipeline orchestration.
- Added release automation contract coverage in `tests/integration/release-automation-contract.spec.ts`.

### Changed
- Hardened CI, nightly, and release workflows with explicit static quality and compatibility migration gates.
- Release workflow now verifies published package availability via npm, npx, and bunx, and verifies GitHub release metadata after publication.
- Expanded release-readiness runtime checks to cover new release scripts, package commands, and auto-release workflow presence.

## [2026.5.3] - 2026-05-03

### Added
- Added progressive `pm context` depth, section, activity, staleness, and agenda controls so agents can request brief, standard, deep, or focused project snapshots without broad list scans.
- Added detailed CLI telemetry error classification for failed command finishes, including normalized `error_code`, `error_category`, and exit-code metadata for telemetry and local OTLP spans.
- Added regression coverage for bootstrap argument parsing, telemetry classification, Sentry helper filtering, migration gates, context output, and front-matter cache behavior.

### Changed
- Decomposed `src/cli/main.ts` from ~5800 lines into modular command registration files: `register-setup.ts`, `register-list-query.ts`, `register-mutation.ts`, `register-operations.ts`, and shared `registration-helpers.ts`, reducing main.ts to ~2550 lines while preserving all command behavior and help text.
- Centralized command argument parsing and command registration helpers to reduce CLI surface drift across help, contracts, completion, and runtime telemetry paths.
- Centralized shared HTTP request handling for embeddings and vector-store providers, reducing duplicated semantic search transport logic.
- Changed the built-in telemetry capture default from `max` to `redacted` so new installs preserve agent reliability diagnostics without sending local paths or personal identifiers by default.
- Hardened CI, nightly, and release workflows around the sandboxed test harness and release readiness contracts while preserving the free GitHub Actions release path.

### Fixed
- Hardened Sentry filtering so expected handled CLI usage/validation errors are logged as structured usage signals without reopening Sentry exception groups, while unexpected failures still capture normally.
- Hardened `pm normalize` closed-item backfill so it satisfies resolution metadata requirements without duplicating potentially sensitive `close_reason` text into new tracked fields.

### Performance
- Added persistent on-disk front-matter cache (`src/core/store/front-matter-cache.ts`) for `listAllFrontMatter` operations, using mtime+size fingerprinting for incremental refresh and context-fingerprint-based invalidation when preferred format or schema changes. Warm `list-open` drops from full-scan to ~60ms for 636-item corpora.

### Security
- Hardened telemetry and Sentry scrubbing so emails, private IPs, absolute local paths, bearer values, and inline credential assignments are redacted even when higher-detail telemetry capture is explicitly selected.
- Redacted sensitive infrastructure details from tracked project metadata and kept production telemetry/Sentry release audit notes in the ignored private operations area.

## [2026.5.2] - 2026-05-02

### Changed
- Reworked the README and public docs into progressive, agent-oriented pages with GitHub-compatible links and `pm` tracker cross-references.
- Hardened Sentry signal quality by suppressing expected handled `PmCliError` usage/validation failures while retaining unexpected exception capture.
- Added optional token-gated Sentry release and sourcemap upload to the free GitHub release workflow so published CLI stack traces can resolve source context when Sentry credentials are configured.
- Updated generated GitHub release notes so closed release-tagged `pm` evidence remains visible after the release item is completed.

### Security
- Kept private operations material out of public docs and package output; local production operations artifacts remain ignored by git.

## [2026.5.1-2] - 2026-05-01

### Fixed
- Pinned direct runtime and development dependency ranges instead of publishing `latest` specifiers, including `undici@^8.1.0`, so installs are deterministic and GitHub Dependabot evaluates the manifest against a non-vulnerable patched range.

## [2026.5.1] - 2026-05-01

### Fixed
- Fixed first-mutation compatibility for trackers created by `@unbrained/pm-cli@2026.3.12`: legacy settings that omit `item_format` now auto-select the current default format and run the existing pre-mutation item-file migration instead of blocking writes, preserving existing items, linked artifacts, comments, close metadata, and history integrity.
- Fixed npm package repository metadata so provenance publishing validates against the canonical `unbraind/pm-cli` GitHub source repository.

### Added
- Added `scripts/generate-release-notes.mjs` and `pnpm release:notes` to generate GitHub release notes from `CHANGELOG.md` plus sanitized `pm` tracker metadata.

### Changed
- Release workflow now checks out full git history for tag discovery, uploads generated release-note artifacts, and publishes the generated `CHANGELOG.md` + `pm` tracker release body to GitHub Releases without requiring paid GitHub features.

### Added
- Added `Decision` as a built-in item type with `decisions/` folder mapping, completion support, and stats coverage.
- Added structured `close_through_update` error context with actionable `pm close` examples when users attempt `pm update --status closed`.
- Added audit flag recommendations (`--allow-audit-update`, `--allow-audit-dep-update`, `--allow-audit-comment`) to ownership conflict error guidance as non-force alternatives.
- Added lifecycle dependency-cycle diagnostics to `pm validate` with deterministic cycle counts/sample paths and configurable `--dependency-cycle-severity off|warn|error` policy.
- Added extension scaffold lifecycle action (`pm extension --init`, alias `--scaffold`) that generates idempotent starter extension projects with manifest, entrypoint, and quick-start guidance.
- Added `pm normalize` lifecycle metadata governance workflow with deterministic dry-run planning (default), explicit `--apply` mode, list-style filter targeting, and ownership-safe apply controls (`--allow-audit-update`, `--force`).

### Changed
- Bumped `pnpm/action-setup` from v5 to v6 in all CI/release/nightly workflows (pnpm v11 support).
- Bumped `softprops/action-gh-release` from v2 to v3 in release workflow (Node 24 runtime).
- Bumped `undici`, `@types/node`, `@vitest/coverage-v8`, `vitest`, and `typescript` to latest.
- Updated SDK/extension docs to explicitly cover `cli-contracts` public exports, capability contract constants, inline command flag schema capability requirements, and importer/exporter capability gating parity.
- Clarified templates command name binding in help/docs (`pm templates save <name>`, `pm templates show <name>`), including explicit guidance that `--name` is unsupported.
- Improved calendar usage guidance when `--full-period` is used with `--view agenda` by recommending `--from`/`--to` bounded windows in both runtime error text and help tips.
- Improved calendar UX ergonomics by accepting `today` for `--date`/`--from`/`--to` boundaries and by adding explicit recurrence delimiter guidance for malformed `--event` CSV payloads.
- Improved implicit Ollama hybrid search latency by bounding semantic timeout windows and emitting deterministic warning codes when auto-defaulted semantic execution falls back to keyword mode.
- Improved extension doctor load diagnostics with targeted warning codes and remediation hints for missing `@unbrained/pm-cli` SDK dependency resolution and ESM module-mode mismatches.
- Improved private diagnostics event segmentation by adding additive package/version and source-context metadata fields.
- Improved `pm update-many` no-op validation guidance by listing actionable mutation flag examples when users provide filters/`--dry-run` without any mutation flags.

- Added `pm files discover <ID>` to scan item text for existing project/global file paths, report addable vs already linked candidates, and optionally add missing linked files with `--apply`.
- Added `pm create --comment` plain-text shorthand support so comment seeds can be passed as raw text without mandatory `text=<value>` wrappers.
- Added ownership-safe dependency-only audit updates via `pm update --allow-audit-dep-update` / `--allow_audit_dep_update` for append-only non-owner `--dep` additions.
- Added cache cleanup safety controls on `pm gc`: `--dry-run`, repeatable/comma-delimited `--scope index|embeddings|runtime`, and deterministic `guidance` output (including reindex hints after search-artifact cleanup).
- Added linked-test PM-context ergonomics flags `--check-context` and `--auto-pm-context` for `pm test --run` and `pm test-all`, including preflight summary warnings and run-level execution-context metadata (`requested_pm_context_mode`, `auto_pm_context_applied`).
- Added hardened background-run attribution fallback for `requested_by` in `pm test-runs` metadata: explicit author -> `PM_AUTHOR` -> settings author default -> `USER`/`LOGNAME`/`USERNAME` -> OS username -> `unknown`.
- Added contract/completion alias parity improvements: `pm contracts` now publishes canonical flag + alias metadata for command surfaces, and generated completion scripts include accepted alias candidates from the shared contract registry.
- Added extension lifecycle flag-forwarding parity so subcommand forms (`pm extension manage ...`, `pm extension doctor ...`) honor the same action flags as top-level action forms.
- Added command-flag contract parity coverage for `pm contracts --flags-only` across core command families (`comments`, `notes`, `learnings`, `files`, `docs`, `history`, `config`, `restore`, `delete`, `extension`, `test-runs`, `validate`) plus action-scoped `command_flags` projection when filtering with `--action` and no explicit `--command`.
- Added additive governance `summary` metrics to `pm comments-audit` output (`totals`, coverage ratio/percent, and `by_type`) while preserving existing export payloads.
- Added append-only ownership-safe audit bypass parity for `pm notes` and `pm learnings` via `--allow-audit-comment`, including ownership-conflict guidance, completion surfaces, contracts, and Pi wrapper action mapping.
- Added non-silent bare `pm test-runs` behavior so the root command defaults to list output when no subcommand is supplied.
- Added refined linked-test PM-context mismatch diagnostics that explicitly explain per-test `pm_context_mode` override precedence over run-level `--pm-context` values.
- Added `pm update --replace-deps` atomic dependency replacement mode so existing dependency sets can be replaced in one mutation/history entry.
- Added ownership ergonomics enhancements: `pm release --allow-audit-release` for non-owner handoffs that only clear assignee metadata, plus `pm get` `claim_state` metadata with current assignee and latest claim/release history context.
- Added `pm contracts --schema-only --action create` `x-create-required-options` metadata so machine consumers can resolve effective create required options per type and create mode.
- Added managed background linked-test execution for `pm test --run --background` and `pm test-all --background`, including persistent run registry metadata, worker lifecycle orchestration, and duplicate-run fingerprint prevention.
- Added `pm test-runs` lifecycle command surface (`list`, `status`, `logs`, `stop`, `resume`) for background run management with health/resource snapshots and tailed stdout/stderr inspection.
- Added configurable test-result tracking policy at `settings.testing.record_results_to_items` with `pm config <project|global> get|set test-result-tracking --policy enabled|disabled`.
- Added bounded deterministic item-level `test_runs` summary persistence (settings-gated) for `pm test --run` and `pm test-all`, including background-run propagation metadata.
- Added bundled managed extension sources at `.agents/pm/extensions/beads` and `.agents/pm/extensions/todos`, each with manifest + runtime entrypoint wiring for extension-managed command registration.
- Added bundled extension alias installs for `pm extension --install beads` and `pm extension --install todos` (with parity support for explicit local bundled paths).
- Added unified command/action contract registry exports in `src/sdk/cli-contracts.ts` (including JSON Schema Draft 2020-12 tool-parameter contract) for cross-surface CLI + agent parity.
- Added centralized command help narratives across core command paths (`Why use this command`, practical examples, and targeted tips) through a shared help composer.
- Added structured CLI error guidance rendering for commander usage failures and runtime `PmCliError` failures with deterministic sections (`What happened`, `What is required`, `Why`, `Examples`, optional `Next steps`).
- Added sparse default TOON rendering that emits command payloads directly and omits `null`/`undefined`/empty arrays/empty objects for token-efficient agent workflows while keeping `--json` payload compatibility.
- Added strict action-scoped Pi tool parameter schema v4 in `src/sdk/cli-contracts.ts` (`oneOf` action branches with per-action required fields, richer per-field metadata, and `additionalProperties: false`).
- Added machine-readable JSON error envelopes for usage/runtime failures when `--json` is active (`type`, `code`, `title`, `detail`, `required`, `exit_code`, optional remediation fields).
- Added layered help defaults: compact command help by default plus explicit deep-help rendering with `--explain`.
- Added machine-readable help payloads for `pm <command> --help --json` and `pm help <command> --json` with deterministic option metadata (`required`, aliases, value format).
- Added `pm contracts` command for runtime contract introspection (`--action`, `--command`, `--schema-only`) including shared schema/action/flag surfaces.
- Added merge-conflict marker detection in item and history parsing paths with actionable remediation guidance.
- Added `pm health` `integrity` diagnostics for conflict markers and parse/JSONL anomalies with deterministic warning codes.
- `list*` commands now accept `--include-body` to project item `body` into each returned row when needed for metadata completeness analysis.
- Added `pm aggregate` grouped governance queries with expanded `--group-by` dimensions (`parent`, `type`, `priority`, `status`, `assignee`, `tags`, `sprint`, `release`) while keeping default grouped-count mode (`parent,type`) and optional `--count`/`--include-unparented`.
- Added `pm dedupe-audit` duplicate corpus checks with `title_exact`, `title_fuzzy`, and `parent_scope` modes plus machine-readable merge suggestions.
- Added list-family projection and ordering controls: `--compact`, `--fields <csv>`, `--sort <priority|deadline|updated_at|created_at|title|parent>`, and `--order <asc|desc>`.
- Added expanded `pm comments-audit` governance filters: `--parent`, `--tag`, `--sprint`, `--release`, and `--priority`.
- Added `pm health` vector refresh intent controls: `--check-only`, `--no-refresh`, and `--refresh-vectors` (default targeted refresh behavior is unchanged).
- Added persistent item reminders via repeatable `--reminder at=<iso|relative>,text=<text>` support on `pm create` and `pm update` (including explicit `--clear-reminders` semantics).
- Added `pm update --body` / `-b` support (including stdin token `--body -`) so existing items can backfill or replace body content with standard update history/lock semantics.
- Added `pm calendar` (alias: `pm cal`) with deterministic `agenda` (default), `day`, `week`, and `month` views across deadlines and reminders, plus `--past` and range/filter options.
- Added `pm context` (alias: `pm ctx`) as an agent-first project snapshot command that combines deterministic high-level/low-level active work focus with agenda/reminder context, including blocked fallback when active work is empty.
- Added persistent item scheduled events via repeatable `--event` support on `pm create` and `pm update`, including one-off entries plus recurrence fields (`recur_freq`, `recur_interval`, `recur_count`, `recur_until`, `recur_by_weekday`, `recur_by_month_day`, `recur_exdates`) and explicit `--clear-events` semantics.
- Added bounded recurring occurrence expansion to `pm calendar` so recurring item events are materialized into agenda/day/week/month windows.
- Added calendar source and recurrence controls: `--include`, `--recurrence-lookahead-days`, `--recurrence-lookback-days`, and `--occurrence-limit`.
- Added resilient entry parsing for mutation `--add` and create/update repeatable seed flags: CSV `key=value`, markdown-style `key: value`, and `-` stdin-token ingestion are now supported with deterministic normalization.
- Added stdin token support for `pm append --body -` and structured comment ingestion for `pm comments --add` (plain text remains supported).
- Added runtime-configurable item type registry support: `settings.item_types.definitions` plus extension `registerItemTypes(...)` registrations now drive allowed type values, aliases, per-type required create fields/repeatables, option schemas, and type folder routing.
- Added calendar-native built-in item types: `Event`, `Reminder`, `Milestone`, and `Meeting` (with deterministic folder routing, completion defaults, and help/usage fallback guidance parity).
- Added `--type-option` / `--type_option` support on `pm create` and `pm update` for validated per-type metadata (`key=value` or `key=<name>,value=<value>`, with explicit `--clear-type-options` semantics).
- Added per-type `command_option_policies` support (settings + extension item-type registrations) for `create`/`update` option-level `required`, `enabled`, and `visible` behavior controls.
- Added type-aware help policy sections for `pm create --help` / `pm update --help` when `--type <value>` is supplied, including required/disabled/hidden option summaries from active settings/extensions.
- Added type-option schema surfacing in type-aware help (`pm create --help --type <value>` / `pm update --help --type <value>`) including required markers, allowed values, aliases, and option descriptions.
- Added extension-first command routing for deterministic core-command replacement when extension handlers register matching command paths.
- Added `pm extension` lifecycle management command with mutually-exclusive actions: `--install`, `--uninstall`, `--explore`, `--manage`, `--doctor`, `--adopt`, `--adopt-all`, `--activate`, and `--deactivate`.
- Added extension install source normalization for local paths plus GitHub URL/shorthand forms (`https://github.com/...`, `github.com/...`, `--gh/--github owner/repo[/path]`) with optional `--ref` support.
- Added scope-local managed extension state (`<extensions-root>/.managed-extensions.json`) with deterministic metadata for source, install/update timestamps, and GitHub update checks.
- Added `pm extension --doctor` (and `pm extension doctor` shorthand) with consolidated extension diagnostics, normalized warning-code summaries, remediation hints, and optional deep diagnostics via `--detail deep`.
- Added Extension Host V2 override planes: `registerParser` (command-context parsing), `registerPreflight` (mutation-gate/migration interception), and `registerService` (output/error/help plus lock/history/item-store service overrides) with deterministic last-wins precedence.
- Added richer command lifecycle hook payload parity (`beforeCommand` / `afterCommand`) including command options, global options, and final command result context.
- Added live runtime wiring for extension search/vector selectors (`settings.search.provider`, `settings.vector_store.adapter`) in `pm search` and `pm reindex`.
- Added extension item-field default/validation wiring on create/update write paths from `registerItemFields(...)`.
- Added stable SDK package exports at `@unbrained/pm-cli/sdk` with public extension type contracts and `defineExtension(...)` helper.
- Added Ollama-aware semantic auto-default resolution for `pm search`/`pm reindex` when semantic settings are unset and local Ollama is installed, including compatibility-safe fallback to keyword mode for implicit default search when auto semantic execution fails.
- Added `pm health` history drift diagnostics (`history_drift`) that detect missing/unreadable history streams and item/hash mismatches against latest history `after_hash`.
- Added `pm health` vectorization diagnostics (`vectorization`) with targeted stale-ID semantic refresh and deterministic vectorization ledger tracking (`search/vectorization-status.json`).
- Added configurable missing history-stream policy at `settings.history.missing_stream` with `pm config <project|global> get|set history-missing-stream-policy --policy auto_create|strict_error`.
- Added configurable sprint/release format policy at `settings.validation.sprint_release_format` with `pm config <project|global> get|set sprint-release-format-policy --policy warn|strict_error`.
- Added configurable parent-reference policy at `settings.validation.parent_reference` with `pm config <project|global> get|set parent-reference-policy --policy warn|strict_error`.
- Added reusable create templates via `pm templates save/list/show` and additive `pm create --template` support with deterministic explicit-flag override precedence.
- Added additive history diagnostics: `pm history --diff` (changed-field summaries) and `pm history --verify` (hash-chain/current-hash validation output).
- Added linked artifact path hygiene features for `pm files` and `pm docs`: `--migrate`, `--validate-paths`, and `--audit` (plus `pm files --list` for explicit listing).
- Added repeatable `--add-glob` support for `pm files` and `pm docs` to expand deterministic file/doc matches (plain glob or `pattern=<glob>,scope=<scope>,note=<text>` entries).
- Added deterministic `--tag` completion suggestions in bash/zsh/fish scripts derived from tracked item metadata.
- Added history-only restore recovery so `pm restore` can recreate missing/deleted item files when the corresponding history stream exists.
- Added first-class `pm notes` and `pm learnings` commands with parity to `pm comments` (`<id> [text]`, `--add`, `--limit`, `--author`, `--message`, `--force`) including structured/stdin payload parsing.
- Added command-surface parity updates for `notes`/`learnings` across help narratives, shell completion scripts, command-aware output summaries, and Pi wrapper action routing.
- Added CLI/Pi shared contract parity for extension lifecycle actions (`extension-install`, `extension-uninstall`, `extension-explore`, `extension-manage`, `extension-doctor`, `extension-adopt`, `extension-adopt-all`, `extension-activate`, `extension-deactivate`) and their schema parameters (`target`, `scope`, `github`, `ref`).
- Added integration regressions for repeated `pm files --add` / `pm docs --add` mutation flows to keep linked-artifact add workflows stable across subsequent command invocations.
- Added transactional linked/log mutation support on `pm update` via repeatable `--comment`, `--note`, `--learning`, `--file`, `--test`, and `--doc` flags (including explicit `--clear-comments|--clear-notes|--clear-learnings|--clear-files|--clear-tests|--clear-docs` semantics) so metadata + linked surfaces can be updated in one mutation.
- Added dependency mutation support on existing items through `pm update`: repeatable `--dep` add plus explicit `--clear-deps` semantics and repeatable `--dep-remove`/`--dep_remove` selector removals, with parity across help/completion/contracts/Pi wrapper surfaces.
- Added read-only dependency visualization command `pm deps` with deterministic `tree` (default) and `graph` projections, including cycle-safe traversal and missing-node reporting.
- Added `pm update --close-reason` / `--close_reason` support so callers can explicitly set `close_reason`, and clear it with `--unset close-reason`, without using `pm close`.
- Added standalone `pm validate` command with deterministic check payloads for metadata completeness, closed-item resolution fields, linked-file/orphaned-file hygiene, and item/history drift.
- Added metadata-profile validation policy controls (`core|strict|custom`) for `pm validate --check-metadata`, plus config surfaces `metadata-validation-profile` and `metadata-required-fields` for settings-backed required-field governance.
- Added `pm validate --scan-mode default|tracked-all` for file-check candidate selection, including explicit `candidate_total`/`candidate_scanned` reporting while preserving compatibility fields.
- Added `pm validate --scan-mode tracked-all-strict` plus structured file-check exclusion reporting (`excluded_by_reason`) so tracked coverage behavior is explicit and machine-readable.
- Added explicit tracked-all-strict force-inclusion visibility in `pm validate` file-check details (`strict_mode_forces_pm_internals`, `strict_mode_forces_pm_internals_notice`) plus warning token `validate_files_tracked_all_strict_forces_pm_internals`.
- Added `pm validate --strict-exit` (alias `--fail-on-warn`) to return non-zero exit (`1`) when validation warnings are present (`ok=false`).
- Added `pm contracts --runtime-only` (alias `--active-only`) and runtime action availability metadata (`action_availability`) so machine callers can filter to invocable actions in current runtime conditions.
- Added extension lifecycle adopt action (`pm extension --adopt`) to register existing unmanaged installs into managed state metadata without reinstalling extension files (with optional GitHub provenance via `--gh/--github` + `--ref`).
- Added extension lifecycle bulk adopt action (`pm extension --adopt-all`) to register all unmanaged installs in selected scope into managed state metadata without reinstalling extension files.
- Added extension triage update-health diagnostics (`update_health_coverage`, `update_health_partial`) and normalized warning-code surfacing (`warning_codes`, including `extension_update_health_partial_coverage`) for `pm extension --manage` / `pm extension --doctor`.
- Added strict warning exit controls for extension diagnostics (`pm extension --doctor --strict-exit`, alias `--fail-on-warn`) plus machine-usable blocking-failure indicators (`blocking_failure_count`, `has_blocking_failures`).
- Added explicit extension state semantics in extension listings/diagnostics (`active` compatibility alias, `enabled`, `runtime_active`, `activation_status`) so configured-vs-runtime status is unambiguous.
- Added unknown capability guidance hardening: `extension_capability_unknown` warnings now include inline allowed capability lists and nearest-match suggestions when confidence is high, and health/doctor payloads include `capability_guidance` metadata.
- Added health parity warning surfacing for extension update-check partial coverage (`extension_update_health_partial_coverage`) so `pm health` mirrors extension triage visibility when unmanaged loaded extensions reduce coverage.
- Added extension capability contract metadata publishing for diagnostics consumers (`capability_contract.version`, `capability_contract.capabilities`, `capability_contract.legacy_aliases`) plus legacy alias guidance (`migration`/`validation` -> `schema`) in unknown-capability diagnostics.
- Added extension diagnostics/runtime controls: `pm extension --doctor --detail deep --trace`, `pm extension --manage --runtime-probe`, and `--fix-managed-state` support for `manage`/`doctor`, with parity wiring across CLI contracts, shell completion, and Pi wrapper arguments.
- Added `pm close --validate-close [warn|strict]` for additive close-time resolution-field validation (`resolution`, `expected_result`, `actual_result`) with warning-first default behavior.
- Added `pm files --append-stable` for minimal-diff file-link appends that preserve existing link order and reduce history patch churn during large audits.
- Added `pm create --create-mode strict|progressive` so strict remains default while governance workflows can use staged progressive creation.
- Added `pm comments --allow-audit-comment` to permit append-only audit comments on items owned by other assignees without broad ownership override semantics.
- Added `pm comments-audit` full-history export mode (`--full-history`) with mutually-exclusive latest controls, explicit export metadata (`filters.full_history`, `export.mode`, `export.row_count`), and NDJSON-friendly `rows[]` payload support.
- Added ownership-safe non-owner metadata update mode on `pm update` via `--allow-audit-update` / `--allow_audit_update`, with explicit lifecycle/ownership/linkage guardrails.
- Added `pm update-many` bulk mutation workflow with deterministic filter targeting, `--dry-run` planning, checkpoint capture, and `--rollback <checkpoint-id>` restore support.
- Added `pm update-many` linked-array mutation parity with `pm update` (`--dep`, `--comment`, `--note`, `--learning`, `--file`, `--test`, `--doc`, `--reminder`, `--event`, `--clear-*`, `--replace-deps`, `--replace-tests`), including deterministic dry-run/apply actionability for linked-array payloads and command/contracts/completion/help parity updates.
- Added task lifecycle alias commands: `pm start-task`, `pm pause-task`, and `pm close-task` for discoverable claim/update/close/release workflows.
- Added `pm contracts` projection flags `--flags-only` and `--availability-only` for lightweight machine-readable output selection.
- Added completion mode controls: `pm completion --eager-tags` for embedded tag expansion and hidden `pm completion-tags` helper command for default lazy tag lookup.
- Added `pm calendar --full-period` for anchored day/week/month windows without now-clipping.
- Added `pm activity` timeline filters (`--id`, `--op`, `--author`, `--from`, `--to`) and JSON line stream mode (`--stream [rows|ndjson|jsonl]`).
- Added compatibility-safe extension manifest/command migration aids: legacy capability aliases (`migration`/`validation`) now remap to `schema` with `extension_capability_legacy_alias`, and legacy command-definition `handler` aliases map to `run` with `extension_command_definition_legacy_handler_alias`.
- Added `--offset` pagination and JSON-only `--stream` output mode for `pm list` and all `pm list-*` command families to improve large-result processing ergonomics.
- Added additive `pm health --strict-directories` behavior with required-vs-optional directory diagnostics (`missing_required`, `missing_optional`) so optional built-in item-type directory gaps do not fail default health runs.
- Added strict warning exit controls for health diagnostics (`pm health --strict-exit`, alias `--fail-on-warn`) for CI-friendly non-zero health gating.
- Added `pm config <project|global> list` and `pm config <project|global> export` for config-key discovery and one-shot resolved snapshot export.
- Added explicit extension manage update-check reporting with per-extension `update_check_status` / `update_check_reason` fields and triage `update_check_status_totals`.
- Added explicit `--progress` flag support to `pm test`, `pm test-all`, and `pm reindex` so non-interactive runs can opt into deterministic stderr progress visibility.
- Added additive linked-test runtime environment controls: repeatable `--env-set` / `--env-clear` and `--shared-host-safe` on `pm test --run` and `pm test-all`.
- Added per-linked-test runtime directives in linked test metadata (`env_set`, `env_clear`, `shared_host_safe`) for deterministic command-level execution control.
- Added linked-test PM-context and strict-governance controls: `--pm-context schema|tracker|auto`, `--fail-on-context-mismatch`, `--fail-on-skipped`, `--fail-on-empty-test-run`, and `--require-assertions-for-pm` on `pm test --run` and `pm test-all`.
- Added linked-test PM-context auto-routing (`--pm-context auto`) and per-linked-test context override metadata (`pm_context_mode=schema|tracker|auto`) for mixed-mode linked test execution.
- Added linked-test assertion metadata support (`assert_stdout_contains`, `assert_stdout_regex`, `assert_stderr_contains`, `assert_stderr_regex`, `assert_stdout_min_lines`, `assert_json_field_equals`, `assert_json_field_gte`) with deterministic assertion-failure classification and per-run `execution_context` metadata in `run_results`.
- Added structured linked-test failure classification in `run_results` (`failure_category`) and aggregated `failure_categories` totals in `pm test`/`pm test-all` results for triage (`infra_collision` vs `assertion_failure` and related categories).
- Added standalone `pm validate` linked command-reference diagnostics (`command_references`) with default-on stale PM-id detection and dedicated warning token (`validate_command_references_stale_pm_ids:<count>`).
- Added default-on resolution remediation command hints in `pm validate` details for missing resolution metadata (`resolution`, `expected_result`, `actual_result`).
- Added unquoted multi-word query support for `pm search <keywords...>` so variadic tokens are normalized into one query string without requiring shell quoting.
- Added `--parent <id>` filtering support to `pm list` and all `pm list-*` command families, with shared contract/completion/Pi wrapper parity.
- Added `pm search` projection controls (`--compact`, `--full`, `--fields <csv>`) with deterministic projection metadata in result payloads.
- Added extension command metadata surfacing (`action`, `intent`, `examples`, `failure_hints`, argument/flag descriptors) in dynamic `--help` text and `--help --json` payloads.
- Added runtime extension command/action schema inclusion in `pm contracts` output (`extension_commands`, merged action availability/schema branches, extension-sourced command flag metadata).

### Changed
- `settings.output.default_format` now drives default command rendering for `printResult`-based commands (without requiring explicit `--json`), while explicit per-command format decisions still take precedence.
- `pm create --template <name>` now allows template-provided `type` defaults to satisfy create requirements when `--type` is omitted on the command line.
- Relative time parsing now supports preset `now` and negative offsets (for example `-1d`) across shared ISO/relative parsing paths, restoring documented `pm activity --from/--to` behavior.
- `pm list-open` now resolves against workflow-configured `open_status` values instead of assuming literal status `open`, so customized workflows (for example `triage`) are returned correctly.
- Bundled `beads`/`todos` extension command help now includes discoverable option flags (`--file`, `--folder`, `--author`, `--message`, and related flags) after install, matching runtime-supported invocation surfaces.
- Updated command-by-command documentation parity across `README.md`, `PRD.md`, `docs/ARCHITECTURE.md`, and `AGENTS.md` to reflect contracts projection behavior, `comments-audit` summary metrics, `notes`/`learnings` audit bypass parity, root `test-runs` list behavior, and PM-context mismatch guidance.
- Removed the `pm install` command surface; extension lifecycle installs now flow through `pm extension` only.
- `pm beads import`, `pm todos import`, and `pm todos export` are now extension-discovered command paths that appear only after corresponding bundled extensions are installed and active.
- Commander option normalization, shell completion flag generation, and Pi wrapper action/schema/arg mapping now consume the shared command contract registry to reduce cross-surface drift.
- Ownership-conflict guidance for `pm comments --add` now recommends `--allow-audit-comment` before `--force` for append-only audit workflows.
- `pm search` now defaults to compact projection for both TOON and JSON output unless callers request `--full` or explicit `--fields`.
- `pm get` missing-item guidance now uses deterministic recovery examples (`pm list-open --limit 20`, `pm search "<keyword>" --limit 10`) instead of echoing invalid IDs.
- `pm help` and `pm help <command>` now exit successfully without trailing invalid-usage envelopes.
- Runtime `PmCliError.context` fields (`required`, `why`, `examples`, `next_steps`, and optional code/type overrides) now flow through canonical text/JSON guidance rendering.
- Top-level `--json` error handling now emits canonical machine-readable diagnostics instead of text-only guidance.
- `pm history` malformed stream errors now include explicit repair/restore remediation guidance.
- Extension schema-capability registrations now enforce stricter deterministic validation for `registerFlags`, `registerItemFields`, `registerItemTypes`, and `registerMigration` input shapes.
- Commander error output now emits a single high-signal structured guidance payload (duplicate default commander stderr lines are suppressed).
- `pm comments` now accepts optional positional text shorthand (`pm comments <ID> "<text>"`) as an intuitive alias for `--add <text>`, and tolerates bare `--author` by falling back to existing author resolution (`PM_AUTHOR` -> settings default -> `unknown`).
- Default `list*` output remains front-matter-only; `body` projection is now explicit and opt-in via `--include-body` to preserve lightweight list payloads.
- Calendar command output now defaults to markdown for agent/human readability while preserving explicit `--format toon|json|markdown` and global `--json` overrides; all other commands keep existing TOON-default behavior.
- Calendar markdown summaries now include scheduled-event counts and event rendering includes recurring/location metadata where present.
- `pm comments-audit` now treats `--latest 0` as a valid summary-only export mode with deterministic `export.row_count = 0` semantics.
- `pm comments-audit --latest` and `--full-history` now enforce explicit mutual exclusivity in guidance/help output.
- `pm contracts --command <name>` now scopes action/command/availability output to the selected command for lower-noise machine payloads; use no `--command` filter for full corpus output.
- Mutation-triggered search cache invalidation now covers linked-test run-tracking paths (`pm test --run`, `pm test-all`) and lifecycle alias mutation flows.
- Calendar JSON/markdown summaries now expose deterministic aggregate breakdowns (`by_kind`, `by_type`, `by_status`, `recurring_events`) and markdown event lines now include richer metadata tokens (item type, recurrence rule, end-time projection, timezone/location, and description context).
- Command-aware output summaries now consume the canonical calendar `summary.events` structure (instead of stale `summary.total`) and emit richer calendar highlight metadata (`events`, `deadlines`, `reminders`, `scheduled`, `view`).
- Mutation parsing errors for entry-style flags now include actionable format guidance and explicit stdin-token usage hints to reduce malformed-input retries.
- `pm create` log-seed repeatables (`--comment`, `--note`, `--learning`) now reject parsed unsupported keys to prevent silent narrative truncation when unquoted comma segments resemble key/value tokens; guidance now explicitly routes punctuation-heavy text to quoted `text=...`, markdown key/value input, or stdin token usage.
- Type validation/filtering/completion now resolve from the runtime registry across create/update/list/search/calendar/completion/init/health/storage paths while preserving built-in defaults when no custom type config exists.
- Commander required-option UX for missing `--type` now includes rationale, active allowed values, and concrete fix examples.
- Type-governed `pm create` required-option failures now aggregate all missing required create flags plus required type-option keys into one deterministic usage error payload and include a deterministic type-specific "next valid example" command.
- Unavailable-command help requests (`pm <unknown> --help`) now emit explicit `unknown command` guidance and usage exit status (`2`) instead of successful help-path exits.
- Dynamic extension command help now supports `registerFlags` policy metadata (`required`, `enabled`, `visible`) with additive markers and hidden-flag suppression.
- Dynamic extension flags can now declare `type` / `value_type` metadata (`string`/`number`/`boolean`) for deterministic loose-option coercion on matching command paths.
- Search and reindex semantic execution now supports extension provider/adapter primary paths with deterministic fallback to built-in provider/vector configuration when available.
- `pm reindex --mode semantic|hybrid` now rewrites `search/vectorization-status.json` to keep health-time vector freshness checks synchronized with indexed corpus state.
- `pm health` now includes managed extension-state diagnostics and warnings for project/global extension roots.
- Documentation surfaces (`README.md`, `docs/EXTENSIONS.md`, `docs/ARCHITECTURE.md`, `PRD.md`) now include extension lifecycle-manager workflows and install-source equivalence guidance.
- Date/deadline parsing now accepts month-relative offsets (`+6m`) and normalized date-string variants (for example `2026-03-31T13-59` and `20260331T135900Z`) across deadline, reminder, event, list/search filter, and calendar date inputs while preserving canonical ISO persistence.
- `pm beads import --file -` now fails fast when stdin is an interactive TTY and returns explicit piped-input/EOF guidance instead of waiting for manual stream termination.
- CLI top-level error handling now preserves canonical exit-code mapping via graceful `process.exitCode` semantics to reduce buffered output truncation risk in emulated terminal environments.
- Output rendering now treats broken-pipe writes (`EPIPE`) as expected pipeline behavior with stream-specific exit semantics: stdout `EPIPE` preserves success exits for early-terminated read pipelines, stderr `EPIPE` remains non-zero, and unhandled Node stack traces are suppressed.
- Linked test runtime execution now uses shell-compatible spawn orchestration, closes child stdin for non-interactive runs, emits interactive stderr heartbeat progress for long-running commands, and applies deterministic timeout/maxBuffer diagnostics with force-kill fallback for stubborn subprocess trees.
- History-touching commands now enforce `settings.history.missing_stream` consistently across read/diagnostic paths (`history`, `activity`, `stats`, `health`) and existing-item mutation/restore flows.
- Linked-test sandbox runs now seed project/global `settings.json` and `extensions/` directories into temporary sandbox roots so extension-defined type/filter behavior matches direct workspace commands.
- `pm test --add` and `pm create --test` now require `command=...` for new linked-test entries (optional `path=...` is metadata-only); runtime still skips legacy stored path-only entries with deterministic diagnostics.
- `pm update` now auto-clears stale `close_reason` when reopening items from `closed` to non-terminal statuses unless an explicit `--close-reason` value is provided in the same mutation.
- `pm claim` now allows takeover of already-assigned non-terminal items without `--force`; force remains required for terminal-status or lock-override claim paths.
- `pm comments` guidance is now explicit about `--force` usage across rich help, shell completion, and docs parity surfaces.
- Ownership-conflict guidance now includes explicit approved `--force` scenarios (PM audits, coordinated metadata correction, and ownership handoff cleanup) while preserving ownership enforcement semantics.
- `pm create`/`pm update` now validate `--sprint` and `--release` using a warning-first default (`warn`) with deterministic `validation_warning:*` signals, and optional strict rejection mode (`strict_error`) for enforcement.
- `pm create`/`pm update` now validate missing `--parent` references using warning-first defaults (`validation_warning:parent_reference_missing:<id>`) with optional strict rejection mode (`strict_error`).
- CLI contracts and Pi wrapper action/schema mapping now include additive `templates-*` actions, `create --template`, `history --diff/--verify`, and files/docs linked-path hygiene flags.
- CLI contracts, shell completion, and Pi wrapper action/parameter mappings now include additive parity for `validate`, `close --validate-close`, list `--offset/--stream`, and long-run `--progress` controls.
- `pm validate --check-files --scan-mode tracked-all` now excludes PM-internal storage files by default, adds `--include-pm-internals` for explicit internal-audit scans, and reports filtered/raw candidate counts (`candidate_total*`, `candidate_scanned*`, `pm_internal_excluded_count`); `tracked-all-strict` now also reports explicit force-inclusion visibility/warnings.
- `pm extension --manage` and `pm health` extension diagnostics now include condensed `details.triage` summaries with prioritized counts and remediation-oriented next steps alongside full detailed payloads.
- `pm extension --manage`/`pm extension --doctor` warning surfaces are now normalized so top-level `warnings` align with triage warning codes/counts, and update-health partial coverage warnings only trigger when unmanaged extensions are action-required.
- `pm extension --manage` keeps compatibility-safe default runtime state reporting (`runtime_active`/`activation_status` unchanged) unless `--runtime-probe` is explicitly requested.
- Extension activation validation failures now carry structured registration trace metadata that deep doctor trace mode can surface for actionable remediation.
- CLI/contracts/completion/Pi wrapper parity now includes linked-test runtime env controls (`--env-set`, `--env-clear`, `--shared-host-safe`) and `pm validate --check-command-references`.

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
- `--assignee <value>` filter for all `list*` commands — exact match on `assignee` field; use `--assignee-filter unassigned` to filter for unassigned items.
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
