# pm-cli Product Requirements Document (PRD)

Status: Draft v1 (planning reference; pm data and runtime behavior are authoritative)
Project: `pm` / `pm-cli`  
Last Updated: 2026-05-01

## Navigation

This PRD is an archival planning reference. For current user and agent documentation, use:

- [README](README.md)
- [Documentation index](docs/README.md)
- [Agent Guide](docs/AGENT_GUIDE.md)
- [Command Reference](docs/COMMANDS.md)
- [Architecture](docs/ARCHITECTURE.md)

Documentation refresh tracking:

- [pm-3042](.agents/pm/epics/pm-3042.toon)
- [pm-r9gu](.agents/pm/features/pm-r9gu.toon)
- [pm-1sb2](.agents/pm/tasks/pm-1sb2.toon)

## 1) Problem Statement

Coding agents and humans need a shared project-management system that is:

- Git-native (diffable, reviewable, branch-friendly)
- Deterministic (stable machine-readable output for automation)
- Robust under concurrent edits (claiming + lock safety)
- Extensible (project-local and global custom behavior)
- Token-efficient for LLM workflows (TOON by default, JSON fallback)

Existing trackers either rely on hosted backends, store state in non-diff-friendly formats, or do not provide first-class agent ergonomics for claiming, dependencies, history replay, and deterministic output.

## 2) Goals

- Build a cross-platform TypeScript CLI named `pm`.
- Store all core tracker data in project-local files under `.agents/pm` by default.
- Model work as first-class items: `Epic`, `Feature`, `Task`, `Chore`, `Issue`, `Event`, `Reminder`, `Milestone`, `Meeting`.
- Support full item lifecycle operations, deterministic listing/filtering, and rich metadata.
- Support reminder-aware scheduling workflows with deterministic calendar views for agents and humans.
- Provide append-only item history with patch-level restore.
- Provide safe mutation under concurrent access (claim/release + lock + atomic writes).
- Default stdout to TOON; support `--json` parity for every command.
- Provide extension architecture for commands, schema, rendering, import/export, search adapters, and hooks.
- Ship bundled managed extension sources:
  - Beads import (`beads` alias, installed via `pm extension --install`)
  - todos.ts import/export (`todos` alias, installed via `pm extension --install`)
  - Pi agent extension wrapper source module
- Provide optional semantic search with provider + vector-store adapters.

## 3) Explicit Non-Goals

- No required UI/TUI (CLI-first only).
- No required remote control plane for core tracker.
- No required database for core tracker (file-backed core is mandatory).
- Export to Beads is not required in v1 (import only).

## 4) Reference Inputs and Design Findings

### 4.1 Local reference inputs analyzed

1. `todos.ts` (local Pi extension implementation)
2. `.beads/issues.jsonl` (local Beads-style JSONL data)

### 4.2 Upstream inspirations analyzed (conceptual only)

- mitsuhiko todos extension
- beads repository/docs
- TOON docs/spec guidance for LLM output conventions

### 4.3 Key findings adopted

From `todos.ts`:

- Legacy import format = JSON front-matter at file start, blank line, then markdown body.
- ID normalization accepts optional `#` and optional prefix.
- Claim/release is represented in-record (`assignee`).
- Locking model:
  - lock file created with exclusive open (`wx`)
  - TTL-based stale-lock handling
  - lock metadata includes PID/owner/timestamp
- Safe-write ergonomics should provide clear conflict errors.

From local Beads JSONL:

- `issue_type`, `priority`, `status`, `created_at`, `updated_at` are strongly present.
- Common extra fields include: `description`, `acceptance_criteria`, `notes`, `comments`, `dependencies`, `close_reason`, `estimated_minutes`.
- Dependency records frequently carry relation kinds (`blocks`, `parent-child`, `discovered-from`, `related`), timestamps, and author.
- IDs may include hierarchical suffixes (`prefix-hash.1.2`), so importer must preserve non-flat IDs.

From TOON guidance:

- Show structure directly, keep deterministic layout, and preserve strict machine parseability.
- Keep output schema stable and field ordering deterministic.
- JSON fallback should preserve the full command payload; TOON may be a sparse projection optimized for token efficiency.

## 5) Core Concepts

### 5.1 Item Types (canonical)

- `Epic`
- `Feature`
- `Task`
- `Chore`
- `Issue`
- `Event`
- `Reminder`
- `Milestone`
- `Meeting`

### 5.2 Status lifecycle

Allowed values:

- `draft`
- `open`
- `in_progress`
- `blocked`
- `closed`
- `canceled`

Input compatibility:

- Accept `in-progress` as an input alias and normalize to canonical `in_progress` for persisted item data and command output.

Lifecycle rules:

- Any non-terminal status may transition to `canceled` via `pm update <ID> --status canceled`.
- Any non-terminal status may transition to `closed` only via `pm close <ID> <TEXT>`.
- `pm update <ID> --status closed` is invalid usage and returns exit code `2`.
- `closed` and `canceled` are terminal unless explicitly restored or reopened.
- `close` command must write `close_reason`.
- `pm close <ID> <TEXT> --validate-close [warn|strict]` validates closure resolution metadata (`resolution`, `expected_result`, `actual_result`) in warning-first mode unless strict is explicitly requested.
- `pm update <ID> --close-reason <TEXT>` explicitly sets `close_reason`; `pm update <ID> --unset close-reason` clears it.
- When `pm update` reopens an item from `closed` to a non-terminal status, stale `close_reason` is auto-cleared unless `--close-reason` is explicitly supplied on that same mutation.
- `claim` on terminal status fails unless explicitly overridden by `--force`.

### 5.3 Ownership model

- Ownership marker is `assignee`.
- `pm claim <id>` sets ownership to current mutation author identity.
- `pm release <id>` clears ownership.
- `pm claim <id>` may take over non-terminal items assigned to another assignee without `--force`.
- Mutations other than `claim` against items assigned to another assignee return conflict unless `--force` (`comments`/`notes`/`learnings` can use additive `--allow-audit-comment` for append-only audit entries, and `release` can use `--allow-audit-release` for non-owner handoffs that only clear assignee metadata).
- Ownership-conflict guidance should call out approved `--force` scenarios (for example PM audits, coordinated lead-maintainer metadata correction, or explicit ownership handoff cleanup).

### 5.4 Dependencies model

Each dependency entry:

- `id: string`
- `kind: "blocks" | "parent" | "child" | "related" | "discovered_from"`
- `created_at: ISO timestamp`
- `author?: string`

Semantics:

- `blocks`: this item blocks target item OR is blocked by target based on command context; CLI sugar resolves direction.
- `parent` / `child`: hierarchy graph links.
- `related`: non-blocking relation.
- `discovered_from`: provenance trail.

### 5.5 Notes, learnings, comments

These are append-friendly audit fields:

- `comments`: user-visible conversational updates.
- `notes`: implementation observations.
- `learnings`: post-task durable findings.
- Existing items are extended through `pm comments`, `pm notes`, and `pm learnings` add flows; create-time seed flags only bootstrap initial values.

All append operations produce history entries.

## 6) On-Disk Storage Layout

Default project root: `.agents/pm`  
Override for command invocation: `PM_PATH` or `--path`.

Global extension root: `~/.pm-cli`  
Override: `PM_GLOBAL_PATH`.

Required baseline:

```text
.agents/pm/
  settings.json
  epics/
    <id>.md
  features/
    <id>.md
  tasks/
    <id>.md
  chores/
    <id>.md
  issues/
    <id>.md
  history/
    <id>.jsonl
  index/
    manifest.json
  search/
    embeddings.jsonl
  extensions/
    ...
  locks/
    <id>.lock
```

Notes:

- `index/manifest.json` and `search/embeddings.jsonl` are optional caches and can be rebuilt.
- `history/<id>.jsonl` is append-only and required once item exists.
- `locks/` is the canonical lock location for v1.

### 6.1 Source layout for release-ready maintainability

Implementation source tree MUST separate CLI wiring from domain logic:

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
```

Constraints:

- Public CLI entry remains stable through npm `bin` mapping (`pm` -> built CLI entry).
- Deterministic serialization semantics are unchanged by module movement.
- Integration tests execute built CLI in subprocesses against temporary sandbox paths only.

## 7) Item File Format

Each item is one TOON document at `<type-folder>/<id>.toon`. Legacy `<type-folder>/<id>.md` files are read only for migration.

Format:

1. TOON root-object metadata keys.
2. Optional `body` field.

### 7.1 Canonical item-metadata schema

`metadata` is the internal TypeScript field name (`ItemDocument.metadata`), and TOON documents store the same metadata as top-level keys.

Required fields:

- `id: string`
- `title: string`
- `description: string`
- `tags: string[]`
- `status: "draft" | "open" | "in_progress" | "blocked" | "closed" | "canceled"`
- `priority: 0 | 1 | 2 | 3 | 4`
- `type: "Epic" | "Feature" | "Task" | "Chore" | "Issue" | "Event" | "Reminder" | "Milestone" | "Meeting"`
- `created_at: ISO string`
- `updated_at: ISO string`

Optional fields:

- `assignee?: string`
- `deadline?: ISO string` (ISO/date-string/relative input resolved to ISO at write time)
- `reminders?: Reminder[]` where `Reminder = { at: ISO string; text: string }`
- `dependencies?: Dependency[]`
- `comments?: Comment[]`
- `author?: string`
- `acceptance_criteria?: string`
- `definition_of_ready?: string`
- `order?: number`
- `goal?: string`
- `objective?: string`
- `value?: string`
- `impact?: string`
- `outcome?: string`
- `why_now?: string`
- `notes?: LogNote[]`
- `learnings?: LogNote[]`
- `files?: LinkedFile[]`
- `tests?: LinkedTest[]`
- `test_runs?: ItemTestRunSummary[]`
- `docs?: LinkedDoc[]`
- `estimated_minutes?: number`
- `parent?: string` (item ID reference; shorthand for a `kind=parent` dependency)
- `reviewer?: string`
- `risk?: "low" | "medium" | "high" | "critical"`
- `confidence?: 0..100 | "low" | "medium" | "high"`
- `sprint?: string`
- `release?: string`
- `blocked_by?: string` (item ID reference or free-text reason)
- `blocked_reason?: string`
- `unblock_note?: string`
- `reporter?: string`
- `severity?: "low" | "medium" | "high" | "critical"`
- `environment?: string`
- `repro_steps?: string`
- `resolution?: string`
- `expected_result?: string`
- `actual_result?: string`
- `affected_version?: string`
- `fixed_version?: string`
- `component?: string`
- `regression?: boolean`
- `customer_impact?: string`
- `close_reason?: string`

Types:

- `Dependency = { id: string; kind: "blocks" | "parent" | "child" | "related" | "discovered_from"; created_at: string; author?: string }`
- `Comment = { created_at: string; author: string; text: string }`
- `LogNote = { created_at: string; author: string; text: string }`
- `LinkedFile = { path: string; scope: "project" | "global"; note?: string }`
- `LinkedTest = { command?: string; path?: string; scope: "project" | "global"; timeout_seconds?: number; note?: string }`
- `ItemTestRunSummary = { run_id: string; kind: "test" | "test-all"; status: "passed" | "failed" | "stopped" | "canceled"; started_at: string; finished_at: string; recorded_at: string; attempt?: number; resumed_from?: string; passed: number; failed: number; skipped: number; items?: number; linked_tests?: number; fail_on_skipped_triggered?: boolean }`
- `LinkedDoc = { path: string; scope: "project" | "global"; note?: string }`
- `Reminder = { at: string; text: string }`
- `IssueSeverity = "low" | "medium" | "high" | "critical"`

### 7.2 Canonical key order

Keys MUST serialize in this order:

1. `id`
2. `title`
3. `description`
4. `type`
5. `status`
6. `priority`
7. `tags`
8. `created_at`
9. `updated_at`
10. `deadline`
11. `reminders`
12. `assignee`
13. `author`
14. `estimated_minutes`
15. `acceptance_criteria`
16. `definition_of_ready`
17. `order`
18. `goal`
19. `objective`
20. `value`
21. `impact`
22. `outcome`
23. `why_now`
24. `parent`
25. `reviewer`
26. `risk`
27. `confidence`
28. `sprint`
29. `release`
30. `blocked_by`
31. `blocked_reason`
32. `unblock_note`
33. `reporter`
34. `severity`
35. `environment`
36. `repro_steps`
37. `resolution`
38. `expected_result`
39. `actual_result`
40. `affected_version`
41. `fixed_version`
42. `component`
43. `regression`
44. `customer_impact`
45. `dependencies`
46. `comments`
47. `notes`
48. `learnings`
49. `files`
50. `tests`
51. `test_runs`
52. `docs`
53. `close_reason`

Unset optional fields are omitted.

### 7.3 Determinism rules

- `updated_at` MUST change for every mutation.
- Relative deadlines (`+6h`, `+1d`, `+2w`, `+6m`) and accepted date-string forms resolve on write and persist as absolute ISO.
- `tags` sorted lexicographically, deduplicated.
- `risk` CLI input alias `med` normalizes to canonical stored value `medium`.
- `confidence` CLI input accepts integers `0..100` or `low|med|medium|high`; `med` persists as `medium`.
- `severity` CLI input alias `med` normalizes to canonical stored value `medium`.
- `dependencies`, `comments`, `notes`, `learnings` sorted by `created_at` ascending; stable tie-break by text/id.
- `reminders` sorted by `at` ascending, then `text` ascending.
- `files` preserve provided order in canonical storage; `pm files` default mutation mode writes deterministic sorted order unless `--append-stable` is explicitly selected.
- `tests` sorted by `scope` asc, then `path` asc, then `command` asc, then `timeout_seconds` asc, then `note` asc.
- `test_runs` sorted by `recorded_at` asc, then `run_id` asc, then `kind` asc; retention is bounded to latest N entries per item.
- `docs` sorted by `scope` asc, then `path` asc, then `note` asc.
- Paths normalized to forward-slash logical form for storage while preserving OS-correct access at runtime.
- For optional create/update fields, explicit clear intent is supported via dedicated flags:
  - scalar fields use repeatable `--unset <field>` (for example `--unset deadline`, `--unset assignee`)
  - repeatable collections use `--clear-*` flags (for example `--clear-deps`, `--clear-comments`)
  - these intents MUST be represented in `changed_fields` and history `message`.

### 7.4 Example item file

```markdown
{
  "id": "pm-a1b2",
  "title": "Implement restore command",
  "description": "Add full RFC6902 replay restore with hash verification.",
  "type": "Task",
  "status": "in_progress",
  "priority": 1,
  "tags": [
    "history",
    "reliability"
  ],
  "created_at": "2026-02-17T10:00:00.000Z",
  "updated_at": "2026-02-17T11:15:03.120Z",
  "assignee": "maintainer-agent",
  "author": "steve",
  "acceptance_criteria": "Restore reproduces exact file content at target version.",
  "dependencies": [
    {
      "id": "pm-9c8d",
      "kind": "blocks",
      "created_at": "2026-02-17T10:02:31.000Z",
      "author": "steve"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/history-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 90
    }
  ]
}

