# pm-cli Product Requirements Document (PRD)

Status: Draft v1 (authoritative for implementation)  
Project: `pm` / `pm-cli`  
Last Updated: 2026-02-19

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
- Model work as first-class items: `Epic`, `Feature`, `Task`, `Chore`, `Issue`.
- Support full item lifecycle operations, deterministic listing/filtering, and rich metadata.
- Provide append-only item history with patch-level restore.
- Provide safe mutation under concurrent access (claim/release + lock + atomic writes).
- Default stdout to TOON; support `--json` parity for every command.
- Provide extension architecture for commands, schema, rendering, import/export, search adapters, and hooks.
- Ship built-in extensions:
  - Beads import
  - todos.ts import/export
  - Pi agent extension wrapper module
- Provide optional semantic search with provider + vector-store adapters.

## 3) Explicit Non-Goals

- No required UI/TUI (CLI-first only).
- No required remote control plane for core tracker.
- No required database for core tracker (file-backed core is mandatory).
- Export to Beads is not required in v1 (import only).

## 4) Authoritative Inputs and Design Findings

### 4.1 Local authoritative references analyzed

1. `todos.ts` (local Pi extension implementation)
2. `.beads/issues.jsonl` (local Beads-style JSONL data)

### 4.2 Upstream inspirations analyzed (conceptual only)

- mitsuhiko todos extension
- beads repository/docs
- TOON docs/spec guidance for LLM output conventions

### 4.3 Key findings adopted

From `todos.ts`:

- Item file format = JSON front-matter at file start, blank line, then markdown body.
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
- JSON fallback should be exact semantic equivalent of TOON output object.

## 5) Core Concepts

### 5.1 Item Types (canonical)

- `Epic`
- `Feature`
- `Task`
- `Chore`
- `Issue`

### 5.2 Status lifecycle

Allowed values:

- `draft`
- `open`
- `in_progress`
- `blocked`
- `closed`
- `canceled`

Lifecycle rules:

- Any non-terminal status may transition to `canceled` via `pm update <ID> --status canceled`.
- Any non-terminal status may transition to `closed` only via `pm close <ID> <TEXT>`.
- `pm update <ID> --status closed` is invalid usage and returns exit code `2`.
- `closed` and `canceled` are terminal unless explicitly restored or reopened.
- `close` command must write `close_reason`.
- `claim` on terminal status fails unless explicitly overridden by `--force`.

### 5.3 Ownership model

- Ownership marker is `assignee`.
- `pm claim <id>` sets ownership to current mutation author identity.
- `pm release <id>` clears ownership.
- Mutations against items assigned to another assignee return conflict unless `--force`.

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

Each item is one markdown file at `<type-folder>/<id>.md`.

Format:

1. JSON object front-matter (pretty-printed, 2-space indent, stable key order).
2. One blank line.
3. Optional markdown body.

### 7.1 Canonical front-matter schema

Required fields:

- `id: string`
- `title: string`
- `description: string`
- `tags: string[]`
- `status: "draft" | "open" | "in_progress" | "blocked" | "closed" | "canceled"`
- `priority: 0 | 1 | 2 | 3 | 4`
- `type: "Epic" | "Feature" | "Task" | "Chore" | "Issue"`
- `created_at: ISO string`
- `updated_at: ISO string`

Optional fields:

- `assignee?: string`
- `deadline?: ISO string` (relative input resolved to ISO at write time)
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
- `LinkedDoc = { path: string; scope: "project" | "global"; note?: string }`
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
11. `assignee`
12. `author`
13. `estimated_minutes`
14. `acceptance_criteria`
15. `definition_of_ready`
16. `order`
17. `goal`
18. `objective`
19. `value`
20. `impact`
21. `outcome`
22. `why_now`
23. `parent`
24. `reviewer`
25. `risk`
26. `confidence`
27. `sprint`
28. `release`
29. `blocked_by`
30. `blocked_reason`
31. `reporter`
32. `severity`
33. `environment`
34. `repro_steps`
35. `resolution`
36. `expected_result`
37. `actual_result`
38. `affected_version`
39. `fixed_version`
40. `component`
41. `regression`
42. `customer_impact`
43. `dependencies`
44. `comments`
45. `notes`
46. `learnings`
47. `files`
48. `tests`
49. `docs`
50. `close_reason`

Unset optional fields are omitted.

### 7.3 Determinism rules