Implement strict replay logic and integrity checks.
```

## 8) ID Strategy

### 8.1 Format

- Default prefix: `pm-`
- Init-time custom prefix supported via `pm init [PREFIX]`
- Canonical generated leaf: `<prefix><token>` where token is short lowercase base32/base36.
- Valid imported IDs may include hierarchical suffixes (`.1`, `.1.2`) and MUST be preserved.

### 8.2 Generation

- Generate cryptographically secure random bytes.
- Encode to lowercase base32/base36 token (default length 4 for readability).
- Validate non-existence in all type folders.
- Retry with bounded attempts; on repeated collision, increase token length.

### 8.3 Normalization

Input normalization MUST:

- Trim whitespace
- Accept optional leading `#`
- Accept ID with or without configured prefix
- Return canonical stored ID string

Examples (prefix `pm-`):

- `#a1b2` -> `pm-a1b2`
- `a1b2` -> `pm-a1b2`
- `pm-a1b2` -> `pm-a1b2`
- `PM-A1B2` -> `pm-a1b2`

## 9) History and Restore (Hard Requirement)

### 9.1 History file

Path: `.agents/pm/history/<id>.jsonl`  
Append-only; never rewritten for normal operations.

Each line:

- `ts: ISO timestamp`
- `author: string`
- `op: string` (`create`, `update`, `append`, `comment_add`, `files_add`, `restore`, etc.)
- `patch: RFC6902[]` (from previous state to next state on canonical document object)
- `before_hash: string`
- `after_hash: string`
- `message?: string`

Canonical patch document shape:

```json
{
  "metadata": { "...": "..." },
  "body": "markdown text"
}
```

### 9.2 Hashing

- Hash algorithm: SHA-256
- Input: canonical JSON serialization of patch document (stable key order, UTF-8 LF)  
- Digest format: lowercase hex

### 9.3 Restore algorithm

`pm restore <ID> <TIMESTAMP|VERSION>`

1. Resolve item or matching history stream for ID and load full history.
2. Replay patches from initial create through target version/timestamp.
3. Rebuild exact canonical document (`metadata` + `body`).
4. Write item atomically.
5. Append a `restore` history event with patch from pre-restore state to restored state.

Guarantees:

- History is immutable (restore appends, never rewrites old entries).
- Restored item bytes match canonical serialization of target state exactly.

### 9.4 Missing history stream policy

`settings.history.missing_stream` controls missing-stream behavior for history-touching command paths:

- `auto_create` (default): create missing streams for existing item IDs, then continue command execution.
- `strict_error`: fail fast when a required stream is missing.

Scope: this policy applies to read/diagnostic paths (`history`, `activity`, `stats`, `health`) and existing-item mutation/restore flows.

### 9.5 Sprint/release format policy

`settings.validation.sprint_release_format` controls `--sprint` and `--release` behavior for `create`/`update`:

- `warn` (default): accept non-conforming values and emit deterministic warnings.
- `strict_error`: reject non-conforming values with deterministic usage errors.

Conforming value pattern: `^[A-Za-z0-9][A-Za-z0-9._/-]*$` (max 64 characters, no spaces).

### 9.6 Metadata validation profile policy

`settings.validation.metadata_profile` controls default required-field behavior for `pm validate --check-metadata`:

- `core` (default): baseline required fields (`author`, `acceptance_criteria`, `estimated_minutes`, and `close_reason` for closed items).
- `strict`: extends core with additional governance fields (`reviewer`, `risk`, `confidence`, `sprint`, `release`).
- `custom`: uses `settings.validation.metadata_required_fields` as the required field set.

`settings.validation.metadata_required_fields` accepts deterministic required-field selectors:

- `author`
- `acceptance_criteria`
- `estimated_minutes`
- `close_reason`
- `reviewer`
- `risk`
- `confidence`
- `sprint`
- `release`

If `metadata_profile=custom` and `metadata_required_fields` is empty, runtime falls back to core required fields and emits warning `validate_metadata_custom_profile_missing_required_fields:0`.

`pm validate --metadata-profile <core|strict|custom>` can override configured profile per invocation.

### 9.7 Test-result tracking policy

`settings.testing.record_results_to_items` controls whether linked-test executions append bounded `test_runs` summaries to item front matter:

- `false` (default): command output only; no item mutation for run summaries.
- `true`: `pm test --run` and `pm test-all` append deterministic summary entries (`run_id`, `kind`, `status`, counts, timestamps) with bounded retention.

Background executions (`--background`) reuse the same run pipeline and therefore follow the same policy gate.

## 10) Concurrency, Claiming, Locking, Safe Writes

### 10.1 Assignee identity

- If `--author` is provided for a mutating command, that value is the active assignee identity.
- Else if `PM_AUTHOR` is set, use it.
- Else use `settings.author_default`.
- Else fallback to `"unknown"`.

### 10.2 Lock file format

Path: `.agents/pm/locks/<id>.lock`

```json
{
  "id": "pm-a1b2",
  "pid": 12345,
  "owner": "maintainer-agent",
  "created_at": "2026-02-17T11:15:03.120Z",
  "ttl_seconds": 1800
}
```

### 10.3 Lock behavior

- Acquire lock via exclusive open.
- If lock exists and not stale -> conflict exit code `4`.
- If stale:
  - without `--force`: conflict with stale-lock hint
  - with `--force`: steal lock and continue

### 10.4 Atomic write contract

For any mutation:

1. Acquire lock.
2. Read current item.
3. Compute `before_hash`.
4. Apply mutation to in-memory canonical model.
5. Update `updated_at`.
6. Compute patch and `after_hash`.
7. Write item to temp file in same filesystem.
8. `rename` temp -> target (atomic replace).
9. Append history line atomically.
10. Release lock.

If any step fails, return non-zero exit code and preserve prior item bytes.

## 11) Command Surface and Exit Codes

### 11.1 Global flags (all commands)

- `--json` output JSON instead of TOON
- `--quiet` suppress stdout
- `--path <dir>` override project root path for invocation
- `--no-extensions` disable extension loading
- `--explain` render extended rationale/examples in help output
- `--profile` print deterministic timing diagnostics (stderr)
- `--version` print CLI version

Default output note:

- Core default remains TOON.
- Default TOON output renders command payloads directly and applies sparse compaction (omit `null`/`undefined`/empty arrays/empty objects).
- `pm calendar` is a deliberate exception and defaults to markdown unless explicitly overridden by `--format` or `--json`.
- Runtime output is terminal-neutral plain text (TOON/JSON/markdown) with no required terminal-specific OSC/ANSI control protocol.
- Error handling should preserve exit-code mapping while preferring graceful process termination semantics (`process.exitCode`) over forced synchronous exits when feasible.
- Linked test execution should prefer spawn-based shell-compatible orchestration over buffered one-shot capture, so long runs remain observable in emulated terminals.
- Interactive linked test runs should emit deterministic stderr heartbeat progress events while commands are still running.
- Long-running command paths that support explicit progress controls (`pm test`, `pm test-all`, `pm reindex`) should expose additive `--progress` behavior for non-interactive runs without changing default output contracts.

Help and error UX note:

- Command help should default to compact token-efficient guidance (`Intent` + one high-signal example) and support an explicit deep-help surface via `--explain`.
- `pm help` and `pm help <command>` should remain deterministic success flows for known command paths; unavailable-command help requests should emit explicit `unknown command '<name>'` guidance with usage exit semantics.
- `--help --json` should emit machine-readable help payloads instead of text help.
- Usage and runtime errors should be rendered from one canonical guidance model:
  - text mode: structured sections for what happened, what is required, why, examples, and optional next steps
  - `--json` mode: machine-readable envelope (`type`, `code`, `title`, `detail`, `required`, `exit_code`, optional `why/examples/next_steps`)

### 11.2 Exit codes

- `0` success
- `1` generic failure
- `2` usage / invalid args
- `3` not found
- `4` conflict (claim/lock/ownership)
- `5` dependency failed (for orchestration failures, `pm test-all`, and `pm test --run` when linked test run results fail)

### 11.3 Core commands (required for v0.1 release-ready scope)

- `pm init [<PREFIX>]`
- `pm extension [target] --install|--uninstall|--explore|--manage|--doctor|--adopt|--activate|--deactivate [--project|--local|--global] [--gh|--github <owner/repo[/path]>] [--ref <ref>]`
- `pm list`
- `pm list-all`
- `pm list-draft`
- `pm list-open`
- `pm list-in-progress`
- `pm list-blocked`
- `pm list-closed`
- `pm list-canceled`
- `pm aggregate`
- `pm dedupe-audit`
- `pm get <ID>`
- `pm search <keywords>`
- `pm reindex`
- `pm calendar` (alias: `pm cal`)
- `pm context` (alias: `pm ctx`)
- `pm create`
- `pm templates save <NAME>`
- `pm templates list`
- `pm templates show <NAME>`
- `pm update <ID>`
- `pm update-many`
- `pm append <ID>`
- `pm claim <ID>`
- `pm release <ID>`
- `pm start-task <ID>`
- `pm pause-task <ID>`
- `pm close-task <ID> <TEXT>`
- `pm delete <ID>`
- `pm comments <ID> [TEXT]`
- `pm comments-audit`
- `pm notes <ID> [TEXT]`
- `pm learnings <ID> [TEXT]`
- `pm files <ID>`
- `pm docs <ID>`
- `pm deps <ID>`
- `pm test <ID>`
- `pm test-all`
- `pm test-runs <list|status|logs|stop|resume>`
- `pm stats`
- `pm health`
- `pm validate`
- `pm gc`
- `pm history <ID>`
- `pm activity`
- `pm restore <ID> <TIMESTAMP|VERSION>`
- `pm config <project|global> set definition-of-done --criterion <text>`
- `pm config <project|global> get definition-of-done`
- `pm config <project|global> set item-format --format toon`
- `pm config <project|global> get item-format`
- `pm config <project|global> set history-missing-stream-policy --policy auto_create|strict_error`
- `pm config <project|global> get history-missing-stream-policy`
- `pm config <project|global> set sprint-release-format-policy --policy warn|strict_error`
- `pm config <project|global> get sprint-release-format-policy`
- `pm config <project|global> set parent-reference-policy --policy warn|strict_error`
- `pm config <project|global> get parent-reference-policy`
- `pm config <project|global> set test-result-tracking --policy enabled|disabled`
- `pm config <project|global> get test-result-tracking`
- `pm config <project|global> list`
- `pm config <project|global> export`
- `pm close <ID> <TEXT>`
- `pm beads import [--file <path>]`
- `pm todos import [--folder <path>]`
- `pm todos export [--folder <path>]`
- `pm completion <bash|zsh|fish>`
- `pm completion-tags` (internal helper command used by generated completion scripts)

Roadmap commands (post-v0.1, tracked but not release blockers):

- No additional command-path roadmap entries are currently defined.

### 11.4 Extended flags (minimum)

Mutating `create` (all schema fields MUST be passable explicitly):

- `--title`, `-t` (required)
- `--description`, `-d` (required; empty string allowed when explicitly passed)
- `--type` (required; allowed values are resolved from the runtime item-type registry: built-ins + `settings.item_types.definitions` + extension registrations)
- `--create-mode`, `--create_mode` (optional; `strict` default, or `progressive` for staged creation that relaxes type-level required create fields/repeatables)
- `--status`, `-s` (required in strict mode; defaults to `open` in progressive mode when omitted)
- `--priority`, `-p` (required in strict mode; defaults to `2` in progressive mode when omitted)
- `--tags` (required in strict mode; defaults to empty list in progressive mode when omitted)
- `--body`, `-b` (required in strict mode; defaults to empty body in progressive mode when omitted)
- `--deadline` (explicit; accepts ISO/date strings or relative `+6h/+1d/+2w/+6m`)
- `--estimate`, `--estimated-minutes`, `--estimated_minutes` (explicit; accepts `0`)
- `--acceptance-criteria`, `--acceptance_criteria`, `--ac` (explicit; empty allowed)
- `--author` (explicit; fallback `PM_AUTHOR`/settings allowed)
- `--message` (explicit history message; empty allowed)
- `--template` (optional; reusable defaults loaded from `pm templates save <NAME>`)
- `--assignee` (explicit; clear with `--unset assignee`)
- `--parent` (optional; item ID reference; clear with `--unset parent`; missing-parent behavior controlled by `settings.validation.parent_reference`)
- `--reviewer` (optional; clear with `--unset reviewer`)
- `--risk` (optional; `low|med|medium|high|critical`; clear with `--unset risk`; `med` persists as `medium`)
- `--confidence` (optional; `0..100|low|med|medium|high`; clear with `--unset confidence`; `med` persists as `medium`)
- `--sprint` (optional; clear with `--unset sprint`; format policy controlled by `settings.validation.sprint_release_format`)
- `--release` (optional; clear with `--unset release`; format policy controlled by `settings.validation.sprint_release_format`)
- `--blocked-by`, `--blocked_by` (optional; item ID or free-text; clear with `--unset blocked-by`)
- `--blocked-reason`, `--blocked_reason` (optional; clear with `--unset blocked-reason`)
- `--unblock-note`, `--unblock_note` (optional; unblock rationale note; clear with `--unset unblock-note`)
- `--reporter` (optional; issue reporter; clear with `--unset reporter`)
- `--severity` (optional; `low|med|medium|high|critical`; clear with `--unset severity`; `med` persists as `medium`)
- `--environment` (optional; issue environment context; clear with `--unset environment`)
- `--repro-steps`, `--repro_steps` (optional; issue reproduction steps; clear with `--unset repro-steps`)
- `--resolution` (optional; issue resolution summary; clear with `--unset resolution`)
- `--expected-result`, `--expected_result` (optional; issue expected behavior; clear with `--unset expected-result`)
- `--actual-result`, `--actual_result` (optional; issue observed behavior; clear with `--unset actual-result`)
- `--affected-version`, `--affected_version` (optional; impacted version identifier; clear with `--unset affected-version`)
- `--fixed-version`, `--fixed_version` (optional; fixed version identifier; clear with `--unset fixed-version`)
- `--component` (optional; owning component; clear with `--unset component`)
- `--regression` (optional; boolean `true|false|1|0`; clear with `--unset regression`)
- `--customer-impact`, `--customer_impact` (optional; customer impact summary; clear with `--unset customer-impact`)
- `--definition-of-ready`, `--definition_of_ready` (optional; explicit empty allowed; clear with `--unset definition-of-ready`)
- `--order`, `--rank` (optional; integer rank/order; clear with `--unset order`)
- `--goal` (optional; clear with `--unset goal`)
- `--objective` (optional; clear with `--unset objective`)
- `--value` (optional; clear with `--unset value`)
- `--impact` (optional; clear with `--unset impact`)
- `--outcome` (optional; clear with `--unset outcome`)
- `--why-now`, `--why_now` (optional; clear with `--unset why-now`)

Mutating `create` flags (repeatable; strict mode may require each at least once depending on type policy, while progressive mode allows staged omission; clear with explicit `--clear-*` flags):

- `--dep` value format: `id=<id>,kind=<blocks|parent|child|parent_child|child_of|related|related_to|discovered_from|blocked_by|incident_from|epic|supersedes|task>,author=<a>,created_at=<iso|now>,source_kind=<value?>` (also accepts markdown `key: value` lines and stdin token `-`)
- `--comment` value format: `author=<a>,created_at=<iso|now>,text=<t>` (also accepts markdown `key: value` lines and stdin token `-`)
- `--note` value format: `author=<a>,created_at=<iso|now>,text=<t>` (also accepts markdown `key: value` lines and stdin token `-`)
- `--learning` value format: `author=<a>,created_at=<iso|now>,text=<t>` (also accepts markdown `key: value` lines and stdin token `-`)
- Log-seed repeatables (`--comment`/`--note`/`--learning`) accept only `author`, `created_at`, and `text` keys. Parsed extra keys are rejected with usage guidance to avoid silent truncation when unquoted comma segments resemble key/value pairs; quoted text (`text="hello,scope:project"`), markdown key/value input, and stdin token `-` remain supported.
- `--file` value format: `path=<p>,scope=<project|global>,note=<n?>` (also accepts markdown `key: value` lines and stdin token `-`)
- `--test` value format: `command=<c>,path=<p?>,scope=<project|global>,timeout_seconds=<n?>,env_set=<KEY=VALUE;...?>,env_clear=<KEY;...?>,shared_host_safe=<bool?>,note=<n?>` (also accepts markdown `key: value` lines and stdin token `-`; `command` is required and `path` is optional metadata)
- `--doc` value format: `path=<p>,scope=<project|global>,note=<n?>` (also accepts markdown `key: value` lines and stdin token `-`)
- `--reminder` value format: `at=<iso|date|relative>,text=<text>` (also accepts markdown `key: value` lines and stdin token `-`; use `--clear-reminders` to clear)
- `--type-option` / `--type_option` value format: `key=value`, `key:value`, or `key=<name>,value=<value>` (also accepts markdown `key: value` lines and stdin token `-`; use `--clear-type-options` to clear)

Per-type option policy overrides (`settings.item_types.definitions[]` and extension `registerItemTypes(...)`):

- `command_option_policies[].command`: `create` or `update`
- `command_option_policies[].option`: canonical option key (for example `message`, `severity`, `typeOption`)
- `required: true|false`: mark option mandatory/optional for the targeted command and type
- `enabled: true|false`: reject/allow the option at runtime for the targeted command and type
- `visible: true|false`: show/hide the option in policy-aware help guidance

Help and error guidance:

- `pm create --help` / `pm update --help` accept `--type <value>` to render policy-aware required/disabled/hidden option summaries plus type-option schema details (required marker, allowed values, aliases, description).
- Missing `--type` usage errors include rationale, active allowed values, and custom-type examples.
- Type-governed create validation aggregates all missing required create options and required `--type-option` keys into one deterministic usage error payload (stable flag ordering) instead of iterative one-at-a-time failures.
- Aggregated create/type-option validation guidance includes a deterministic type-specific "next valid example" command for one-shot remediation.
- Commander usage errors are normalized into a single structured guidance payload (duplicate default commander stderr messaging is not emitted).
- Runtime `PmCliError` paths should surface structured guidance while preserving canonical exit-code mapping, with machine-readable JSON error envelopes when `--json` is active.

Mutating `update` (v0.1 baseline):

- `--title`, `-t`
- `--description`, `-d`
- `--body`, `-b` (explicit empty string allowed; use `pm append --body` for additive narrative updates)
- `--status`, `-s`
- `--priority`, `-p`
- `--type`
- `--tags`
- `--deadline`
- `--estimate`, `--estimated-minutes`, `--estimated_minutes`
- `--acceptance-criteria`, `--acceptance_criteria`, `--ac`
- `--assignee`
- `--parent` (missing-parent behavior controlled by `settings.validation.parent_reference`)
- `--reviewer`
- `--risk` (`low|med|medium|high|critical`; `med` persists as `medium`)
- `--confidence` (`0..100|low|med|medium|high`; `med` persists as `medium`)
- `--sprint` (format policy controlled by `settings.validation.sprint_release_format`)
- `--release` (format policy controlled by `settings.validation.sprint_release_format`)
- `--blocked-by`, `--blocked_by`
- `--blocked-reason`, `--blocked_reason`
- `--unblock-note`, `--unblock_note`
- `--reporter`
- `--severity` (`low|med|medium|high|critical`; `med` persists as `medium`)
- `--environment`
- `--repro-steps`, `--repro_steps`
- `--resolution`
- `--expected-result`, `--expected_result`
- `--actual-result`, `--actual_result`
- `--affected-version`, `--affected_version`
- `--fixed-version`, `--fixed_version`
- `--component`
- `--regression` (`true|false|1|0`)
- `--customer-impact`, `--customer_impact`
- `--definition-of-ready`, `--definition_of_ready`
- `--order`, `--rank`
- `--goal`
- `--objective`
- `--value`
- `--impact`
- `--outcome`
- `--why-now`, `--why_now`
- `--author`
- `--message`
- `--allow-audit-update`, `--allow_audit_update` (ownership-safe non-owner metadata update mode; intentionally disallows lifecycle/ownership/linkage field mutations in this mode)
- `--allow-audit-dep-update`, `--allow_audit_dep_update` (ownership-safe non-owner append-only dependency update mode; requires at least one `--dep` and is mutually exclusive with `--allow-audit-update`)
- `--dep` (repeatable add format `id=<id>,kind=<...>,author=<a?>,created_at=<iso|now>,source_kind=<value?>`; use `--clear-deps` to clear all dependencies)
- `--dep-remove`, `--dep_remove` (repeatable selector remove by `id` or `id=<id>,kind=<kind?>,source_kind=<value?>`)
- `--comment` (repeatable log seed; supports plain-text shorthand for comment text, or structured `author=<a>,created_at=<iso|now>,text=<t>`; use `--clear-comments` to clear comments)
- `--note` (repeatable log seed format `author=<a>,created_at=<iso|now>,text=<t>`; use `--clear-notes` to clear notes)
- `--learning` (repeatable log seed format `author=<a>,created_at=<iso|now>,text=<t>`; use `--clear-learnings` to clear learnings)
- `--file` (repeatable linked-file format `path=<p>,scope=<project|global>,note=<n?>`; use `--clear-files` to clear files)
- `--test` (repeatable linked-test format `command=<c>,path=<p?>,scope=<project|global>,timeout_seconds=<n?>,...`; use `--clear-tests` to clear tests)
- `--doc` (repeatable linked-doc format `path=<p>,scope=<project|global>,note=<n?>`; use `--clear-docs` to clear docs)
- `--reminder` (repeatable `at=<iso|date|relative>,text=<text>`; use `--clear-reminders` to clear)
- `--event` (repeatable event metadata format; use `--clear-events` to clear)
- `--type-option`, `--type_option` (repeatable type option metadata; use `--clear-type-options` to clear)

`pm update` status semantics:

- `--status` supports all non-terminal values plus `canceled`.
- `--status closed` is not supported; callers must use `pm close <ID> <TEXT>` so `close_reason` is always captured.
- `--close-reason`, `--close_reason` support explicit close-reason set; clear with `--unset close-reason`.
- Reopen transition safety: moving from `closed` to a non-terminal status via `--status` auto-clears stale `close_reason` unless `--close-reason` is explicitly provided on that update call.

`pm update-many` (bulk mutation with native checkpoint lifecycle):

- Targeting filters: `--filter-status`, `--filter-type`, `--filter-tag`, `--filter-priority`, `--filter-parent`, `--filter-deadline-before`, `--filter-deadline-after`, `--filter-assignee`, `--filter-assignee-filter`, `--filter-sprint`, `--filter-release`
- Paging scope controls: `--limit`, `--offset`
- Apply payload: `pm update` mutation parity, including scalar/unset metadata flags plus linked-array repeatables (`--dep`, `--comment`, `--note`, `--learning`, `--file`, `--test`, `--doc`, `--reminder`, `--event`), explicit `--clear-*` controls, and atomic replacement flags (`--replace-deps`, `--replace-tests`)
- Workflow controls:
  - `--dry-run` (preview planned per-item changes without mutation)
  - `--rollback <checkpoint-id>` (restore a prior checkpoint snapshot)
  - `--no-checkpoint` (disable apply-mode checkpoint capture)
- Safety rule: `--rollback` is exclusive with mutation payload flags.

List/search filters:

- `--type`
- `--tag`
- `--priority`
- `--parent` (`list*` commands; exact match on parent item ID for hierarchical scoping)
- `--limit`
- `--offset` (`list*` commands; apply offset before limit for deterministic pagination)
- `--stream` (`list*` commands; JSON-only newline-delimited item streaming)
- `--deadline-before`
- `--deadline-after`
- `--assignee` (exact match on `assignee` field)
- `--assignee-filter assigned|unassigned` (assignee presence filter)
- `--sprint` (exact match on `sprint` field)
- `--release` (exact match on `release` field)
- `--include-body` (list* only; when enabled, each returned item includes `body`; default list rows remain front-matter-only)
- `--compact` / `--fields <csv>` (`list*` projection controls; mutually exclusive)
- `--sort <priority|deadline|updated_at|created_at|title|parent>` + `--order <asc|desc>` (`list*` deterministic sort controls; `--order` requires `--sort`)
- `--compact` / `--full` / `--fields <csv>` (`search` only; mutually exclusive projection controls, default compact)

Command-specific query and contract flags:

- `pm comments-audit`: `--latest <n>` (`0` allowed for summary-only rows), `--full-history` (mutually exclusive with `--latest`)
- `pm calendar`: `--full-period` (day/week/month full anchored window; invalid for agenda)
- `pm activity`: `--id`, `--op`, `--author`, `--from`, `--to`, `--stream [rows|ndjson|jsonl]` (`--stream` requires `--json`)
- `pm contracts`: `--flags-only`, `--availability-only` (mutually exclusive), command-scoped default behavior when `--command` is provided
- `pm contracts`: command flag/alias payloads include both canonical flag rows and commander alias metadata (`command_flags` + `commander_aliases`) for machine consumers
- `pm completion`: `--eager-tags` (legacy eager embedding; default generated scripts use lazy runtime tag lookup via `pm completion-tags`)

Mutation safety:

- `--author`
- `--message`
- `--force`

### 11.5 Command input/output contracts

All commands return deterministic top-level objects (TOON by default, JSON with `--json`).

Canonical command/action schema metadata is centralized in `src/sdk/cli-contracts.ts` and reused across:

- commander normalization in `src/cli/main.ts`
- shell completion generation in `src/cli/commands/completion.ts`
- Pi wrapper `inputSchema` + action mapping in `.pi/extensions/pm-cli/index.ts`

Contract compatibility policy keeps command names/flags/aliases stable while allowing stricter machine contracts:

- Existing CLI command paths and aliases remain valid.
- Pi tool input validation uses strict action-scoped schema branches (schema v4) with per-action required fields and `additionalProperties: false`.
- `pm contracts` provides deterministic runtime contract introspection (`--action`, `--command`, `--schema-only`, `--runtime-only`, `--active-only`) for agent callers, including action availability metadata (`action_availability`) with invocability/provider diagnostics and additive extension command/action schema inclusion (`extension_commands`).
- Intentional compatibility exception: `pm contracts --command <name>` now narrows command/action/availability output to that selected command by default to reduce machine payload noise (omit `--command` for full corpus output).
- `pm contracts --flags-only` and `pm contracts --availability-only` provide mutually exclusive lightweight projections for machine consumers.
- Shell completion generation is sourced from the same normalized contract registry so parser/runtime/contracts/completion flag parity remains deterministic (including alias candidates).
- Command output remains deterministic; `--json` exposes command-contract machine payloads and JSON error envelopes.