- `updated_at` MUST change for every mutation.
- Relative deadlines (`+6h`, `+1d`, `+2w`) resolve on write and persist as absolute ISO.
- `tags` sorted lexicographically, deduplicated.
- `risk` CLI input alias `med` normalizes to canonical stored value `medium`.
- `confidence` CLI input accepts integers `0..100` or `low|med|medium|high`; `med` persists as `medium`.
- `severity` CLI input alias `med` normalizes to canonical stored value `medium`.
- `dependencies`, `comments`, `notes`, `learnings` sorted by `created_at` ascending; stable tie-break by text/id.
- `files` sorted by `scope` asc, then `path` asc, then `note` asc.
- `tests` sorted by `scope` asc, then `path` asc, then `command` asc, then `timeout_seconds` asc, then `note` asc.
- `docs` sorted by `scope` asc, then `path` asc, then `note` asc.
- Paths normalized to forward-slash logical form for storage while preserving OS-correct access at runtime.
- For optional create/update fields, explicit unset intent is supported via sentinel values:
  - scalar option value `none` (case-insensitive) means "unset/omit field"
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
      "command": "pnpm test history",
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
  "front_matter": { "...": "..." },
  "body": "markdown text"
}
```

### 9.2 Hashing

- Hash algorithm: SHA-256
- Input: canonical JSON serialization of patch document (stable key order, UTF-8 LF)  
- Digest format: lowercase hex

### 9.3 Restore algorithm

`pm restore <ID> <TIMESTAMP|VERSION>`

1. Resolve item and load full history.
2. Replay patches from initial create through target version/timestamp.
3. Rebuild exact canonical document (`front_matter` + `body`).
4. Write item atomically.
5. Append a `restore` history event with patch from pre-restore state to restored state.

Guarantees:

- History is immutable (restore appends, never rewrites old entries).
- Restored item bytes match canonical serialization of target state exactly.

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
- `--profile` print deterministic timing diagnostics (stderr)
- `--version` print CLI version

### 11.2 Exit codes

- `0` success
- `1` generic failure
- `2` usage / invalid args
- `3` not found
- `4` conflict (claim/lock/ownership)
- `5` dependency failed (for orchestration/test-all failures)

### 11.3 Core commands (required for v0.1 release-ready scope)

- `pm init [<PREFIX>]`
- `pm list`
- `pm list-all`
- `pm list-draft`
- `pm list-open`
- `pm list-in-progress`
- `pm list-blocked`
- `pm list-closed`
- `pm list-canceled`
- `pm get <ID>`
- `pm search <keywords>`
- `pm reindex`
- `pm create`
- `pm update <ID>`
- `pm append <ID>`
- `pm claim <ID>`
- `pm release <ID>`
- `pm delete <ID>`
- `pm comments <ID>`
- `pm files <ID>`
- `pm docs <ID>`
- `pm test <ID>`
- `pm test-all`
- `pm stats`
- `pm health`
- `pm gc`
- `pm history <ID>`
- `pm activity`
- `pm restore <ID> <TIMESTAMP|VERSION>`
- `pm close <ID> <TEXT>`
- `pm beads import [--file <path>]`
- `pm todos import [--folder <path>]`
- `pm todos export [--folder <path>]`

Roadmap commands (post-v0.1, tracked but not release blockers):

- No additional command-path roadmap entries are currently defined.

### 11.4 Extended flags (minimum)

Mutating `create` (all schema fields MUST be passable explicitly):

- `--title`, `-t` (required)
- `--description`, `-d` (required; empty string allowed when explicitly passed)
- `--type` (required: `Epic|Feature|Task|Chore|Issue`)
- `--status`, `-s` (required)
- `--priority`, `-p` (required: `0..4`)
- `--tags` (required; explicit empty allowed)
- `--body`, `-b` (required; explicit empty allowed)
- `--deadline` (explicit; accepts ISO, relative `+6h/+1d/+2w`, or none)
- `--estimate`, `--estimated-minutes`, `--estimated_minutes` (explicit; accepts `0`)
- `--acceptance-criteria`, `--acceptance_criteria`, `--ac` (explicit; empty allowed)
- `--author` (explicit; fallback `PM_AUTHOR`/settings allowed)
- `--message` (explicit history message; empty allowed)
- `--assignee` (explicit; use `none` to unset)
- `--parent` (optional; item ID reference or `none`)
- `--reviewer` (optional; or `none`)
- `--risk` (optional; `low|med|medium|high|critical` or `none`; `med` persists as `medium`)
- `--confidence` (optional; `0..100|low|med|medium|high` or `none`; `med` persists as `medium`)
- `--sprint` (optional; or `none`)
- `--release` (optional; or `none`)
- `--blocked-by`, `--blocked_by` (optional; item ID or free-text, or `none`)
- `--blocked-reason`, `--blocked_reason` (optional; or `none`)
- `--reporter` (optional; issue reporter, or `none`)
- `--severity` (optional; `low|med|medium|high|critical`, or `none`; `med` persists as `medium`)
- `--environment` (optional; issue environment context, or `none`)
- `--repro-steps`, `--repro_steps` (optional; issue reproduction steps, or `none`)
- `--resolution` (optional; issue resolution summary, or `none`)
- `--expected-result`, `--expected_result` (optional; issue expected behavior, or `none`)
- `--actual-result`, `--actual_result` (optional; issue observed behavior, or `none`)
- `--affected-version`, `--affected_version` (optional; impacted version identifier, or `none`)
- `--fixed-version`, `--fixed_version` (optional; fixed version identifier, or `none`)
- `--component` (optional; owning component, or `none`)
- `--regression` (optional; boolean `true|false|1|0`, or `none`)
- `--customer-impact`, `--customer_impact` (optional; customer impact summary, or `none`)
- `--definition-of-ready`, `--definition_of_ready` (optional; explicit empty allowed; use `none` to unset)
- `--order`, `--rank` (optional; integer rank/order, or `none`)
- `--goal` (optional; or `none`)
- `--objective` (optional; or `none`)
- `--value` (optional; or `none`)
- `--impact` (optional; or `none`)
- `--outcome` (optional; or `none`)
- `--why-now`, `--why_now` (optional; or `none`)

Mutating `create` flags (repeatable, each required at least once; use `none` for explicit empty intent):

- `--dep` value format: `id=<id>,kind=<blocks|parent|child|related|discovered_from>,author=<a>,created_at=<iso|now>`
- `--comment` value format: `author=<a>,created_at=<iso|now>,text=<t>`
- `--note` value format: `author=<a>,created_at=<iso|now>,text=<t>`
- `--learning` value format: `author=<a>,created_at=<iso|now>,text=<t>`
- `--file` value format: `path=<p>,scope=<project|global>,note=<n?>`
- `--test` value format: `command=<c?>,path=<p?>,scope=<project|global>,timeout_seconds=<n?>,note=<n?>`
- `--doc` value format: `path=<p>,scope=<project|global>,note=<n?>`

Mutating `update` (v0.1 baseline):

- `--title`, `-t`
- `--description`, `-d`
- `--status`, `-s`
- `--priority`, `-p`
- `--type`
- `--tags`
- `--deadline`
- `--estimate`, `--estimated-minutes`, `--estimated_minutes`
- `--acceptance-criteria`, `--acceptance_criteria`, `--ac`
- `--assignee`
- `--parent`
- `--reviewer`
- `--risk` (`low|med|medium|high|critical`; `med` persists as `medium`)
- `--confidence` (`0..100|low|med|medium|high`; `med` persists as `medium`)
- `--sprint`
- `--release`
- `--blocked-by`, `--blocked_by`
- `--blocked-reason`, `--blocked_reason`
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

`pm update` status semantics:

- `--status` supports all non-terminal values plus `canceled`.
- `--status closed` is not supported; callers must use `pm close <ID> <TEXT>` so `close_reason` is always captured.

List/search filters:

- `--type`
- `--tag`
- `--priority`
- `--deadline-before`
- `--deadline-after`

Mutation safety:

- `--author`
- `--message`
- `--force`

### 11.5 Command input/output contracts

All commands return deterministic top-level objects (TOON by default, JSON with `--json`).

| Command | Key inputs | Output object |
| --- | --- | --- |
| `pm init [PREFIX]` | optional prefix, `--path` | `{ ok, path, settings, created_dirs, warnings }` |
| `pm list` | optional filter flags | `{ items, count, filters, now }` |
| `pm list-all` | optional filter flags | `{ items, count, filters, now }` |
| `pm list-draft` | optional type/tag/priority/deadline filters | `{ items, count, filters, now }` |
| `pm list-open` | optional type/tag/priority/deadline filters | `{ items, count, filters, now }` |
| `pm list-in-progress` | same as above | `{ items, count, filters, now }` |
| `pm list-blocked` | same as above | `{ items, count, filters, now }` |
| `pm list-closed` | same as above | `{ items, count, filters, now }` |
| `pm list-canceled` | same as above | `{ items, count, filters, now }` |
| `pm get <ID>` | normalized id | `{ item, body, linked: { files, tests, docs } }` |
| `pm search <keywords>` | keyword query + optional mode/include-linked/limit filters | `{ query, mode, items, count, filters, now }` |
| `pm reindex` | optional `--mode` (`keyword|semantic|hybrid` baseline) | `{ ok, mode, total_items, artifacts, warnings, generated_at }` |
| `pm beads import --file <path?>` | optional Beads JSONL source path (defaults to `.beads/issues.jsonl`) | `{ ok, source, imported, skipped, ids, warnings }` |
| `pm todos import --folder <path?>` | optional todos markdown source folder (defaults to `.pi/todos`) | `{ ok, folder, imported, skipped, ids, warnings }` |
| `pm todos export --folder <path?>` | optional todos markdown destination folder (defaults to `.pi/todos`) | `{ ok, folder, exported, ids, warnings }` |
| `pm create ...` | required title + schema flags | `{ item, changed_fields, warnings }` |
| `pm update <ID> ...` | id + patch-like flags (`--status closed` is rejected; use `pm close <ID> <TEXT>`) | `{ item, changed_fields, warnings }` |
| `pm delete <ID>` | id + optional `--author`/`--message`/`--force` | `{ item, changed_fields, warnings }` |
| `pm close <ID> <TEXT>` | id + close reason text + optional `--author/--message/--force` | `{ item, changed_fields, warnings }` |
| `pm append <ID> --body` | id + appended markdown | `{ item, appended, changed_fields }` |
| `pm claim <ID>` | id, optional `--author`/`--message`/`--force` | `{ item, claimed_by, previous_assignee, forced }` |
| `pm release <ID>` | id, optional `--author`/`--message`/`--force` | `{ item, released_by, previous_assignee, forced }` |
| `pm comments <ID> --add/--limit` | id + comment text/limit | `{ id, comments, count }` |
| `pm files <ID> --add/--remove` | id + file refs | `{ id, files, changed, count }` |
| `pm test <ID> --add/--remove/--run` | id + test refs/options (reject recursive `test-all` linked commands at add-time, including global-flag and package-spec launcher forms such as `pm --json test-all`, `npx pm-cli@latest --json test-all`, `pnpm dlx pm-cli@latest --json test-all`, and `npm exec -- pm-cli@latest --json test-all`, defensively skip legacy recursive entries at run-time, and reject sandbox-unsafe test-runner commands including unsandboxed direct package-manager run-script forms such as `npm run test`/`pnpm run test` and chained direct runner segments evaluated independently) | `{ id, tests, run_results, changed, count }` |
| `pm test-all --status --timeout` | optional status filter; duplicate linked command/path entries are deduped per invocation (keyed by scope+normalized command or scope+path) and reported as skipped; when duplicate keys carry different `timeout_seconds`, execution uses deterministic maximum timeout for that key | `{ totals, failed, passed, skipped, results }` |
| `pm stats` | none | `{ totals, by_type, by_status, generated_at }` |
| `pm health` | none | `{ ok, checks, warnings, generated_at }` |
| `pm gc` | none | `{ ok, removed, retained, warnings, generated_at }` |
| `pm docs <ID> --add/--remove` | id + doc refs | `{ id, docs, changed, count }` |
| `pm history <ID> --limit` | id + optional limit | `{ id, history, count, limit }` |
| `pm activity --limit` | optional limit | `{ activity, count, limit }` |
| `pm restore <ID> <TIMESTAMP\|VERSION>` | id + restore target + optional `--author/--message/--force` | `{ item, restored_from, changed_fields, warnings }` |

Roadmap output contracts remain defined in this PRD for extension areas and advanced search tuning that are still out of v0.1 release scope.

## 12) Canonical Output Objects (TOON-first)

All commands return a deterministic top-level object with stable key order.

Examples:

- `list*`:
  - `{ items, count, filters, now }`
- `search`:
  - `{ query, mode, items, count, filters, now }`
- `get`:
  - `{ item, body, linked: { files, tests, docs } }`
- `create/update/delete`:
  - `{ item, changed_fields, warnings }`
- `append`:
  - `{ item, appended, changed_fields }`
- `test-all`:
  - `{ totals, failed, passed, skipped, results }`
- roadmap examples (advanced semantic/hybrid tuning expansion) remain post-v0.1.

Determinism requirements:

- Stable key order in every object.
- Stable array order for `items` (default sort: open before terminal, then priority asc, then updated_at desc, then id asc).
- TOON and JSON contain same logical content.
- `--quiet` prints nothing to stdout but still uses exit codes.

## 13) Search Architecture

### 13.0 Command contract (implemented baseline)

`pm search <keywords>` is implemented across keyword, semantic, and hybrid modes with deterministic ordering. The baseline command searches core item corpus fields, supports vector-query execution when configured, and returns stable TOON/JSON output parity.

Initial flags:

- `--mode <keyword|semantic|hybrid>` (all modes implemented baseline; advanced semantic/hybrid tuning planned)
- `--include-linked` (keyword mode and hybrid lexical component: include readable linked docs/files/tests content in corpus scoring)
- `--limit <n>`
- shared list-like filters where applicable (`--type`, `--tag`, `--priority`, `--deadline-before`, `--deadline-after`)
- shared `--type` and `--priority` filters follow canonical validation (`--type` in `Epic|Feature|Task|Chore|Issue`, `--priority` integer `0..4`)

### 13.1 Modes

- `keyword` (always available)
- `semantic` (when embedding provider + vector store configured)
- `hybrid` (default if semantic available)

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
- `pm search --mode semantic|hybrid` and `pm reindex --mode semantic|hybrid` use this abstraction for deterministic semantic/hybrid execution (embedding generation/request handling) after configuration validation.

Vector stores:

- Qdrant (`url`, `api_key?`)
- LanceDB (`path`)

Implemented baseline:

- Deterministic vector-store configuration resolution for Qdrant and LanceDB is available in core search runtime plumbing.
- Qdrant/LanceDB settings blocks are normalized from `settings.json` and surfaced through a vector-store abstraction layer for command-time validation.
- Request-target planning, request payload/response normalization, deterministic Qdrant request-execution helper behavior, deterministic LanceDB local query/upsert execution helper behavior, and deterministic query-hit ordering normalization (score desc, id asc tie-break) are available through this abstraction layer.
- `pm search --mode semantic|hybrid` and `pm reindex --mode semantic|hybrid` use this abstraction for deterministic vector query/upsert execution after configuration validation.

## 14) Extension Architecture

### 14.1 Locations

- Global: `~/.pm-cli/extensions` (or `PM_GLOBAL_PATH/extensions`)
- Project: `.agents/pm/extensions` (or `PM_PATH/extensions`)

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
`schema`, `importers`, `search`) or activation fails with deterministic
`extension_activate_failed:<layer>:<name>` diagnostics.
Unknown capability names are ignored for registration gating and produce deterministic
discovery diagnostics `extension_capability_unknown:<layer>:<name>:<capability>`.

### 14.4 Extension API contracts (v1 draft)

v0.1 implemented baseline (release-hardening in progress):

- `activate(api)` hook registration surface is available.
- `api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex` dispatch is deterministic with failure containment and per-hook context snapshot isolation.
- Hook registration APIs (`api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex`) require function handlers; invalid payloads throw during extension activation and surface deterministic `extension_activate_failed:<layer>:<name>` warnings.
- `api.registerCommand(name, override)` supports deterministic overrides for existing core command results before output rendering; override execution receives cloned command `args`/`options`/`global` snapshots, `pm_root`, and a cloned prior result payload so extensions can apply contextual overrides without mutating caller fallback state.
- `api.registerCommand({ name, run })` supports deterministic extension command handlers for declared command paths, including dynamically surfaced non-core extension command paths (for example `beads import` and `acme sync`) with precedence-safe dispatch.
- Extension command-handler execution receives cloned `args`/`options`/`global` snapshots so handler-side mutation cannot leak into caller runtime command state.
- Registered extension command names are canonicalized with trim + lowercase + internal-whitespace collapse before storage and dispatch matching, ensuring equivalent command paths resolve deterministically.
- Required extension-command dispatch semantics are deterministic: no matched handler returns command-not-found for extension-only paths, while a matched handler throw returns generic failure with warning code `extension_command_handler_failed:<layer>:<name>:<command>`.
- `api.registerRenderer(format, renderer)` supports deterministic `toon`/`json` output overrides; renderer execution receives isolated command context snapshots (`command`, `args`, `options`, `global`, `pm_root`) plus an isolated result snapshot so failed renderer-side mutation cannot alter core fallback output.
- Extension API registration baseline now includes deterministic registration-time validation and metadata capture for `api.registerFlags`, `api.registerItemFields`, `api.registerMigration`, `api.registerImporter`, `api.registerExporter`, `api.registerSearchProvider`, and `api.registerVectorStoreAdapter`.
- `api.registerImporter(name, importer)` and `api.registerExporter(name, exporter)` now provide runtime command wiring in addition to metadata capture: each registration deterministically exposes extension command-handler paths `<name> import` and `<name> export` (canonicalized with trim + lowercase + internal-whitespace collapse) and executes through the same isolated command-handler context snapshots used by `api.registerCommand({ name, run })`.
- Dynamically surfaced extension command paths now render deterministic help metadata derived from registered `api.registerFlags(...)` definitions while preserving loose option parsing behavior for runtime command dispatch.
- Extension API and hook registration calls enforce manifest capability declarations (`commands`, `renderers`, `hooks`, `schema`, `importers`, `search`) and fail activation deterministically when an extension registers outside its declared capabilities.
- Extension activation diagnostics include deterministic registration counts and metadata summaries for the above registries (flags, item fields, migrations, importers, exporters, search providers, and vector store adapters), `pm health` exposes deterministic migration status summaries from registered migration definitions (`status="failed"` -> failed, `status="applied"` -> applied, any other/missing status -> pending), and core write command paths enforce deterministic mandatory-migration gating (`mandatory=true` + status not `"applied"` -> unresolved blocker, with `--force` bypass on force-capable write commands).

Full v1 draft surface (broader runtime wiring for remaining newly registered definitions beyond dynamic command help and importer/exporter command-path mapping remains roadmap):

```ts
export interface PmExtension {
  manifest: ExtensionManifest;
  activate(api: ExtensionApi): Promise<void> | void;
}