| Command | Key inputs | Output object |
| --- | --- | --- |
| `pm init [PREFIX]` | optional prefix, `--path` | `{ ok, path, settings, created_dirs, warnings }` |
| `pm extension [target] --install\|--uninstall\|--explore\|--manage\|--doctor\|--adopt\|--adopt-all\|--activate\|--deactivate` | exactly one lifecycle action, optional `target` (required for install/uninstall/activate/deactivate/adopt; disallowed for `adopt-all`; `doctor` supports `pm extension doctor` target syntax), scope flags (`--project` default, `--local` alias, `--global`), install/adopt source selectors (`target`, `--gh`, `--github`, optional `--ref`), bundled aliases (`beads`, `todos`), doctor detail mode (`--detail summary\|deep`), doctor trace mode (`--trace` with deep detail), manage runtime parity probe (`--runtime-probe`), optional managed-state remediation (`--fix-managed-state`), doctor strict warning exits (`--strict-exit`, alias `--fail-on-warn`); top-level action and subcommand forms share the same flag forwarding (`pm extension --doctor ...` == `pm extension doctor ...`) | `{ ok, action, scope, roots, warnings, details }` where `details` is action-specific: `explore/manage` include per-extension state/status fields (`active` compatibility alias, `enabled`, `runtime_active`, `activation_status`) plus `update_check_status`/`update_check_reason`; `manage` includes optional `runtime_probe` and `managed_state_fix` metadata; `manage`/`doctor` include triage rollups (`warning_codes`, `update_health_coverage`, `update_health_partial`, `update_check_status_totals`, remediation) with top-level warning parity; doctor summary includes blocking-failure indicators (`blocking_failure_count`, `has_blocking_failures`), trace status (`trace_enabled`), and capability metadata (`capability_contract_version`/`capability_guidance`/`capability_contract`); `adopt` reports adoption result/provenance (`adopted`, `already_managed?`, `source`) without reinstalling extension files; `adopt-all` reports bulk adoption totals and per-extension adoption rows |
| `pm list` | optional filter flags (including `--parent`, `--include-body`, `--compact`, `--fields`, `--sort`, `--order`, `--offset`, and JSON-only `--stream`); excludes terminal statuses (`closed`, `canceled`) by default | `{ items, count, filters, projection, sorting, now }` (or streamed newline-delimited rows when `--json --stream`) |
| `pm list-all` | optional filter flags (including `--parent`, `--include-body`, `--compact`, `--fields`, `--sort`, `--order`, `--offset`, and JSON-only `--stream`); includes all statuses including terminal | `{ items, count, filters, projection, sorting, now }` (or streamed newline-delimited rows when `--json --stream`) |
| `pm list-draft` | optional type/tag/priority/parent/deadline/assignee/sprint/release/include-body/compact/fields/sort/order/offset filters plus JSON-only stream mode | `{ items, count, filters, projection, sorting, now }` (or streamed newline-delimited rows when `--json --stream`) |
| `pm list-open` | optional type/tag/priority/parent/deadline/assignee/sprint/release/include-body/compact/fields/sort/order/offset filters plus JSON-only stream mode | `{ items, count, filters, projection, sorting, now }` (or streamed newline-delimited rows when `--json --stream`) |
| `pm list-in-progress` | same as above | `{ items, count, filters, now }` |
| `pm list-blocked` | same as above | `{ items, count, filters, now }` |
| `pm list-closed` | same as above | `{ items, count, filters, now }` |
| `pm list-canceled` | same as above | `{ items, count, filters, now }` |
| `pm aggregate` | grouped-count governance query (`--group-by parent,type` default; supported dimensions: `parent,type,priority,status,assignee,tags,sprint,release`; `--count` accepted for explicit parity) with list-like filters and optional `--include-unparented` | `{ groups, count, totals, filters, now, warnings? }` |
| `pm dedupe-audit` | duplicate-audit query with `--mode title_exact|title_fuzzy|parent_scope`, optional `--threshold`, optional `--limit`, and list-like filters | `{ clusters, count, mode, filters, now, warnings? }` |
| `pm get <ID>` | normalized id | `{ item, body, linked: { files, tests, docs }, claim_state }` where `claim_state` includes current assignee plus latest claim/release history context |
| `pm search <keywords...>` | keyword query tokens + optional mode/include-linked/compact/full/fields/limit filters | `{ query, mode, items, count, filters, projection, now }` |
| `pm reindex` | optional `--mode` (`keyword|semantic|hybrid` baseline) and additive `--progress` stderr visibility | `{ ok, mode, total_items, artifacts, warnings, generated_at }` |
| `pm calendar` / `pm cal` | `--view agenda|day|week|month`, `--date`, `--from`/`--to` (agenda), `--past`, `--full-period` (day/week/month only), list-like filters (`type`, `tag`, `priority`, `status`, `assignee`, `sprint`, `release`, `limit`), source controls (`--include`), and recurrence bounds (`--recurrence-lookahead-days`, `--recurrence-lookback-days`, `--occurrence-limit`) | `{ view, output_default, now, anchor, range, filters, summary, events, days }` where `range` includes period metadata (`period_start`, `period_end`, `full_period`), `summary` includes deterministic aggregate breakdown fields (`by_kind`, `by_type`, `by_status`, `recurring_events`), and markdown output includes rich event detail tokens by default |
| `pm context` / `pm ctx` | `--date`, `--from`/`--to`, `--past`, list-like filters (`type`, `tag`, `priority`, `assignee`, `sprint`, `release`, `limit`), `--format` | `{ output_default, now, window, filters, summary, high_level, low_level, blocked_fallback, agenda }` (defaults to TOON unless `--format` or `--json` override) |
| `pm beads import [--file <path\|->] [--preserve-source-ids]` | optional Beads JSONL source path (`.beads/issues.jsonl` auto-discovered first, then `issues.jsonl`; implicit `sync_base.jsonl` fallback is refused as unsafe; `--file -` requires piped stdin and fails fast on interactive TTY stdin) | `{ ok, source, imported, skipped, ids, warnings }` |
| `pm todos import --folder <path?>` | optional todos markdown source folder (defaults to `.pi/todos`); preserves canonical optional `ItemMetadata` fields when present and applies deterministic defaults for missing PM fields | `{ ok, folder, imported, skipped, ids, warnings }` |
| `pm todos export --folder <path?>` | optional todos markdown destination folder (defaults to `.pi/todos`) | `{ ok, folder, exported, ids, warnings }` |
| `pm create ...` | required `--title` + `--description` + `--type`; strict mode is default (`--create-mode strict`) and enforces type-governed required options; progressive mode (`--create-mode progressive`) supports staged omission of type-level required create fields/repeatables; optional `--template` reusable defaults | `{ item, changed_fields, warnings }` |
| `pm templates save <NAME> ...` | template name + create-compatible option payload (subset of create flags, including repeatable entries) | `{ name, path, template, saved_at }` |
| `pm templates list` | optional output controls (`--json`/TOON) | `{ templates, count }` |
| `pm templates show <NAME>` | template name | `{ name, template }` |
| `pm update <ID> ...` | id + patch-like flags (`--status closed` is rejected; use `pm close <ID> <TEXT>`; `--close-reason`/`--close_reason` explicitly set `close_reason`; `--unset close-reason` clears it; reopening from `closed` to a non-terminal status auto-clears stale `close_reason` unless explicit `--close-reason` is provided; body replacement is supported via `--body`/`-b`; dependencies are mutable via `--dep` / `--dep-remove` / `--clear-deps` / `--replace-deps` (atomic replacement mode); repeatable transactional linked/log flags `--comment`/`--note`/`--learning`/`--file`/`--test`/`--doc` are supported on update with explicit `--clear-*` semantics; `--allow-audit-update` enables ownership-safe non-owner metadata updates only; `--allow-audit-dep-update` enables append-only non-owner dependency additions via `--dep`) | `{ item, changed_fields, warnings, audit_update? }` |
| `pm update-many` | bulk update orchestration with selection filters (`--filter-*` family), update payload parity with scalar + linked-array update flags (`--dep/--comment/--note/--learning/--file/--test/--doc/--reminder/--event`, `--clear-*`, `--replace-deps`, `--replace-tests`), and workflow controls (`--dry-run`, `--rollback <checkpoint-id>`, `--no-checkpoint`) | apply: `{ mode, matched_count, dry_run, ids, updated_count, skipped_count, failed_count, checkpoint?, rows }`; dry-run: `{ mode, matched_count, dry_run, ids, filters, planned_update_options, item_plans }` where `item_plans[].changes` includes linked-array mutation intent summaries; rollback: `{ mode, matched_count, dry_run, ids, rollback_checkpoint_id, restored_count, failed_count, rows }` |
| `pm delete <ID>` | id + optional `--author`/`--message`/`--force` | `{ item, changed_fields, warnings }` |
| `pm close <ID> <TEXT>` | id + close reason text + optional `--author/--message/--force/--validate-close [warn|strict]` | `{ item, changed_fields, warnings }` |
| `pm append <ID> --body` | id + appended markdown (`--body -` reads piped stdin) | `{ item, appended, changed_fields }` |
| `pm claim <ID>` | id, optional `--author`/`--message`/`--force` (`--force` required for terminal/lock override paths; non-terminal assignee takeover does not require force) | `{ item, claimed_by, previous_assignee, forced }` |
| `pm release <ID>` | id, optional `--author`/`--message`/`--allow-audit-release`/`--force` | `{ item, released_by, previous_assignee, audit_release, forced }` |
| `pm start-task <ID>` | lifecycle alias command (`claim` + `update --status in_progress`) with optional `--author`, `--message`, `--force` | `{ id, action: "start_task", claim, update }` |
| `pm pause-task <ID>` | lifecycle alias command (`update --status open` + `release`) with optional `--author`, `--message`, `--force` | `{ id, action: "pause_task", update, release }` |
| `pm close-task <ID> <TEXT>` | lifecycle alias command (`close` + `release`) with optional `--author`, `--message`, `--validate-close`, `--force` | `{ id, action: "close_task", close, release }` |
| `pm comments <ID> [TEXT] --add/--stdin/--file/--limit` | id + optional positional comment text shorthand + comment text/limit (`--add` accepts plain text, `text=<value>`, markdown `text: <value>`, or stdin token `-`; `--stdin` reads multiline markdown from piped stdin; `--file <path>` reads multiline markdown from a file; positional `TEXT` is shorthand for `--add <TEXT>`; ambiguous CSV-like key fragments such as `text=hello,scope:project` remain plain text unless `text` is explicit); exactly one comment source must be provided per mutation invocation (`[TEXT]`, `--add`, `--stdin`, or `--file`); optional mutation metadata flags `--author`/`--message`/`--force`; additive ownership-safe audit path `--allow-audit-comment` for non-owner append-only comments | `{ id, comments, count }` |
| `pm comments-audit` | optional governance filters (`--status`, `--type`, `--assignee`, `--assignee-filter`, `--parent`, `--tag`, `--sprint`, `--release`, `--priority`, `--limit-items`) plus latest/full-history export mode controls (`--latest`, `--full-history`; mutually exclusive, `--latest 0` allowed for summary-only rows) | `{ items, count, summary, filters, export, now, warnings? }` where `summary` includes additive totals/coverage/by-type metrics, `filters.full_history` and `export.mode` indicate latest vs full-history behavior, and `export.row_count` is deterministic (`0` in summary-only latest mode); in full-history mode, `rows[]` includes flat per-comment export entries for NDJSON-friendly downstream processing |
| `pm notes <ID> [TEXT] --add/--limit` | id + optional positional note text shorthand + note text/limit (`--add` accepts plain text, `text=<value>`, markdown `text: <value>`, or stdin token `-`; positional `TEXT` is shorthand for `--add <TEXT>`; ambiguous CSV-like key fragments such as `text=hello,scope:project` remain plain text unless `text` is explicit); optional mutation metadata flags `--author`/`--message`/`--force`; additive ownership-safe audit path `--allow-audit-comment` for non-owner append-only notes | `{ id, notes, count }` |
| `pm learnings <ID> [TEXT] --add/--limit` | id + optional positional learning text shorthand + learning text/limit (`--add` accepts plain text, `text=<value>`, markdown `text: <value>`, or stdin token `-`; positional `TEXT` is shorthand for `--add <TEXT>`; ambiguous CSV-like key fragments such as `text=hello,scope:project` remain plain text unless `text` is explicit); optional mutation metadata flags `--author`/`--message`/`--force`; additive ownership-safe audit path `--allow-audit-comment` for non-owner append-only learnings | `{ id, learnings, count }` |
| `pm files <ID> --add/--add-glob/--remove/--migrate/--append-stable/--validate-paths/--audit/--list`; `pm files discover <ID> [--apply]` | id + file refs (`--add/--remove` accept CSV key/value, markdown `key: value`, or stdin token `-`); optional glob expansion via repeatable `--add-glob` (plain glob or `pattern=<glob>,scope=<scope>,note=<text>`); optional additive linked-path hygiene (`--migrate from=<old>,to=<new>`, path existence validation, cross-item audit, non-mutating list); optional `--append-stable` avoids full-array resorting and appends new links while preserving current order; `discover` scans item text for existing project/global file paths, skips already linked files, and writes missing links only with `--apply` | standard files: `{ id, files, changed, count, migrations_applied, validation, audit }`; discover: `{ id, files, changed, apply, count, candidate_count, addable_count, added_count, skipped_existing_count, candidates, added, skipped_existing }` |
| `pm test <ID> --add/--remove/--run` | id + test refs/options (`--add/--remove` accept CSV key/value, markdown `key: value`, or stdin token `-`; new linked test entries must include `command=...` and may include `path=...` as optional metadata; optional linked-test runtime directives support `env_set`, `env_clear`, `shared_host_safe`, optional per-test context override `pm_context_mode=schema\|tracker\|auto`, and assertion metadata fields `assert_stdout_contains` / `assert_stdout_regex` / `assert_stderr_contains` / `assert_stderr_regex` / `assert_stdout_min_lines` / `assert_json_field_equals` / `assert_json_field_gte`; run-time supports additive `--background`, `--env-set`, `--env-clear`, `--shared-host-safe`, `--pm-context schema\|tracker\|auto`, `--check-context`, `--auto-pm-context`, `--fail-on-context-mismatch`, `--fail-on-skipped`, `--fail-on-empty-test-run`, and `--require-assertions-for-pm`; path-only add/create entries are rejected; reject recursive `test-all` linked commands at add-time, including global-flag and package-spec launcher forms such as `pm --json test-all`, `npx @unbrained/pm-cli@latest --json test-all`, `pnpm dlx @unbrained/pm-cli@latest --json test-all`, and `npm exec -- @unbrained/pm-cli@latest --json test-all`; defensively skip legacy recursive entries at run-time; reject sandbox-unsafe test-runner commands including unsandboxed direct package-manager run-script forms such as `npm run test`/`pnpm run test` and chained direct runner segments evaluated independently; linked command execution seeds sandbox project/global settings and extensions from source roots for extension/type parity, routes context per test (per-test override > run-level, `auto` routes PM tracker-read commands to tracker mode), fails PM tracker-read command mismatches by default in schema mode, emits `execution_context` metadata (including tracker-read classification plus `requested_pm_context_mode` and `auto_pm_context_applied`) in each run result, supports preflight mismatch summary warnings (`context_preflight`) when requested, supports high-confidence empty-selection detection when requested, and runs linked commands via shell-compatible spawn orchestration with deterministic timeout/maxBuffer diagnostics and structured `failure_category` classification) | foreground: `{ id, tests, run_results, failure_categories, fail_on_skipped_triggered?, warnings?, changed, count }`; background start: `{ started, duplicate_of?, run }` |
| `pm test-all --status --timeout` | optional status filter plus additive run controls `--background`, `--progress`, `--env-set`/`--env-clear`/`--shared-host-safe`/`--pm-context`/`--check-context`/`--auto-pm-context`/`--fail-on-context-mismatch`/`--fail-on-skipped`/`--fail-on-empty-test-run`/`--require-assertions-for-pm` (schema-mode runs fail PM tracker-read command mismatches by default); duplicate linked command/path entries are deduped per invocation (keyed by scope+normalized command or scope+path plus runtime directives + context metadata + assertion metadata) and reported as skipped; when duplicate keys carry different `timeout_seconds`, execution uses deterministic maximum timeout for that key | foreground: `{ totals, failed, passed, skipped, fail_on_skipped_triggered?, warnings?, results }`; background start: `{ started, duplicate_of?, run }` (`totals.failure_categories` included) |
| `pm test-runs [list|status|logs|stop|resume]` | list/status/log/stop/resume lifecycle control for managed background test runs; bare `pm test-runs` defaults to list output (`logs` supports `--stream stdout|stderr|both` and `--tail`; `stop` supports `--force`); run attribution resolves `requested_by` via explicit author -> `PM_AUTHOR` -> settings author default -> env user identifiers -> OS username -> `unknown` | list: `{ runs, count, filters }`; status: `{ run, health }`; logs: `{ run, stream, tail, stdout, stderr }`; stop: `{ run, signal_sent }`; resume: `{ resumed_from, run }` |
| `pm stats` | none | `{ totals, by_type, by_status, generated_at }` |
| `pm health` | none (runs settings/directories/extensions/storage plus integrity, history-drift, and vectorization diagnostics); supports `--strict-directories` to treat optional built-in item-type directories as required warning/failure conditions, strict warning exits (`--strict-exit`, alias `--fail-on-warn`), and vector refresh controls (`--check-only`, `--no-refresh`, `--refresh-vectors`) | `{ ok, checks, warnings, generated_at }` with extension diagnostics including condensed `details.triage`, capability guidance metadata, and directory check details (`required`, `optional`, `missing_required`, `missing_optional`) |
| `pm validate` | optional scoped checks (`--check-metadata`, `--check-resolution`, `--check-lifecycle`, `--check-stale-blockers`, `--check-files`, `--check-command-references`, `--check-history-drift`; default all checks); metadata checks accept `--metadata-profile core|strict|custom`; lifecycle checks surface active closure-like metadata and active items whose parents are terminal, with optional stale blocker heuristics when `--check-stale-blockers` is enabled and settings-backed lifecycle pattern lists (`settings.validation.lifecycle_*_patterns`) controlling substring matching; file checks accept `--scan-mode default|tracked-all|tracked-all-strict` plus `--include-pm-internals` opt-in and report filtered + raw candidate metrics (`candidate_total`, `candidate_scanned`, `candidate_total_raw`, `candidate_scanned_raw`) plus structured exclusion summaries (`excluded_by_reason`); resolution checks include default remediation command templates for missing resolution fields; strict warning exits via `--strict-exit` (alias `--fail-on-warn`) | `{ ok, checks, warnings, generated_at }` where metadata details include profile/source/fallback visibility fields, lifecycle details include deterministic per-category row summaries plus effective lifecycle pattern arrays and per-field pattern-source metadata (`default|settings`), and tracked-all-strict visibility includes explicit file-check detail flags (`strict_mode_forces_pm_internals`, `strict_mode_forces_pm_internals_notice`) plus warning token `validate_files_tracked_all_strict_forces_pm_internals` when strict mode force-enables PM internals |
| `pm config <project\|global> <get\|set\|list\|export> [key]` | scope + action; `get/set` require key, `list/export` reject key; policy/format/criterion flags apply where relevant (criterion-list keys include `definition-of-done`, `metadata-required-fields`, and lifecycle pattern keys `lifecycle-*-patterns`) | `get/set`: existing key-specific result shape; `list`: `{ scope, keys, count, settings_path, changed, warnings? }`; `export`: `{ scope, values, settings_path, changed, warnings? }` |
| `pm gc` | optional `--dry-run` (preview no-side-effect cleanup) and repeatable/comma-delimited `--scope index\|embeddings\|runtime` | `{ ok, dry_run, scope, removed, retained, warnings, guidance, generated_at }` |
| `pm contracts [--action <value>] [--command <value>] [--schema-only] [--runtime-only|--active-only] [--flags-only|--availability-only]` | optional action/command filters, schema-only mode, runtime invocability filtering, and lightweight projection modes; when `--command` is provided, command/action/availability output is narrowed to that selected command by default; when `--action` is provided without `--command`, `--flags-only` command flag output is action-scoped to matching command surfaces | `{ schema_version, schema_id, selected, actions?, action_availability?, commands?, schema?, extension_commands?, command_flags?, commander_aliases?, command_path?, cli_exposed? }` |
| `pm docs <ID> --add/--add-glob/--remove/--migrate/--validate-paths/--audit` | id + doc refs (`--add/--remove` accept CSV key/value, markdown `key: value`, or stdin token `-`); optional glob expansion via repeatable `--add-glob` (plain glob or `pattern=<glob>,scope=<scope>,note=<text>`); optional additive linked-path hygiene (`--migrate from=<old>,to=<new>`, path existence validation, cross-item audit) | `{ id, docs, changed, count, migrations_applied, validation, audit }` |
| `pm deps <ID> --format tree|graph` | id + optional output selector (`tree` default, `graph` for node/edge projection), traversal controls (`--max-depth`), repeat-collapse mode (`--collapse none|repeated`), and count-only summary mode (`--summary`) | `{ id, format, node_count, edge_count, missing_count, tree? graph? }` |
| `pm history <ID> --limit/--diff/--verify` | id + optional limit + additive diagnostics (`--diff` changed-field patch summaries, `--verify` hash-chain/current-hash verification) | `{ id, history, count, limit, diff, verify }` |
| `pm activity --limit` | optional limit plus filters (`--id`, `--op`, `--author`, `--from`, `--to`) and JSON-only stream mode (`--stream [rows|ndjson|jsonl]`) | standard: `{ activity, count, limit, filters }`; stream: line-delimited JSON entries with deterministic `meta` and `entry` records |
| `pm restore <ID> <TIMESTAMP\|VERSION>` | id + restore target + optional `--author/--message/--force` | `{ item, restored_from, changed_fields, warnings }` |
| `pm completion <shell>` | `bash`, `zsh`, or `fish`; supports `--eager-tags` to embed static tag completions; default script mode uses lazy runtime tag lookup via `pm completion-tags`; non-JSON output is the raw script suitable for eval or pipe; JSON output is `{ shell, script, setup_hint }` | `{ shell, script, setup_hint }` |
| `pm completion-tags` | internal helper command returning current tag values for completion script lazy lookup | `{ tags, count }` |

List command row projection:

- Default `list*` rows contain `ItemMetadata` fields only.
- `--compact` projects deterministic compact fields (`id`, `title`, `status`, `type`, `priority`, `parent`, `updated_at`).
- `--fields <csv>` projects caller-selected list fields.
- With `--include-body`, each row additionally includes `body` and `filters.include_body` is `true` (`null` when omitted in JSON; omitted in sparse TOON).
- Without `--include-body`, omission of `body` is intentional for lightweight list payloads; use `pm get <ID>` when full body content is required.
- `--sort` + `--order` emits deterministic `sorting` metadata describing the active sort field and direction.

Roadmap output contracts remain defined in this PRD for extension areas and advanced search tuning that are still out of v0.1 release scope.

## 12) Canonical Output Objects (TOON-first)

All commands return a deterministic top-level object with stable key order.

Examples:

- `list*`:
  - `{ items, count, filters, now }`
  - default rows: `ItemMetadata`
  - with `--include-body`: `ItemMetadata + body`
- `search`:
  - `{ query, mode, items, count, filters, now }`
- `get`:
  - `{ item, body, linked: { files, tests, docs } }`
- `create/update/delete`:
  - `{ item, changed_fields, warnings }` (`update` may also include `audit_update` when `--allow-audit-update` is active)
- `append`:
  - `{ item, appended, changed_fields }`
- `test-all`:
  - `{ totals, failed, passed, skipped, results }`
- roadmap examples (advanced semantic/hybrid tuning expansion) remain post-v0.1.

Determinism requirements:

- Stable key order in every object.
- Stable array order for `items` (default sort: non-terminal before terminal, then priority asc, then updated_at desc, then id asc).
- `pm list` excludes terminal statuses (`closed`, `canceled`) by default; `pm list-all` includes all statuses.
- JSON output preserves command-contract fields (including explicit `null` placeholders where applicable by command contract); `pm search` compact projection is default unless `--full` or `--fields` is provided.
- TOON output is a sparse projection that omits `null`/`undefined`/empty arrays/empty objects while preserving non-empty values.
- `--quiet` prints nothing to stdout but still uses exit codes.
- Stdin token paths requiring piped input fail fast on interactive TTY stdin with actionable guidance instead of waiting indefinitely for EOF.
- Manual interactive EOF guidance remains explicit and cross-platform: `Ctrl+D` (Unix/macOS) and `Ctrl+Z` then `Enter` (Windows).
- Output writes handle broken pipes (`EPIPE`) as expected shell behavior: stdout `EPIPE` preserves success exits for early-closing consumers and stderr `EPIPE` remains non-zero, with unhandled stack traces suppressed.

## 13) Search Architecture

### 13.0 Command contract (implemented baseline)

`pm search <keywords...>` is implemented across keyword, semantic, and hybrid modes with deterministic ordering. The command accepts quoted or unquoted multi-word queries, searches core item corpus fields, supports vector-query execution when configured (or when local Ollama auto-defaults are resolved), and returns stable JSON/TOON payloads with compact projection default.

Initial flags:

- `--mode <keyword|semantic|hybrid>` (all modes implemented baseline; advanced semantic/hybrid tuning planned)
- `--include-linked` (keyword mode and hybrid lexical component: include readable linked docs/files/tests content in corpus scoring)
- `--limit <n>`
- projection controls: `--compact` (default), `--full`, `--fields <csv>` (mutually exclusive)
- `--limit 0` is valid and returns a deterministic empty result set (after mode/config validation) without executing embedding/vector query requests
- shared list-like filters where applicable (`--type`, `--tag`, `--priority`, `--deadline-before`, `--deadline-after`)
- shared `--type` and `--priority` filters follow canonical validation (`--type` resolved by runtime item-type registry aliases, `--priority` integer `0..4`)

### 13.1 Modes

- `keyword` (always available)
- `semantic` (when embedding provider + vector store configured)
- `hybrid` (default if semantic capability is available through explicit settings or local Ollama auto-default resolution)
- for implicit default mode, if auto-defaulted semantic execution fails at runtime, search degrades to keyword mode for compatibility

### 13.2 Keyword corpus fields

- `title`
- `description`
- `tags`
- `status`
- `body`
- `comments[].text`
- `notes[].text`
- `learnings[].text`
- dependency IDs/kinds

Keyword/hybrid lexical scoring baseline also applies a deterministic exact-title token boost:

- each query token found as a full token in `title` contributes an additional lexical bonus
- bonus is additive with existing weighted occurrence scoring and keeps deterministic tie-break ordering unchanged

`--include-linked` lexical baseline (keyword + hybrid lexical component):

- linked docs/files/tests content (project/global scope resolution, best-effort reads)
- linked-content reads are root-bounded by scope:
  - `scope=project`: resolved path and symlink-resolved realpath must remain within project root
  - `scope=global`: resolved path and symlink-resolved realpath must remain within global root
  - out-of-scope paths or realpath escapes are ignored deterministically

### 13.3 Reindex baseline + semantic execution baseline

- `pm reindex` baseline behavior rebuilds deterministic keyword cache artifacts:
  - `index/manifest.json` (indexed item metadata summary)
  - `search/embeddings.jsonl` (line-delimited keyword corpus records)
- `pm reindex --mode semantic|hybrid` baseline generates deterministic provider embeddings for canonical item corpus records and upserts vector records to the active vector store.
- `pm reindex --mode semantic|hybrid` also rewrites `search/vectorization-status.json` with deterministic `id -> updated_at` records for the indexed corpus so health-time vector freshness checks stay in sync.
- Semantic embedding generation in `pm reindex --mode semantic|hybrid` and mutation-triggered refresh paths executes in deterministic batches sized by `search.embedding_batch_size`, and each batch retries failed embedding requests up to `search.scanner_max_batch_retries` before surfacing deterministic warnings/errors.
- Successful item-mutation command paths invalidate stale keyword cache artifacts (`index/manifest.json` and `search/embeddings.jsonl`) as best-effort non-fatal cleanup before the next explicit `reindex`.
- Successful item-mutation command paths also perform best-effort semantic embedding refresh for affected item IDs when embedding-provider and vector-store configuration are available; when an affected ID no longer exists (for example after delete), refresh attempts prune the stale vector entry from the active store. Refresh failures degrade to deterministic warnings.
- Settings support:
  - `score_threshold`
  - `hybrid_semantic_weight`
  - `max_results`
  - `embedding_model`
  - `embedding_batch_size`
  - `scanner_max_batch_retries`
  - `tuning` (optional object: `title_exact_bonus`, `title_weight`, `description_weight`, `tags_weight`, `status_weight`, `body_weight`, `comments_weight`, `notes_weight`, `learnings_weight`, `dependencies_weight`, `linked_content_weight`)