export interface ExtensionApi {
  registerCommand(def: CommandDefinition): void;
  registerFlags(targetCommand: string, flags: FlagDefinition[]): void;
  registerItemFields(fields: SchemaFieldDefinition[]): void;
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
- `pm health` extension checks must run safe runtime load and activation probes (including enabled built-in extensions) and emit deterministic warning codes for import/activation failures (for example `extension_load_failed:<layer>:<name>` and `extension_activate_failed:<layer>:<name>`).
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

## 15) Built-in Extensions Required in v1

### A) Beads import

Command:

- `pm beads import [--file <path>]`

Current baseline status (release-hardening):

- Command is extension-packaged through a built-in `activate(api)` module using `api.registerCommand({ name, run })` for the `beads import` command path, with no core-command fallback path.

Behavior:

- Parse Beads JSONL records.
- Map Beads fields to PM schema.
- Preserve IDs and timestamps where possible.
- Append history with `op: "import"`.
- Default input path is `.beads/issues.jsonl` when `--file` is not provided.
- Invalid JSONL lines or duplicate IDs are skipped with deterministic warnings.

### B) todos.ts import/export

Commands:

- `pm todos import [--folder <path>]`
- `pm todos export [--folder <path>]`

Current baseline status (release-hardening):

- Commands are extension-packaged through a built-in `activate(api)` module using `api.registerCommand({ name, run })` for `todos import` and `todos export` command paths.

Behavior:

- Read/write todos markdown format (JSON front-matter + body).
- Field mapping:
  - `title -> title`
  - `body -> body`
  - `status/tags/created_at/assignee/confidence -> same`
  - `confidence` text aliases normalize deterministically (`med -> medium`)
- Missing PM fields get deterministic defaults:
  - `description = ""`
  - `priority = 2`
  - `type = "Task"`
  - `updated_at = created_at (or now if missing)`

### C) Pi tool wrapper

Current baseline status (release-hardening):

- Implemented as a Pi agent extension source module at `.pi/extensions/pm-cli/index.ts` (outside the `pm` CLI command surface).
- Registers one Pi tool named `pm` via Pi's extension API (`registerTool`) and maps `action` + command-shaped fields to `pm` CLI invocations.
- Action dispatch currently covers the full v0.1 command-aligned set (`init`, `create`, `list`, `list-all`, `list-draft`, `list-open`, `list-in-progress`, `list-blocked`, `list-closed`, `list-canceled`, `get`, `search`, `reindex`, `history`, `activity`, `restore`, `update`, `close`, `delete`, `append`, `comments`, `files`, `docs`, `test`, `test-all`, `stats`, `health`, `gc`, `claim`, `release`) plus extension action aliases (`beads-import`, `todos-import`, `todos-export`).
- Invocation fallback order is deterministic for distribution resilience: attempt `pm` first, then fallback to packaged `node <package-root>/dist/cli.js` when `pm` is unavailable.

- Expose one tool `pm`.
- Parameters include:
  - `action` enum mapped to CLI commands
  - common fields (`id`, `title`, `status`, `tags`, `body`, etc.)
  - search-specific parity fields including `mode` and `includeLinked` (`--include-linked`)
  - claim/release metadata parity fields including `author`, `message`, and `force` (`--author`, `--message`, `--force`)
  - explicit empty-string passthrough for empty-allowed CLI flags (for example `--description ""` and `--body ""`)
  - numeric scalar parity for numeric CLI flags: wrapper accepts either JSON numbers or strings for `priority`, `estimate`, `limit`, and `timeout`, then stringifies values for deterministic CLI argument emission
- Return object:
  - `content: [{ type: "text", text: <TOON or JSON string> }]`
  - `details: <structured object>`

Wrapper behavior must remain aligned with CLI semantics and exit conditions.

## 16) Security and Data Integrity

- All writes are lock-protected + atomic.
- Never partially write item or history line.
- Validate and normalize path inputs to prevent traversal.
- `pm search --include-linked` must enforce scope-root containment on linked content reads using both resolved-path and symlink-resolved-realpath checks, and ignore linked paths that escape allowed roots.
- Extension manifest `entry` paths must not escape their owning extension directory.
- Dynamic extension command loose-option parsing must ignore unsafe prototype keys (`__proto__`, `constructor`, `prototype`) and use null-prototype option maps before passing option snapshots to extension command handlers.
- Never execute linked test commands without explicit `--run`.
- Reject linked test command entries that invoke `pm test-all` (including global-flag and package-spec launcher variants such as `pm --json test-all`, `npx pm-cli@latest --json test-all`, `pnpm dlx pm-cli@latest --json test-all`, and `npm exec -- pm-cli@latest --json test-all`) to prevent recursive orchestration loops.
- `pm test <ID> --run` defensively skips legacy linked command entries that invoke `pm test-all` (including global-flag and package-spec launcher variants such as `npx`, `pnpm dlx`, and `npm exec` launcher forms) and records deterministic skipped results.
- Reject linked test-runner command entries (for example `pnpm test`, `pnpm test:coverage`, `npm test`, `npm run test`, `pnpm run test`, `yarn run test`, `bun run test`, `vitest`) unless they use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; chained direct test-runner segments are validated independently and rejected when not explicitly sandboxed.
- `pm test-all` executes each unique linked command/path key at most once per run; duplicate entries are reported as skipped to keep totals deterministic while avoiding redundant execution. Duplicate-key timeout conflicts resolve deterministically to the maximum `timeout_seconds` value for that key.
- Optional providers use explicit settings; secrets come from env or settings with documented precedence.
- Restore must verify replay hashes and fail loudly on mismatch.

## 17) Configuration

`settings.json` baseline keys:

- `version`
- `id_prefix`
- `author_default`
- `locks.ttl_seconds`
- `output.default_format`
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
- `pm test <ID> --add` MUST enforce this by rejecting sandbox-unsafe test-runner command entries at add-time unless they use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; this includes unsandboxed direct package-manager run-script variants (for example `npm run test` and `pnpm run test`) and chained direct test-runner segments that are not explicitly sandboxed.
- `pm test <ID> --run` MUST defensively skip legacy linked command entries that invoke `pm test-all` (including global-flag and package-spec launcher variants such as `pm --json test-all`, `npx pm-cli@latest --json test-all`, `pnpm dlx pm-cli@latest --json test-all`, and `npm exec -- pm-cli@latest --json test-all`) and surface deterministic skipped diagnostics.
- Integration tests spawn built CLI subprocesses (`node dist/cli.js ...`) with explicit
  `PM_PATH`, `PM_GLOBAL_PATH`, and `PM_AUTHOR`.
- Temporary sandbox directories must be cleaned up after each test/suite.

Required unit coverage areas:

- Parser/serializer round-trip and key ordering determinism.
- ID normalization/generation behavior.
- Deadline and `none` token parsing.
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
- [x] Parser/serializer for markdown item files
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

- [~] keyword indexing + search command (keyword command surface + deterministic reindex artifact rebuild baseline implemented)
- [~] embedding provider abstraction (deterministic provider configuration resolution, request-target planning including OpenAI-compatible `base_url` normalization for root/`/v1`/`/embeddings`, provider-specific request payload/response normalization with deterministic OpenAI data-entry index ordering, deterministic request-execution helper behavior, deterministic embedding cardinality validation, deterministic per-request normalized-input dedupe with output fan-out, command-path embedding execution baseline, and mutation-triggered embedding refresh baseline are implemented; additional advanced provider optimizations remain pending)
- [~] vector store adapters (Qdrant/LanceDB deterministic configuration resolution, request-target planning, request payload/response normalization, deterministic request-execution helpers, deterministic LanceDB local query/upsert/delete execution helper behavior, deterministic local snapshot persistence + reload across process boundaries, query-hit ordering normalization, and command-path vector query/upsert integration baseline implemented; broader adapter optimization remains pending)
- [~] hybrid ranking + include-linked option (`--include-linked` lexical baseline implemented for keyword mode and hybrid lexical blending; deterministic hybrid lexical+semantic blend baseline implemented with configurable `search.hybrid_semantic_weight`; deterministic exact-title token lexical boost baseline implemented; configurable multi-factor lexical tuning via `search.tuning` implemented; broader advanced semantic/hybrid tuning remains pending)
- [~] reindex command (keyword baseline complete; semantic/hybrid embedding+vector upsert baseline implemented; mutation command paths now invalidate stale keyword artifacts, trigger best-effort semantic embedding refresh for affected item IDs, and prune vectors for missing/deleted IDs when semantic configuration is available)

Definition of Done:

- Search works in keyword-only and semantic/hybrid mode
- item mutations trigger search-index freshness via deterministic cache invalidation plus best-effort semantic embedding refresh for affected item IDs when semantic configuration is available, including pruning vectors for missing/deleted affected IDs, with explicit reindex workflows retained for full rebuilds

### Milestone 5 - Extension System + Built-ins

Checklist:

- [~] extension manifest loader + sandboxed execution boundary (deterministic manifest discovery, precedence, failure-isolated runtime loading, realpath/symlink-resolved entry containment enforcement, command-handler context snapshot isolation for `args`/`options`/`global`, per-hook context snapshot isolation, and dynamic extension command loose-option parsing hardening (null-prototype option maps + prototype-pollution key rejection) are implemented; broader command sandbox API boundary remains in progress)
- [x] hook lifecycle (extension `activate(api)` baseline with deterministic hook registration is implemented; registration now validates hook handlers as functions at activation time, per-hook context snapshot isolation prevents mutation leakage across hook callbacks and caller state, and `beforeCommand`/`afterCommand` command-lifecycle execution plus baseline read/write/index call-site wiring for core item-store reads/writes, create/restore item and history writes, settings read/write operations, history/activity history-directory scans and history-stream reads, health history-directory scans plus history-stream path dispatch, search item/linked reads, reindex flows, stats/health/gc command file-system paths (including `pm gc` onIndex dispatch with mode `gc` and deterministic cache-target totals), lock file read/write/unlink operations, init directory bootstrap ensure-write dispatch, and built-in beads/todos import-export source/item/history file operations are implemented)
- [x] renderer and command extension points (deterministic core-command override + renderer override registration/dispatch is implemented with failure containment, extension command handlers for declared command paths including dynamically surfaced non-core paths are implemented, dynamic command help now surfaces `registerFlags` metadata deterministically, deep snapshot isolation for override/renderer result contexts is implemented, and override/renderer execution now includes cloned command `args`/`options`/`global` snapshots plus `pm_root` metadata for contextual deterministic extension output behavior)
- [~] built-in beads import extension (built-in extension command-handler packaging implemented; parity polish and additional extension hardening remain in progress)
- [~] built-in todos import/export extension (built-in extension command-handler packaging implemented; parity polish and additional hardening remain in progress)
- [~] built-in Pi tool wrapper extension (Pi agent extension module with full v0.1 action dispatch parity is implemented; packaging/distribution polish remains in progress)

Definition of Done:

- Project/global precedence verified
- failing extension reported in `pm health` without core corruption

### Milestone 6 - Hardening + Release Readiness

Checklist:

- [x] CI matrix finalized
- [x] fixture corpus for restore/import/search
- [x] command help and README examples validated in tests
- [x] repository layout refactor (`src/cli`, `src/core`, `src/types`)
- [x] sandboxed integration harness (`withTempPmPath`)
- [x] sandboxed pm-runner (`scripts/run-tests.mjs`) for `pm test` and `pm test-all` safety
- [x] installer scripts (`scripts/install.sh`, `scripts/install.ps1`) with post-install `pm --version` availability verification
- [x] npm packaging allowlist + prepublish build guard
- [x] community docs baseline (`LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`)

Definition of Done:

- All required commands and tests passing
- docs and behavior aligned with this PRD

## 22) Open Assumptions and Clarifications Captured

- Imported Beads dependency types outside canonical set are mapped best-effort:
  - `parent-child` -> `parent`/`child` directional mapping based on source context
  - unknown values retained in import metadata notes if lossy mapping is required
- Hierarchical IDs from imports are preserved verbatim; new IDs generated by core default to flat `prefix-token`.
- TOON formatting follows deterministic encoding with stable object keys; internal serializer may use a thin compatibility layer to ensure strict consistency across Node versions.
- For `create`, `before_hash` is computed from canonical empty document: `{ "front_matter": {}, "body": "" }`.
- If create item write succeeds but history append fails, implementation MUST rollback the new item file before returning failure.
- ID normalization helper behavior (`#` prefix, missing configured prefix, case-insensitive input) is required in core utilities even before all commands expose it.