- `search.score_threshold` runtime semantics:
  - keyword mode compares against raw lexical score
  - semantic mode compares against vector similarity score
  - hybrid mode compares against normalized blended score (`0..1`) after lexical+semantic combination
  - default `0` preserves all positive-score hits
- `search.hybrid_semantic_weight` runtime semantics:
  - numeric range `0..1` (out-of-range or non-numeric values fall back to default)
  - hybrid combined score uses: `(semantic_normalized * hybrid_semantic_weight) + (keyword_normalized * (1 - hybrid_semantic_weight))`
  - default `0.7` keeps semantic ranking primary while preserving deterministic lexical influence
- `search.tuning` runtime semantics:
  - optional object controlling deterministic multi-factor lexical weighting in keyword mode and the hybrid lexical component
  - non-numeric/negative tuning values fall back to deterministic defaults per field
  - default weights when unset: `title_exact_bonus=10`, `title_weight=8`, `description_weight=5`, `tags_weight=6`, `status_weight=2`, `body_weight=1`, `comments_weight=1`, `notes_weight=1`, `learnings_weight=1`, `dependencies_weight=3`, `linked_content_weight=1`

### 13.4 Providers and vector stores (semantic/hybrid execution baseline)

Embedding providers:

- OpenAI-compatible (`base_url`, `api_key`, `model`)
- Ollama (`base_url`, `model`)

Implemented baseline:

- Deterministic provider-configuration resolution exists in core search runtime plumbing.
- OpenAI/Ollama provider blocks are normalized from settings and surfaced through a provider abstraction layer for command-time validation, request-target resolution (including OpenAI-compatible `base_url` normalization for root, `/v1`, and explicit `/embeddings` forms), request payload/response normalization (including deterministic OpenAI data-entry index ordering), deterministic request-execution helper behavior, deterministic per-request normalized-input deduplication with output fan-out back to original input cardinality/order, and deterministic embedding cardinality validation (normalized input count must match returned vector count after dedupe expansion).
- When semantic settings are otherwise unset and local Ollama is installed, runtime auto-resolves built-in semantic defaults (`providers.ollama`, local `vector_store.lancedb.path`, and `search.embedding_model`) for `search`/`reindex`; auto model selection prefers `PM_OLLAMA_MODEL`, then `ollama list` embedding-like model names, then deterministic fallback `qwen3-embedding:0.6b`.
- Auto-default behavior is compatibility-guarded: explicit semantic settings always take precedence, and auto-defaults can be disabled via `PM_DISABLE_OLLAMA_AUTO_DEFAULTS=1`.
- `pm search --mode semantic|hybrid` and `pm reindex --mode semantic|hybrid` use this abstraction for deterministic semantic/hybrid execution (embedding generation/request handling) after configuration validation.

Vector stores:

- Qdrant (`url`, `api_key?`)
- LanceDB (`path`)

Implemented baseline:

- Deterministic vector-store configuration resolution for Qdrant and LanceDB is available in core search runtime plumbing.
- Qdrant/LanceDB settings blocks are normalized from `settings.json` and surfaced through a vector-store abstraction layer for command-time validation.
- Request-target planning, request payload/response normalization, deterministic Qdrant request-execution helper behavior, deterministic LanceDB local query/upsert execution helper behavior, and deterministic query-hit ordering normalization (score desc, id asc tie-break) are available through this abstraction layer.
- `pm search --mode semantic|hybrid` and `pm reindex --mode semantic|hybrid` use this abstraction for deterministic vector query/upsert execution after configuration validation.

### 13.5 Health integrity, drift, and vectorization diagnostics

- `pm health` includes deterministic `directories` diagnostics:
  - separates core required directories from optional built-in type directories (`events`, `reminders`, `milestones`, `meetings`)
  - reports `missing_required` and `missing_optional` details independently
  - `--strict-directories` treats missing optional directories as warning/failure contributors
  - `--strict-exit` (alias `--fail-on-warn`) returns non-zero exit (`1`) when health warnings are present (`ok=false`)
- `pm health` includes deterministic `integrity` diagnostics:
  - scans item/history files for merge-conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
  - emits deterministic warning codes for conflict markers, invalid item parses, and invalid JSONL history lines
- `pm health` includes deterministic `history_drift` diagnostics:
  - checks current item corpus against history stream availability/parsability
  - compares current canonical item hash to latest history `after_hash`
  - emits deterministic warning codes for missing streams, unreadable streams, and hash mismatches
- `pm health` includes deterministic `vectorization` diagnostics:
  - compares current item `updated_at` values to `search/vectorization-status.json`
  - computes stale/missing vectorization entries deterministically (sorted by item ID)
  - triggers targeted semantic refresh for stale IDs when semantic runtime is available (no forced full reindex)
  - preserves compatibility under auto-resolved Ollama defaults by keeping auto-default refresh failures non-fatal in health status while still exposing refresh details in check output

## 14) Extension Architecture

### 14.1 Locations

- Global: `~/.pm-cli/extensions` (or `PM_GLOBAL_PATH/extensions`)
- Project: `.agents/pm/extensions` (or `PM_PATH/extensions`)

Lifecycle manager command:

- `pm extension` is the canonical extension lifecycle command surface for install/uninstall/explore/manage/doctor/adopt/adopt-all/activate/deactivate.
- Scope selection: `--project` (default), `--local` (alias of project), `--global`.
- Install sources: local directory, GitHub HTTPS URL, `github.com/<owner>/<repo>[/path]`, or `--gh/--github <owner>/<repo>[/path]` with optional `--ref`.
- GitHub subpath resolution probes deterministic default extension roots (`.agents/pm/extensions`, `.custom/pm-extensions`, `.custom/pm-extension`) when shorthand inputs do not include full paths.
- Scope-local managed state is persisted in `<extension-root>/.managed-extensions.json` and includes source metadata plus update-check status.
- `pm extension --manage` performs GitHub remote update checks for managed GitHub entries, persists latest check metadata, and returns deterministic per-extension `update_check_status`/`update_check_reason` fields plus `details.triage` status totals/remediation hints.
- `pm extension --manage --runtime-probe` is opt-in and adds doctor-like runtime activation probing (`runtime_active`/`activation_status`) while preserving default manage behavior when omitted.
- `pm extension --manage --fix-managed-state` can adopt unmanaged extensions before update checks to reduce managed-state remediation friction.
- `pm extension --adopt <name>` records existing unmanaged installs into managed state metadata (local or GitHub provenance via `--gh/--github` and optional `--ref`) without reinstalling files.
- `pm extension --adopt-all` bulk-records all unmanaged installs in selected scope into managed state metadata without reinstalling files.
- `pm extension --doctor` (or `pm extension doctor`) returns consolidated diagnostics with summary/deep modes (`--detail summary|deep`), normalized warning codes, canonical load roots, active-vs-loaded project consistency diagnostics, explicit state fields (`active` compatibility alias plus `enabled`/`runtime_active`/`activation_status`), strict warning exits (`--strict-exit`, alias `--fail-on-warn`), update-health coverage signals (`update_health_coverage`, `update_health_partial`), blocking-failure indicators (`blocking_failure_count`, `has_blocking_failures`), capability guidance/contract metadata, and remediation hints.
- `pm extension --doctor --detail deep --trace` adds actionable registration traces (method, command, registration index, expected schema, sanitized received payload, hint) for activation failures.
- `pm extension --doctor --fix-managed-state` can adopt unmanaged extensions before diagnostics are evaluated.
- `pm health` extension diagnostics include managed-state summaries/warnings for both project and global scope plus condensed `details.triage` counts/remediation for load, activation, and migration issues, including parity warning code `extension_update_health_partial_coverage` when action-required unmanaged extensions reduce update-check coverage and capability guidance/contract metadata for unknown manifest capabilities.

### 14.2 Load order and precedence

1. Core built-ins
2. Global extensions
3. Project extensions

Precedence:

- Later load can override earlier by explicit command/renderer/hook keys.
- Project overrides global by default.
- Priority field in manifest may alter local ordering within same layer.

### 14.3 Extension manifest (minimum)

```json
{
  "name": "pm-ext-example",
  "version": "0.1.0",
  "entry": "./dist/index.js",
  "priority": 100,
  "capabilities": [
    "commands",
    "parser",
    "preflight",
    "services",
    "schema",
    "renderers",
    "importers",
    "search",
    "hooks"
  ]
}
```

Capability declarations are enforced during extension activation. API registrations and
hook registrations must match declared capabilities (`commands`, `renderers`, `hooks`,
`schema`, `importers`, `search`, `parser`, `preflight`, `services`) or activation fails with deterministic
`extension_activate_failed:<layer>:<name>` diagnostics.
Unknown capability names are ignored for registration gating and produce deterministic
discovery diagnostics `extension_capability_unknown:<layer>:<name>:<capability>:allowed=<csv>:suggested=<capability|none>` with legacy alias suggestions when applicable (for example `migration`/`validation` -> `schema`).
Health/doctor payloads additionally publish machine-readable contract metadata (`capability_contract.version`, `capability_contract.capabilities`, `capability_contract.legacy_aliases`) for automation parity.

### 14.4 Extension API contracts (v1 draft)

Current implementation (single-wave override model):

- `activate(api)` hook registration surface is available.
- `api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex` dispatch is deterministic with failure containment and per-hook context snapshot isolation.
- Hook registration APIs (`api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex`) require function handlers; invalid payloads throw during extension activation and surface deterministic `extension_activate_failed:<layer>:<name>` warnings.
- `api.registerCommand(...)` validation failures now carry actionable trace metadata that doctor deep trace mode can expose (method, registration index, command, expected schema, received payload, hint) to speed activation triage.
- `api.registerCommand(name, override)` supports deterministic synchronous overrides for existing command results before output rendering; override execution receives cloned command `args`/`options`/`global` snapshots, `pm_root`, and a cloned prior result payload so extensions can apply contextual overrides without mutating caller fallback state.
- `api.registerCommand({ name, run })` supports deterministic extension command handlers for declared command paths, including dynamically surfaced non-core extension command paths (for example `beads import` and `acme sync`) and extension-first replacement of core command handlers at dispatch time.
- `api.registerParser(command, override)` supports command-scoped parser override contracts (sync/async) that can rewrite `args`, `options`, and `global` context before handler dispatch.
- `api.registerPreflight(override)` supports command preflight interception (sync/async) to control item-format gate enforcement, preflight migration sync, extension migration execution, and mandatory-migration gate enforcement.
- `api.registerService(service, override)` supports deterministic service-level override hooks (`output_format`, `error_format`, `help_format`, `lock_acquire`, `lock_release`, `history_append`, `item_store_write`, `item_store_delete`) with last-wins precedence per service key.
- Extension command-handler execution receives cloned `args`/`options`/`global` snapshots so handler-side mutation cannot leak into caller runtime command state.
- Registered extension command names are canonicalized with trim + lowercase + internal-whitespace collapse before storage and dispatch matching, ensuring equivalent command paths resolve deterministically.
- Required extension-command dispatch semantics are deterministic: no matched handler returns command-not-found for extension-only paths, while a matched handler throw returns generic failure with warning code `extension_command_handler_failed:<layer>:<name>:<command>`.
- `api.registerRenderer(format, renderer)` supports deterministic `toon`/`json` output overrides; renderer execution receives isolated command context snapshots (`command`, `args`, `options`, `global`, `pm_root`) plus an isolated result snapshot so failed renderer-side mutation cannot alter core fallback output.
- Extension API registration baseline now includes deterministic registration-time validation and metadata capture for `api.registerFlags`, `api.registerItemFields`, `api.registerItemTypes`, `api.registerMigration`, `api.registerImporter`, `api.registerExporter`, `api.registerSearchProvider`, and `api.registerVectorStoreAdapter`.
- `api.registerImporter(name, importer)` and `api.registerExporter(name, exporter)` now provide runtime command wiring in addition to metadata capture: each registration deterministically exposes extension command-handler paths `<name> import` and `<name> export` (canonicalized with trim + lowercase + internal-whitespace collapse) and executes through the same isolated command-handler context snapshots used by `api.registerCommand({ name, run })`.
- Dynamically surfaced extension command paths now render deterministic help metadata derived from registered `api.registerFlags(...)` definitions while preserving loose option parsing behavior for runtime command dispatch.
- Extension API and hook registration calls enforce manifest capability declarations (`commands`, `renderers`, `hooks`, `schema`, `importers`, `search`, `parser`, `preflight`, `services`) and fail activation deterministically when an extension registers outside its declared capabilities.
- Extension activation diagnostics include deterministic registration counts and metadata summaries for the above registries (flags, item fields, item types, migrations, importers, exporters, search providers, and vector store adapters), `pm health` exposes deterministic migration status summaries from registered migration definitions (`status="failed"` -> failed, `status="applied"` -> applied, any other/missing status -> pending), and core write command paths enforce deterministic mandatory-migration gating (`mandatory=true` + status not `"applied"` -> unresolved blocker, with `--force` bypass on force-capable write commands). Mandatory extension migrations are executed in pre-action lifecycle before write-gate enforcement.
- Registration runtime wiring is live for:
  - item-field defaults + validation on create/update (`registerItemFields`)
  - search provider selection via `settings.search.provider` (`registerSearchProvider`)
  - vector adapter query/upsert selection via `settings.vector_store.adapter` (`registerVectorStoreAdapter`)
  - migration runtime execution and mandatory gate evaluation (`registerMigration`)

Full v1 draft surface:

```ts
export interface PmExtension {
  manifest: ExtensionManifest;
  activate(api: ExtensionApi): Promise<void> | void;
}

export interface ExtensionApi {
  registerCommand(def: CommandDefinition): void;
  registerParser(command: string, override: ParserOverride): void;
  registerPreflight(override: PreflightOverride): void;
  registerService(service: ExtensionServiceName, override: ServiceOverride): void;
  registerFlags(targetCommand: string, flags: FlagDefinition[]): void;
  registerItemFields(fields: SchemaFieldDefinition[]): void;
  registerItemTypes(types: ItemTypeDefinition[]): void;
  registerMigration(def: SchemaMigrationDefinition): void;
  registerRenderer(format: "toon" | "json", renderer: Renderer): void;
  registerImporter(name: string, importer: Importer): void;
  registerExporter(name: string, exporter: Exporter): void;
  registerSearchProvider(provider: SearchProvider): void;
  registerVectorStoreAdapter(adapter: VectorStoreAdapter): void;
  hooks: {
    beforeCommand(hook: BeforeCommandHook): void;
    afterCommand(hook: AfterCommandHook): void;
    onWrite(hook: OnWriteHook): void;
    onRead(hook: OnReadHook): void;
    onIndex(hook: OnIndexHook): void;
  };
}
```

### 14.5 Failure isolation and safety

- Extension load failure must not corrupt core data.
- Failed extension is marked unhealthy and reported via `pm health`.
- `pm health` extension checks must run safe runtime load and activation probes (including installed managed extensions) and emit deterministic warning codes for import/activation failures (for example `extension_load_failed:<layer>:<name>` and `extension_activate_failed:<layer>:<name>`).
- Extension manifest `entry` paths must resolve within the extension directory after canonical path resolution (including symlink targets); traversal/escape paths are rejected with deterministic diagnostics (for example `extension_entry_outside_extension:<layer>:<name>`).
- Core commands remain functional unless extension is explicitly required by invoked command.

### 14.6 Schema extension migrations

- Extensions adding front-matter fields must provide forward migrations.
- Migration definitions are versioned and idempotent.
- `pm health` reports deterministic migration status summaries:
  - `applied`: registered migrations whose definition status is `"applied"` (case-insensitive).
  - `pending`: registered migrations whose definition status is neither `"failed"` nor `"applied"` (or is missing).
  - `failed`: registered migrations whose definition status is `"failed"` (case-insensitive), with optional reason from `reason`, `error`, or `message` metadata.
- Core write command paths are blocked when unresolved mandatory migrations are present from active extension registrations.
- Mandatory migrations are definitions with `mandatory: true`.
- Mandatory migration resolution is deterministic: `status` equal to `"applied"` (case-insensitive) is treated as resolved; any other/missing status is unresolved.
- Force-capable write commands may bypass the guard with explicit `--force`; write commands without `--force` remain blocked until blockers resolve.

## 15) Bundled Managed Extensions Required in v1

### A) Beads import

Command:

- `pm beads import [--file <path>|-] [--preserve-source-ids]`

Current baseline status (release-hardening):

- Command is packaged in bundled managed extension source (`.agents/pm/extensions/beads`) using `activate(api)` and `api.registerCommand({ name, run })` for `beads import`.
- Command path is available only after extension install/activation in selected scope (`pm extension --install beads` or explicit path install).

Behavior:

- Parse Beads JSONL records.
- Map Beads fields to PM schema.
- Preserve IDs and timestamps where possible, including Beads-only compatibility metadata such as `source_type`, `source_owner`, `source_kind`, `design`, `external_ref`, and `closed_at`.
- Append history with `op: "import"`.
- When `--file` is not provided, auto-discover `.beads/issues.jsonl` first and then `issues.jsonl`; implicit fallback to `sync_base.jsonl` is refused because it may be partial.
- `--preserve-source-ids` preserves explicit Beads item IDs verbatim instead of rewriting them to the tracker prefix.
- Invalid JSONL lines or duplicate IDs are skipped with deterministic warnings.

### B) todos.ts import/export

Commands:

- `pm todos import [--folder <path>]`
- `pm todos export [--folder <path>]`

Current baseline status (release-hardening):

- Commands are packaged in bundled managed extension source (`.agents/pm/extensions/todos`) using `activate(api)` and `api.registerCommand({ name, run })` for `todos import` and `todos export`.
- Command paths are available only after extension install/activation in selected scope (`pm extension --install todos` or explicit path install).

Behavior:

- Read/write todos markdown format (JSON front-matter + body).
- Field mapping:
  - `title -> title`
  - `body -> body`
  - imported IDs, including hierarchical suffixes such as `pm-legacy.1.2`, are preserved verbatim when provided in todos front matter
  - canonical PM metadata fields round-trip when present, including planning/workflow metadata (`definition_of_ready`, `order`, `goal`, `objective`, `value`, `impact`, `outcome`, `why_now`, `reviewer`, `risk`, `confidence`, `sprint`, `release`, `blocked_by`, `blocked_reason`, `unblock_note`) and issue metadata (`reporter`, `severity`, `environment`, `repro_steps`, `resolution`, `expected_result`, `actual_result`, `affected_version`, `fixed_version`, `component`, `regression`, `customer_impact`)
  - `confidence`, `risk`, and `severity` text aliases normalize deterministically (`med -> medium`)
- Missing PM fields get deterministic defaults:
  - `description = ""`
  - `priority = 2`
  - `type = "Task"`
  - `updated_at = created_at (or now if missing)`

### C) Pi tool wrapper

Current baseline status (release-hardening):

- Implemented as a Pi agent extension source module at `.pi/extensions/pm-cli/index.ts` (outside the `pm` CLI command surface).
- Registers one Pi tool named `pm` via Pi's extension API (`registerTool`) and maps `action` + command-shaped fields to `pm` CLI invocations.
- Tool action enums and parameter JSON Schema are sourced from the shared command contract registry (`src/sdk/cli-contracts.ts`) to avoid drift with core CLI/completion surfaces.
- Action dispatch currently covers the full v0.1 command-aligned set (`init`, `config`, `create`, `list`, `list-all`, `list-draft`, `list-open`, `list-in-progress`, `list-blocked`, `list-closed`, `list-canceled`, `calendar`, `context`, `get`, `search`, `reindex`, `history`, `activity`, `restore`, `update`, `close`, `delete`, `append`, `comments`, `notes`, `learnings`, `files`, `docs`, `deps`, `test`, `test-all`, `stats`, `health`, `validate`, `gc`, `completion`, `templates-save`, `templates-list`, `templates-show`, `claim`, `release`) plus extension lifecycle actions (`extension-install`, `extension-uninstall`, `extension-explore`, `extension-manage`, `extension-doctor`, `extension-adopt`, `extension-adopt-all`, `extension-activate`, `extension-deactivate`), extension action aliases (`beads-import`, `todos-import`, `todos-export`), and workflow presets (`start-task`, `pause-task`, `close-task`).
- Invocation fallback order is deterministic for distribution resilience: attempt `pm` first, then fallback to packaged `node <package-root>/dist/cli.js` when `pm` is unavailable.

- Expose one tool `pm`.
- Parameters include:
  - `action` enum mapped to CLI commands and workflow presets
  - common fields (`id`, `title`, `status`, `tags`, `body`, etc.)
  - completion parity field `shell` (`action=completion` -> `pm completion <shell>`)
  - search-specific parity fields including `mode` and `includeLinked` (`--include-linked`)
  - list/runtime parity fields including `offset` and `progress` where command surfaces support those flags
  - close/validate parity fields including `validateClose`, `checkMetadata`, `checkResolution`, `checkLifecycle`, `checkStaleBlockers`, `checkFiles`, `scanMode`, `includePmInternals`, `strictExit`, `failOnWarn`, `checkHistoryDrift`, and `checkCommandReferences`
  - contracts parity fields including `schemaOnly`, `runtimeOnly`, and `activeOnly`
  - claim/release metadata parity fields including `author`, `message`, and `force` (`--author`, `--message`, `--force`)
  - create/update scalar parity fields using camelCase wrapper parameters that forward to the canonical CLI flags for planning/workflow metadata (`parent`, `reviewer`, `risk`, `confidence`, `sprint`, `release`, `blockedBy`, `blockedReason`, `unblockNote`, `definitionOfReady`, `order`, `goal`, `objective`, `value`, `impact`, `outcome`, `whyNow`, `closeReason`) and issue metadata (`reporter`, `severity`, `environment`, `reproSteps`, `resolution`, `expectedResult`, `actualResult`, `affectedVersion`, `fixedVersion`, `component`, `regression`, `customerImpact`)
  - explicit empty-string passthrough for empty-allowed CLI flags (for example `--description ""` and `--body ""`)
  - numeric scalar parity for numeric CLI flags: wrapper accepts either JSON numbers or strings for `priority`, `estimate`, `limit`, and `timeout`, then stringifies values for deterministic CLI argument emission
- Return object:
  - `content: [{ type: "text", text: <TOON or JSON string> }]`
  - `details: <structured object>`

Wrapper behavior must remain aligned with CLI semantics and exit conditions.

Schema-capability registrations are also validated deterministically at activation-time:

- `registerFlags`: each entry must provide at least one of `long`/`short`; optional metadata fields must match expected scalar types.
- `registerItemFields`: each entry requires non-empty `name` and `type`.
- `registerItemTypes`: each type requires non-empty `name`; nested `options[]` and `command_option_policies[]` entries enforce required key fields and boolean toggles.
- `registerMigration`: typed migration metadata (`id`, `description`, `status`, `mandatory`, `run`) is validated when provided.

## 16) Security and Data Integrity

- All writes are lock-protected + atomic.
- Never partially write item or history line.
- Validate and normalize path inputs to prevent traversal.
- `pm search --include-linked` must enforce scope-root containment on linked content reads using both resolved-path and symlink-resolved-realpath checks, and ignore linked paths that escape allowed roots.
- Extension manifest `entry` paths must not escape their owning extension directory.
- Dynamic extension command loose-option parsing must ignore unsafe prototype keys (`__proto__`, `constructor`, `prototype`) and use null-prototype option maps before passing option snapshots to extension command handlers.
- Never execute linked test commands without explicit `--run`.
- Reject new linked test entries that omit `command` metadata (`pm test --add` and `pm create --test`); `path` is optional metadata and cannot be the only runnable signal.
- Reject linked test command entries that invoke `pm test-all` (including global-flag and package-spec launcher variants such as `pm --json test-all`, `npx @unbrained/pm-cli@latest --json test-all`, `pnpm dlx @unbrained/pm-cli@latest --json test-all`, and `npm exec -- @unbrained/pm-cli@latest --json test-all`) to prevent recursive orchestration loops.
- `pm test <ID> --run` defensively skips legacy linked command entries that invoke `pm test-all` (including global-flag and package-spec launcher variants such as `npx`, `pnpm dlx`, and `npm exec` launcher forms) and records deterministic skipped results.
- Reject linked test-runner command entries (for example `pnpm test`, `pnpm test:coverage`, `npm test`, `npm run test`, `pnpm run test`, `yarn run test`, `bun run test`, `vitest`) unless they use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; chained direct test-runner segments are validated independently and rejected when not explicitly sandboxed.
- Linked command execution in `pm test --run` and `pm test-all` must keep temporary sandbox isolation while seeding both project/global `settings.json` and `extensions/` directories from source roots so extension-defined type behavior matches direct workspace commands.
- Linked PM-command test runs support additive context mode `--pm-context schema|tracker|auto` plus per-test metadata override `pm_context_mode=schema|tracker|auto`; tracker mode seeds tracker corpus into sandbox, auto mode routes PM tracker-read commands to tracker context, per-test overrides take precedence over run-level mode, and every run result emits deterministic `execution_context` metadata (resolved roots, item counts, mismatch signal, PM tracker-read classification).
- In default `--pm-context schema` mode, PM tracker-read linked commands fail on context mismatch by default; `--fail-on-context-mismatch` remains available to enforce mismatch failures for non-tracker-read PM command shapes.
- `pm test --run` and `pm test-all` support additive strict governance guards: `--fail-on-context-mismatch`, `--fail-on-skipped`, `--fail-on-empty-test-run`, and `--require-assertions-for-pm`.
- Linked test assertion metadata (`assert_stdout_contains`, `assert_stdout_regex`, `assert_stderr_contains`, `assert_stderr_regex`, `assert_stdout_min_lines`, `assert_json_field_equals`, `assert_json_field_gte`) is optional and must be evaluated as deterministic assertion failures even when process exit code is `0`.
- `pm test-all` executes each unique linked command/path key at most once per run; duplicate entries are reported as skipped to keep totals deterministic while avoiding redundant execution. Duplicate-key timeout conflicts resolve deterministically to the maximum `timeout_seconds` value for that key.
- Linked test execution should emit stderr heartbeat lines in interactive terminals so long-running commands remain observable instead of appearing hung.
- Linked test timeout handling should attempt graceful termination first and then apply deterministic force-kill fallback for stubborn child process trees.
- Optional providers use explicit settings; secrets come from env or settings with documented precedence.
- Restore must verify replay hashes and fail loudly on mismatch.

## 17) Configuration

`settings.json` baseline keys:

- `version`
- `id_prefix`
- `author_default`
- `locks.ttl_seconds`
- `output.default_format`
- `history.missing_stream`
- `validation.sprint_release_format`
- `workflow.definition_of_done[]`
- `item_types.definitions[]` (custom type aliases/folders, required create fields/repeatables, `options[]`, and optional `command_option_policies[]`)
- `extensions.enabled[]`
- `extensions.disabled[]`
- `search.score_threshold`
- `search.hybrid_semantic_weight`
- `search.max_results`
- `search.embedding_model`
- `search.embedding_batch_size`
- `search.scanner_max_batch_retries`
- `search.tuning` (optional object)
- `providers.openai`
- `providers.ollama`
- `vector_store.qdrant`
- `vector_store.lancedb`

`search.score_threshold` defaults to `0` and applies mode-specific minimum-score filtering as defined in section `13.3`.
`search.hybrid_semantic_weight` defaults to `0.7` and controls semantic-vs-lexical blend weight in hybrid mode as defined in section `13.3`.
`search.tuning` is optional; when unset or partially invalid, lexical scoring defaults remain deterministic (`title_exact_bonus=10`, `title_weight=8`, `description_weight=5`, `tags_weight=6`, `status_weight=2`, `body_weight=1`, `comments_weight=1`, `notes_weight=1`, `learnings_weight=1`, `dependencies_weight=3`, `linked_content_weight=1`).

Default `settings.json` object written by `pm init`:

```json
{
  "version": 1,
  "id_prefix": "pm-",
  "author_default": "",
  "locks": {
    "ttl_seconds": 1800
  },
  "output": {
    "default_format": "toon"
  },
  "history": {
    "missing_stream": "auto_create"
  },
  "validation": {
    "sprint_release_format": "warn"
  },
  "workflow": {
    "definition_of_done": []
  },
  "item_types": {
    "definitions": []
  },
  "extensions": {
    "enabled": [],
    "disabled": []
  },
  "search": {
    "score_threshold": 0,
    "hybrid_semantic_weight": 0.7,
    "max_results": 50,
    "embedding_model": "",
    "embedding_batch_size": 32,
    "scanner_max_batch_retries": 3
  },
  "providers": {
    "openai": {
      "base_url": "",
      "api_key": "",
      "model": ""
    },
    "ollama": {
      "base_url": "",
      "model": ""
    }
  },
  "vector_store": {
    "qdrant": {
      "url": "",
      "api_key": ""
    },
    "lancedb": {
      "path": ""
    }
  }
}
```

Definition-of-Done config baseline:

- `pm config project set definition-of-done --criterion <text>` replaces the project-level criteria list in `.agents/pm/settings.json`.
- `pm config global set definition-of-done --criterion <text>` replaces the global criteria list in `~/.pm-cli/settings.json` (or `PM_GLOBAL_PATH/settings.json`).
- `pm config <project|global> get definition-of-done` returns the currently effective list for the selected scope with deterministic TOON/JSON output.
- Empty criteria are rejected; duplicate criteria are deduplicated with lexicographic ordering.

History missing-stream policy config baseline:

- `pm config <project|global> set history-missing-stream-policy --policy auto_create|strict_error` updates `settings.history.missing_stream`.
- `pm config <project|global> get history-missing-stream-policy` returns the active policy.

Sprint/release format policy config baseline:

- `pm config <project|global> set sprint-release-format-policy --policy warn|strict_error` updates `settings.validation.sprint_release_format`.
- `pm config <project|global> get sprint-release-format-policy` returns the active policy.

Notes:

- Key order in file output MUST remain exactly as shown above.

Env precedence:

1. CLI flags
2. Environment variables
3. `settings.json`
4. hard defaults

## 18) Testing Strategy and CI

Release-ready test policy:

- Test runner: Vitest for both unit and integration suites.
- Coverage gates: 100% for lines, branches, functions, and statements.
- CI guard: fail build when any coverage metric drops below 100%.

Sandbox safety requirements (hard):

- Tests MUST NOT read/write the repository's real `.agents/pm`.
- Every test suite uses temporary sandbox storage via `PM_PATH`.
- PM-driven test execution MUST use a sandbox wrapper command (`node scripts/run-tests.mjs test|coverage`) that creates a temporary directory, sets both `PM_PATH` and `PM_GLOBAL_PATH`, runs the requested test command, and cleans up the sandbox afterward.
- `pm test <ID> --add` MUST enforce this by requiring `command` metadata (with optional `path` metadata) and rejecting sandbox-unsafe test-runner command entries at add-time unless they use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; this includes unsandboxed direct package-manager run-script variants (for example `npm run test` and `pnpm run test`) and chained direct test-runner segments that are not explicitly sandboxed.
- `pm test <ID> --run` MUST defensively skip legacy linked command entries that invoke `pm test-all` (including global-flag and package-spec launcher variants such as `pm --json test-all`, `npx @unbrained/pm-cli@latest --json test-all`, `pnpm dlx @unbrained/pm-cli@latest --json test-all`, and `npm exec -- @unbrained/pm-cli@latest --json test-all`) and surface deterministic skipped diagnostics.
- `pm test <ID> --run` and `pm test-all` MUST preserve sandbox isolation while seeding project/global `settings.json` and `extensions/` into sandbox roots so extension-defined schemas and type filters remain parity-consistent with direct workspace runs.
- Integration tests spawn built CLI subprocesses (`node dist/cli.js ...`) with explicit
  `PM_PATH`, `PM_GLOBAL_PATH`, and `PM_AUTHOR`.
- Temporary sandbox directories must be cleaned up after each test/suite.

Required unit coverage areas:

- Parser/serializer round-trip and key ordering determinism.
- ID normalization/generation behavior.
- Deadline parsing and explicit clear/unset validation behavior.
- History patch + hash generation.
- Lock conflict/stale-lock behavior.

Required integration coverage areas:

- `init` idempotency.
- `create` full-flag.
- `list*` filtering contracts and deterministic ordering.
- `get`, `update`, `append`, `claim`, `release`, `delete`.
- `comments`, `files`, `docs`, `test`, and `test-all`.
- `history` and `activity` deterministic retrieval commands.

CI requirements:

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` (must satisfy 100% thresholds)
- `node scripts/run-tests.mjs coverage` for pm-linked regression execution in automation-safe mode
- Optional artifact upload for coverage reports

Community/release documentation requirements:

- `LICENSE` (MIT) at repository root.
- `CHANGELOG.md` at repository root using Keep a Changelog format with an `[Unreleased]` section and explicit SemVer note.
- `CONTRIBUTING.md` at repository root (or `.github/`) with setup, sandbox-safe testing, and contribution workflow.
- `SECURITY.md` policy with reporting expectations.
- `CODE_OF_CONDUCT.md` baseline contributor conduct policy.

## 19) Dependency Policy (Minimal, Justified)

Core should prefer Node standard library and a minimal set:

- `commander` (CLI arg parsing, help generation)
- `@toon-format/toon` (TOON encode/decode)
- `fast-json-patch` (RFC6902 diff/apply)
- `zod` (runtime schema validation for settings/extensions/import payloads)
- `undici` (HTTP for embedding providers, if needed by core)

Optional adapters can introduce optional peer dependencies (Qdrant/LanceDB clients) loaded lazily through extension boundaries.

## 20) Risks and Mitigations

Highest-risk areas:

1. History/restore correctness
   - Mitigation: hash verification + replay tests + golden fixtures.
2. Extension override complexity
   - Mitigation: explicit precedence rules + deterministic registration order + health checks.
3. Semantic indexing drift
   - Mitigation: mutation-triggered re-embed + periodic `reindex` + index manifest checksums.

## 21) Milestone Implementation Plan (Release Hardening)

### Milestone 0 - Foundations

Checklist:

- [x] Project scaffolding, CLI entrypoint, config loader
- [x] Deterministic serializer utilities
- [x] Error model + exit code mapping

Definition of Done:

- `pm --help` and `pm init --help` render
- config/env precedence tested

### Milestone 1 - Core Item CRUD + Locking

Checklist:

- [x] Item schema model + validation
- [x] Parser/serializer for TOON item files plus legacy markdown migration reader
- [x] ID generation + normalization
- [x] Lock acquire/release with TTL and conflict handling
- [x] Core commands: init/create/get/update/append/claim/release/close/delete complete

Definition of Done:

- Full CRUD lifecycle works with atomic writes and conflict exit codes
- deterministic output in TOON/JSON

### Milestone 2 - History + Restore

Checklist:

- [x] RFC6902 patch generation per mutation
- [x] Append-only history writer
- [x] `history` and `activity` commands
- [x] `restore` by timestamp/version with replay + hash validation

Definition of Done:

- Replay reproduces exact prior item state in tests
- restore appends `restore` history event

### Milestone 3 - Query + Operations

Checklist:

- [x] list/list-* filters and deterministic sort
- [x] comments/files/docs/test commands
- [x] test-all orchestration + dependency-failed exit handling
- [x] stats/health/gc command baseline

Definition of Done:

- Command matrix complete and deterministic
- docs-linked operations tested

### Milestone 4 - Search

Checklist:

- [x] keyword indexing + search command (keyword command surface + deterministic reindex artifact rebuild implemented; deterministic exact-title token boost and configurable multi-factor lexical tuning via `search.tuning` implemented; `--limit 0` short-circuit implemented; advanced relevance tuning is post-v0.1 roadmap)
- [x] embedding provider abstraction (deterministic provider configuration resolution, request-target planning including OpenAI-compatible `base_url` normalization for root/`/v1`/`/embeddings`, provider-specific request payload/response normalization with deterministic OpenAI data-entry index ordering, deterministic request-execution helper behavior, deterministic embedding cardinality validation, deterministic per-request normalized-input dedupe with output fan-out, configurable batch sizing and per-batch retry, command-path embedding execution, and mutation-triggered embedding refresh are implemented; additional advanced provider optimizations are post-v0.1 roadmap)
- [x] vector store adapters (Qdrant/LanceDB deterministic configuration resolution, request-target planning, request payload/response normalization, deterministic request-execution helpers, deterministic LanceDB local query/upsert/delete execution helper behavior, deterministic local snapshot persistence + reload across process boundaries, query-hit ordering normalization, and command-path vector query/upsert integration implemented; broader adapter optimization is post-v0.1 roadmap)
- [x] hybrid ranking + include-linked option (`--include-linked` lexical baseline implemented for keyword mode and hybrid lexical blending; deterministic hybrid lexical+semantic blend with configurable `search.hybrid_semantic_weight` implemented; deterministic exact-title token lexical boost implemented; configurable multi-factor lexical tuning via `search.tuning` implemented; broader advanced semantic/hybrid tuning is post-v0.1 roadmap)
- [x] reindex command (keyword baseline complete; semantic/hybrid embedding+vector upsert implemented; mutation command paths invalidate stale keyword artifacts, trigger best-effort semantic embedding refresh for affected item IDs, and prune vectors for missing/deleted IDs when semantic configuration is available)

Definition of Done:

- Search works in keyword-only and semantic/hybrid mode
- item mutations trigger search-index freshness via deterministic cache invalidation plus best-effort semantic embedding refresh for affected item IDs when semantic configuration is available, including pruning vectors for missing/deleted affected IDs, with explicit reindex workflows retained for full rebuilds

### Milestone 5 - Extension System + Built-ins

Checklist:

- [x] extension manifest loader + sandboxed execution boundary (deterministic manifest discovery, precedence, failure-isolated runtime loading, realpath/symlink-resolved entry containment enforcement, command-handler context snapshot isolation for `args`/`options`/`global`, per-hook context snapshot isolation, and dynamic extension command loose-option parsing hardening (null-prototype option maps + prototype-pollution key rejection) are implemented; broader command sandbox API surface is post-v0.1 roadmap)
- [x] hook lifecycle (extension `activate(api)` baseline with deterministic hook registration is implemented; registration now validates hook handlers as functions at activation time, per-hook context snapshot isolation prevents mutation leakage across hook callbacks and caller state, and `beforeCommand`/`afterCommand` command-lifecycle execution plus baseline read/write/index call-site wiring for core item-store reads/writes, create/restore item and history writes, settings read/write operations, history/activity history-directory scans and history-stream reads, health history-directory scans plus history-stream path dispatch, search item/linked reads, reindex flows, stats/health/gc command file-system paths (including `pm gc` onIndex dispatch with mode `gc` and deterministic cache-target totals), lock file read/write/unlink operations, init directory bootstrap ensure-write dispatch, and bundled managed beads/todos import-export source/item/history file operations are implemented)
- [x] renderer and command extension points (deterministic core-command override + renderer override registration/dispatch is implemented with failure containment, extension command handlers for declared command paths including dynamically surfaced non-core paths are implemented, dynamic command help now surfaces `registerFlags` metadata deterministically, deep snapshot isolation for override/renderer result contexts is implemented, and override/renderer execution now includes cloned command `args`/`options`/`global` snapshots plus `pm_root` metadata for contextual deterministic extension output behavior)
- [x] bundled managed beads import extension (bundled source packaging in `.agents/pm/extensions/beads`, install-only command surfacing through `pm extension`, Beads JSONL field mapping, deterministic defaults, `op: "import"` history entries, and parity polish implemented)
- [x] bundled managed todos import/export extension (bundled source packaging in `.agents/pm/extensions/todos`, install-only command surfacing through `pm extension`, todos markdown round-trip, canonical optional metadata preservation including planning/workflow and issue fields, hierarchical ID preservation, and `med` alias normalization implemented)
- [x] Pi tool wrapper extension source module (Pi agent extension module at `.pi/extensions/pm-cli/index.ts` with full v0.1 action dispatch parity, including `completion` + `shell` mapping, camelCase parameter surface for all canonical scalar metadata, explicit empty-string passthrough, numeric-flag stringification, claim/release parity, packaged CLI fallback, and distribution packaging polish implemented)

Definition of Done:

- Project/global precedence verified
- failing extension reported in `pm health` without core corruption

### Milestone 6 - Hardening + Release Readiness

Checklist:

- [x] CI matrix finalized (ubuntu/macos/windows Node 20, ubuntu Node 22, ubuntu Node 24)
- [x] fixture corpus for restore/import/search
- [x] command help and pm-data-driven runtime checks validated in tests
- [x] repository layout refactor (`src/cli`, `src/core`, `src/types`)
- [x] sandboxed integration harness (`withTempPmPath`)
- [x] sandboxed pm-runner (`scripts/run-tests.mjs`) for `pm test` and `pm test-all` safety
- [x] installer scripts (`scripts/install.sh`, `scripts/install.ps1`) with post-install `pm --version` availability verification
- [x] npm packaging allowlist + prepublish build guard
- [x] community docs baseline (`LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`)
- [x] shell completion command (`pm completion bash|zsh|fish`)
- [x] automated npm release workflow (`.github/workflows/release.yml`) triggered on `v*.*.*` tags

Definition of Done:

- All required commands and tests passing
- pm data, runtime behavior, and user-facing docs kept coherent

## 22) Open Assumptions and Clarifications Captured

- Imported Beads dependency types outside canonical set are mapped best-effort:
  - `parent-child` -> `parent`/`child` directional mapping based on source context
  - unknown values retained in import metadata notes if lossy mapping is required
- Hierarchical IDs from imports are preserved verbatim; new IDs generated by core default to flat `prefix-token`.
- TOON formatting follows deterministic encoding with stable object keys; internal serializer may use a thin compatibility layer to ensure strict consistency across Node versions.
- For `create`, `before_hash` is computed from the legacy-compatible canonical empty hash document: `{ "front_matter": {}, "body": "" }` (history patch payloads use `metadata` paths).
- If create item write succeeds but history append fails, implementation MUST rollback the new item file before returning failure.
- ID normalization helper behavior (`#` prefix, missing configured prefix, case-insensitive input) is required in core utilities even before all commands expose it.
