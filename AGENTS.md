# AGENTS.md - Operating Rules for `pm`

This document defines how coding agents must use `pm` for planning, execution, and reporting in this repository.

## 1) Core Rules

- Use `pm` as the system of record for project work.
- Prefer deterministic, script-friendly command usage (`--json` when strict parsing is needed).
- Default to TOON output when human + model readability and low token use are desired (calendar command is the intentional exception and defaults to markdown unless overridden).
- Treat TOON as the canonical item-document format in this repo; item metadata is modeled as `metadata` internally and stored as top-level object fields in TOON.
- Never make destructive item changes outside `pm` mutations.
- Every mutation must produce a history entry.

### 1.1) Session Bootstrap (Required)

- Determine command invocation before running mutations:
  - Use `PM_CMD="pm"` only when `pm` clearly resolves to this repository's current build.
  - Otherwise use `PM_CMD="node dist/cli.js"` from repository root.
- Set `PM_AUTHOR` explicitly for all maintainer runs.
- Refresh the global CLI from this repository for maintainer runs:
  - Run `npm install -g .` from repository root.
  - Verify availability with `pm --version` before mutation commands.
- Run baseline runtime/build sanity checks before mutation commands:
  - `PM_CMD --version`
  - `node -v`
  - `pnpm -v`
  - `pnpm build` (if configured)
- For real repository tracking, do not override `PM_PATH`.
- For tests only, always use sandboxed `PM_PATH` and `PM_GLOBAL_PATH` (or `node scripts/run-tests.mjs ...`).

## 2) Canonical Agent Workflow

### Step A - Pick next work

Before creating any new `pm` item, always check for an existing relevant item first.

- Search and list existing items before `pm create`:
  - `pm context --limit 10` (brief snapshot; use `--depth standard` for hierarchy/progress/workload, `--depth deep` for full sections)
  - `pm search "<keywords>" --limit 10`
  - `pm list-open --limit 20`
  - `pm list-in-progress --limit 20`
- If a relevant item already exists, reuse it, update it, or claim it instead of creating a new one.
- Never create duplicate `pm` items for the same work.
- Before `pm create`, identify the canonical parent lineage (`Epic` -> `Feature`) for the incoming scope.
- If scope is truly net-new, create/normalize parent lineage first, then create child work with explicit `--parent`.
- Add a create-time comment that records duplicate-check evidence (commands run + why net-new scope was required).

Use one of:

- `pm list-in-progress --limit 20`
- `pm list-open --limit 20`
- `pm list-blocked --limit 20`

Then filter:

- by type: `--type <value>` (resolved by runtime type registry: built-ins plus configured custom types)
- by priority: `--priority 0..4`
- by tag: `--tag <name>`

### Step B - Claim ownership

- `pm claim <ID>`
- If conflict and explicitly approved: `pm claim <ID> --force`
- `pm claim` takeover of non-terminal items assigned to another owner does not require `--force`; reserve `--force` for terminal-state or lock override paths.

Rules:

- Do not work unclaimed unless the task is intentionally collaborative.
- If switching context, release previous claim.

### Step C - Clarify task intent

Populate metadata early:

- `pm update <ID> --description "..."`
- `pm update <ID> --acceptance-criteria/--ac "..."`
- `pm update <ID> --body "..."` (replace body content for normalization/backfill; use `pm append --body` for additive notes)
- `pm update <ID> --parent <ID>` to keep hierarchy deterministic for future linking (clear with `pm update <ID> --unset parent`)
- `pm update <ID> --estimate <minutes>`
- `pm update <ID> --deadline +1d` (accepts ISO/date strings or relative `+6h/+1d/+2w/+6m`; resolved to ISO at write)
- `pm update <ID> --close-reason <text>` for explicit close_reason set; clear with `pm update <ID> --unset close-reason` (reopen transitions from `closed` to non-terminal status auto-clear stale close_reason unless explicitly overridden in that same update call)
- when team-level close-readiness policy changes, update Definition of Done criteria via:
  - `pm config project set definition-of-done --criterion "tests pass" --criterion "linked files/tests/docs present" --criterion "parent/dependency links complete" --criterion "duplicate check performed before create"`

### Step D - Link execution context

Attach references to keep work reproducible:

- Files:
  - `pm files <ID> --add path=src/app.ts,scope=project,note="entrypoint"`
  - `pm files <ID> --add-glob "src/**/*.ts"` for deterministic batch linking
  - `pm files <ID> --add path=src/new.ts,scope=project --append-stable` when preserving existing link order and minimizing history patch churn
- Tests:
  - `pm test <ID> --add command="node scripts/run-tests.mjs test",scope=project,timeout_seconds=240`
  - `pm test <ID> --add command="node scripts/run-tests.mjs test -- tests/history.spec.ts",path=tests/history.spec.ts,scope=project`
- Docs:
  - `pm docs <ID> --add path=docs/ARCHITECTURE.md,scope=project`
- Command boundaries:
  - `pm update` intentionally does not mutate linked files/docs; use `pm files` / `pm docs`.
  - `pm deps` is read-only and intended for dependency tree/graph inspection (`--format tree|graph`).
- Entry-format resilience:
  - `--add`/repeatable seed flags accept CSV `key=value`, markdown `key: value`, or stdin token `-` with piped payload.
  - for `pm create` log-seed flags, `--comment` supports plain-text shorthand in addition to structured key/value input; structured `--comment`/`--note`/`--learning` payloads accept only `author`, `created_at`, and `text` keys. Quote punctuation-heavy text (for example `text="hello,scope:project"`) or use markdown/stdin to avoid ambiguous key-like continuations.
  - for `pm comments|notes|learnings --add`, CSV-like strings with extra key fragments (for example `text=hello,scope:project`) are intentionally preserved as plain text; use explicit `text=...`, markdown `text: ...`, or stdin token `-` when structured parsing is required.
  - Example: `printf '%s\n' 'path: src/app.ts' 'scope: project' | pm files <ID> --add -`

### Step E - Record progress

Use append-style updates:

- `pm comments <ID> "Implemented lock retry path"` (or `--add "..."` for structured/stdin forms)
- use `pm comments <ID> ... --allow-audit-comment` for append-only audit comments on items assigned to another owner
- use `pm notes <ID> ... --allow-audit-comment` / `pm learnings <ID> ... --allow-audit-comment` for append-only audit note/learning entries on another owner's item
- use `pm update <ID> --dep ... --allow-audit-dep-update` for cross-owner append-only dependency wiring without broad `--force`
- use `pm release <ID> ... --allow-audit-release` for non-owner handoffs that only clear assignee metadata
- reserve `pm comments <ID> ... --force` for coordinated ownership-override paths beyond append-only audit comments
- `pm update <ID> --status in_progress`
- `pm append <ID> --body "Detailed implementation notes..."`

Capture durable notes:

- `pm notes <ID> --add "Design rationale and implementation context"`
- `pm learnings <ID> --add "Durable lesson for future work"`

### Step F - Validate and close

Before close:

1. Run linked tests:
   - `pm test <ID> --run` (add `--progress` for explicit non-interactive stderr progress visibility)
  - optional managed background mode: `pm test <ID> --run --background` / `pm test-all --background`, then monitor/control with `pm test-runs` (defaults to list) or explicit `pm test-runs list|status|logs|stop|resume`
2. Run sandbox-safe coverage verification:
   - `node scripts/run-tests.mjs coverage`
3. Optionally run project sweep:
   - `pm test-all --status in_progress` (add `--progress` for explicit non-interactive visibility)
   - `pm test-all --status closed` (when running a broader release-readiness regression sweep)
   - Avoid linking `pm test-all` itself as an item-level linked test command, since that creates recursive orchestration.
4. Run targeted close-readiness validation when relevant:
   - `pm validate --check-resolution --check-history-drift`
   - `pm normalize --dry-run --json` (when performing lifecycle metadata hygiene sweeps before apply mode)
   - for linked-file coverage audits, use `pm validate --check-files --scan-mode tracked-all`
5. Add closure evidence:
   - `pm comments <ID> "Evidence: tests X, Y passed; coverage remains 100%."` (or `--add "..."`)

Close (current v0.1 workflow):

- `pm close <ID> "<reason>" --validate-close warn --author "..." --message "Close: <reason with evidence>"`

### Step G - Release claim

- `pm release <ID>`

Use release when:

- work is paused
- handoff is complete
- task is closed/canceled

## 3) Safe Automation Rules

- Do not rewrite item files directly; mutate via `pm` commands only.
- Do not bypass lock/conflict semantics except with explicit `--force`.
- Do not delete history logs.
- Do not run destructive project commands based only on item text; require explicit user approval.
- If restore is needed, use:
  - `pm restore <ID> <TIMESTAMP|VERSION>`
- If uncertain about mutation intent, add comment first, then mutate.

## 3.1 Test Safety Rules (Hard Requirement)

- Tests must never read/write the repository's real `.agents/pm` data.
- Unit/integration test runs must set `PM_PATH` to a temporary sandbox directory.
- pm-driven test execution should use `node scripts/run-tests.mjs <test|coverage>` so both `PM_PATH` and `PM_GLOBAL_PATH` are sandboxed automatically per run.
- `pm test <ID> --add` should only link sandbox-safe runnable commands and now requires `command=...` metadata (optional `path=...` is supplemental context): use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; sandbox-unsafe runner commands are rejected at add-time, including unsandboxed package-manager run-script variants (for example `npm run test`, `pnpm run test`, `yarn run test`, and `bun run test`) and chained direct test-runner segments that are not explicitly sandboxed.
- `pm test <ID> --run` should defensively skip legacy linked commands that invoke `pm test-all` (including global-flag and package-spec launcher forms such as `pm --json test-all`, `npx @unbrained/pm-cli@latest --json test-all`, `pnpm dlx @unbrained/pm-cli@latest --json test-all`, and `npm exec -- @unbrained/pm-cli@latest --json test-all`) and report deterministic skipped results.
- `pm test <ID> --run` / `pm test-all` should preserve sandbox isolation while seeding project/global `settings.json` and `extensions/` from source roots so extension-defined type/schema behavior matches direct workspace runs.
- `pm test <ID> --run --background` / `pm test-all --background` should be treated as additive lifecycle controls only; use `pm test-runs` commands for status/log/stop/resume and rely on fingerprint dedupe to avoid duplicate parallel runs.
- PM-command linked-test runs should default to `--pm-context schema`; PM tracker-read linked commands fail on context mismatch by default in schema mode, `--pm-context auto` can route tracker-read commands automatically, and `--pm-context tracker` should be used when full tracker parity is required. Use `--check-context` for deterministic preflight diagnostics and `--auto-pm-context` for tracker-read auto-remediation. Per-linked-test `pm_context_mode` metadata can override run-level mode; when that override forces schema against run-level tracker, mismatch guidance should call out the override explicitly. Rely on `run_results[].execution_context` metadata (including tracker-read classification plus `requested_pm_context_mode` / `auto_pm_context_applied`) for parity diagnostics.
- Use strict governance flags when verification quality matters: `--fail-on-context-mismatch`, `--fail-on-skipped`, and `--require-assertions-for-pm`.
- Treat failed linked-test run results from `pm test <ID> --run` as dependency-failed process exits (code `5`) in automation/CI checks, matching `pm test-all` gating semantics.
- Linked-test assertion metadata is optional but preferred for PM-command checks (`assert_stdout_contains`, `assert_stdout_regex`, `assert_stderr_contains`, `assert_stderr_regex`, `assert_stdout_min_lines`, `assert_json_field_equals`, `assert_json_field_gte`).
- `pm test-all` deduplicates linked tests by scope+normalized command or scope+path (including runtime directives/assertions/context metadata) and reports duplicates as skipped; when duplicate keys disagree on `timeout_seconds`, execution uses the deterministic maximum timeout for that key.
- Item-level test result persistence is controlled via `pm config ... test-result-tracking --policy enabled|disabled`; when enabled, bounded `test_runs` summaries are appended on `pm test --run` / `pm test-all` completion.
- Integration tests should invoke the built CLI (`node dist/cli.js ...`) with explicit `PM_PATH`, `PM_GLOBAL_PATH`, and `PM_AUTHOR`.
- Cleanup temporary test directories after each test/suite.

## 3.2 Community Files Baseline (Release Requirement)

- Keep these files present and current for release readiness:
  - `LICENSE` (MIT) at repository root
  - `CHANGELOG.md` using Keep a Changelog with `[Unreleased]`
  - `CONTRIBUTING.md` with local dev and test workflow
  - `SECURITY.md` with vulnerability reporting instructions
  - `CODE_OF_CONDUCT.md` contributor behavior policy

## 3.3 Terminal Compatibility Guardrails

- Keep CLI output terminal-neutral by default: deterministic TOON/JSON/markdown text, no required custom OSC/ANSI protocol.
- Preserve canonical exit-code mapping while preferring graceful exit handling (`process.exitCode`) over forced `process.exit(...)` when feasible.
- For stdin token paths (`-`) and `pm beads import --file -`, treat interactive TTY stdin as usage error and provide explicit piped-input guidance.
- Document and test manual EOF guidance for interactive sessions:
  - Unix/macOS: `Ctrl+D`
  - Windows: `Ctrl+Z` then `Enter`
- For linked test orchestration (`pm test --run` / `pm test-all`), maintain sandbox safety and non-interactive child process behavior, including deterministic timeout/maxBuffer diagnostics.
- For long-running linked-test and reindex paths, use additive `--progress` when non-interactive visibility is required.

## 4) Token Minimization Rules (TOON-first)

- Prefer default TOON output for list/search/get in agent loops.
- Prefer `pm context --limit <n>` as the first triage snapshot when selecting next work.
  - `--depth brief` (default) shows only focus items + agenda -- minimal tokens.
  - `--depth standard` adds hierarchy, activity, progress, and workload sections -- recommended for medium/large projects.
  - `--depth deep` adds blockers, hot files, staleness, and test health -- use for full project orientation or debugging.
  - `--section <name>` (repeatable) overrides `--depth` and includes only named sections (hierarchy, activity, progress, blockers, files, workload, staleness, tests).
  - `--activity-limit <n>` controls recent activity entries (default 10).
  - `--stale-threshold <value>` controls staleness cutoff in days (default 7d).
  - Configure persistent defaults via `pm config project set context --default-depth standard --activity-limit 15`.
- Use `--json` only when strict machine parsing is required.
- Request narrow outputs:
  - `--limit`
  - status/type/priority/tag filters
- Prefer focused retrieval:
  - `pm get <ID>` over broad list scans.
- Keep prompts concise by referencing IDs and linked artifacts, not pasting long bodies.

## 5) Status and Ownership Norms

- `draft`: incomplete definition
- `open`: ready to be claimed
- `in_progress`: active implementation
- `blocked`: waiting on dependency/input
- `closed`: done and verified
- `canceled`: intentionally discontinued
- Input compatibility: `in-progress` is accepted for status flags and normalized to `in_progress`.

Ownership:

- `assignee` identifies current owner for claim/release and conflict checks.
- use explicit `--assignee` or `--author` values that are stable and meaningful for your agent identity.

## 6) Dependency Management Conventions

Use explicit dependency entries via `pm create --dep`:

- format: `id=<id>,kind=<blocks|parent|child|related|discovered_from>,author=<a>,created_at=<iso|now>`
- include one `kind=parent` entry for epic/feature/task hierarchy where applicable
- include `kind=related` / `kind=blocks` entries to make ordering intent explicit

When creating links, add context:

- include `--message` explaining why relationship exists.

## 7) Required Evidence for Closure

A close action should include:

- clear close reason text
- at least one verification artifact:
  - test command result summary
  - linked file path(s)
  - linked docs or notes
- updated acceptance criteria status (met/not met)

## 8) Common Command Recipes

Quick start loop:

```bash
pm config project set definition-of-done --criterion "tests pass" --criterion "linked files/tests/docs present"
pm config project set test-result-tracking --policy enabled
pm list-open --type Task --priority 0 --fields id,title,parent,type --sort priority --order asc --limit 5
pm claim pm-a1b2
pm update pm-a1b2 --status in_progress --description "Implement restore replay"
pm update pm-a1b2 --description "Audit metadata clarification" --allow-audit-update --author "audit-maintainer"
pm update-many --filter-status open --filter-tag governance --status in_progress --dry-run --json
pm update-many --filter-tag wave:7 --replace-tests --test "command=node scripts/run-tests.mjs test -- tests/core/history.spec.ts,scope=project,timeout_seconds=240" --message "Normalize linked tests"
pm normalize --filter-status in_progress --dry-run --json
pm normalize --filter-tag governance --apply --allow-audit-update --author audit-maintainer --message "Normalize lifecycle metadata"
pm update pm-a1b2 --body "Restore replay scope and acceptance details."
pm update pm-a1b2 --reminder "at=+1d,text=Follow up on restore replay tests"
pm files pm-a1b2 --add path=src/history.ts,scope=project,note="restore implementation"
pm files pm-a1b2 --add-glob "src/**/*.ts"
pm test pm-a1b2 --add command="node scripts/run-tests.mjs test",scope=project,timeout_seconds=240
pm comments pm-a1b2 "Restore replay implemented with hash checks"
pm notes pm-a1b2 --add "Replay path now guards missing history streams before write"
pm learnings pm-a1b2 --add "Use sandbox runner for linked test commands to preserve PM_PATH safety"
pm deps pm-a1b2 --format tree
pm aggregate --group-by parent,type --status open --json
pm dedupe-audit --mode parent_scope --limit 20 --json
pm calendar --view week --date 2026-04-06 --full-period --include deadlines,events --format markdown
pm activity --id pm-a1b2 --op update --author codex-agent --from -7d --to now --limit 100
pm activity --json --stream rows --limit 200
pm start-task pm-a1b2 --author codex-agent --message "Start implementation"
pm pause-task pm-a1b2 --author codex-agent --message "Pause for dependency unblock"
pm close-task pm-a1b2 "All acceptance criteria met" --author codex-agent --message "Close and handoff"
pm contracts --command update --flags-only --json
pm test pm-a1b2 --run --progress
pm health --check-only
pm validate --check-resolution --check-history-drift
node scripts/run-tests.mjs coverage
pm close pm-a1b2 "history replay tests passed; restore emits restore history event" --validate-close warn --author "..." --message "Close: history replay tests passed; restore emits restore history event"
pm release pm-a1b2
```

Templates syntax reminder:

- `pm templates save` and `pm templates show` use positional template names.
- Use `pm templates save <name> ...` and `pm templates show <name>`.
- Do not pass `--name`; it is not a supported flag.

Investigate change timeline:

```bash
pm history pm-a1b2 --limit 20
pm activity --limit 50
```

Recover previous state:

```bash
pm restore pm-a1b2 2026-02-17T11:15:03.120Z
```

## 9) Pi Tool Wrapper Usage

The built-in Pi wrapper exposes one tool: `pm`.
Reference implementation source lives at `.pi/extensions/pm-cli/index.ts` as a Pi agent extension module.
`pm install` has been removed; install bundled managed runtime extensions via `pm extension --install beads|todos` (or explicit `.agents/pm/extensions/<name>` paths) when needed.
Load the Pi wrapper in Pi with `pi -e ./.pi/extensions/pm-cli/index.ts` (or copy it into your Pi extensions directory).
Use `action: "completion"` with `shell: "bash"|"zsh"|"fish"` to forward to `pm completion <shell>`.
Use `action: "calendar"` for date-centric event views (`view`, `date`, `from`, `to`, `past`, `fullPeriod`, `type`, `tag`, `priority`, `status`, `assignee`, `sprint`, `release`, `limit`, `format`).
Use `action: "aggregate"` for grouped decomposition checks (`groupBy`, `count`, `includeUnparented`, list-style filters).
Use `action: "dedupe-audit"` for duplicate corpus checks (`mode`, `threshold`, `limit`, list-style filters).
Use `action: "normalize"` for lifecycle metadata hygiene scans (`dryRun`) and explicit apply mode (`apply`) with list-style filter targeting.
Use `action: "validate"` with optional check toggles (`checkMetadata`, `checkResolution`, `checkFiles`, `checkHistoryDrift`) and optional `scanMode` (`default|tracked-all`) for standalone audit workflows.
Use `action: "extension-doctor"` for consolidated extension diagnostics with optional `scope` and `detail` (`summary|deep`).
For `list*` wrapper actions, use projection/sort controls (`compact`, `fields`, `sort`, `order`) plus `includeBody` when body projection is needed.
For `comments-audit`, use governance filters (`parent`, `tag`, `sprint`, `release`, `priority`) in addition to status/type/assignee filters.
For `health`, use vector refresh controls (`checkOnly`, `noRefresh`, `refreshVectors`) while keeping strict flags available (`strictDirectories`, `strictExit`, `failOnWarn`).
For `create` and `update`, use camelCase wrapper parameters for the canonical CLI scalar fields such as `parent`, `reviewer`, `risk`, `confidence`, `sprint`, `release`, `blockedBy`, `blockedReason`, `unblockNote`, `definitionOfReady`, `order`, `goal`, `objective`, `value`, `impact`, `outcome`, `whyNow`, `reporter`, `severity`, `environment`, `reproSteps`, `resolution`, `expectedResult`, `actualResult`, `affectedVersion`, `fixedVersion`, `component`, `regression`, and `customerImpact`; use `createMode` (`strict|progressive`) when staged creation is needed, `appendStable` for minimal-diff file-link appends, `allowAuditUpdate` for ownership-safe metadata-only non-owner updates, `allowAuditDepUpdate` for ownership-safe dependency-only non-owner updates, `allowAuditComment` for additive non-owner comment writes, repeatable `reminder` values for persistent reminders (`at=<iso|relative>,text=<text>`), and repeatable `typeOption` values for custom type metadata.
For `contracts`, use projection controls (`flagsOnly`, `availabilityOnly`) when you need narrow machine-readable payloads; with `command` selected, contract output is command-scoped by default.
For `completion`, use `eagerTags` only when embedding static tags in generated scripts is required; default generated scripts resolve tags lazily at runtime.
For `activity`, use `id`, `op`, `author`, `from`, `to`, `limit`, and `stream` (`rows|ndjson|jsonl` or boolean true) for deterministic timeline filtering/export.
For `test` and `test-all`, prefer explicit runtime parity/strictness parameters when needed: `pmContext` (`schema|tracker|auto`), `checkContext`, `autoPmContext`, `failOnContextMismatch`, `failOnSkipped`, and `requireAssertionsForPm`.
For `gc`, use `dryRun` and repeatable `gcScope` (`index`, `embeddings`, `runtime`) for no-side-effect previews and targeted cleanup.

### Example: list open tasks

```json
{
  "action": "list-open",
  "limit": 10
}
```

### Example: create item

```json
{
  "action": "create",
  "title": "Implement extension loader",
  "description": "Load global and project extensions with precedence.",
  "type": "Feature",
  "status": "open",
  "priority": 1,
  "tags": "extensions,core",
  "body": "",
  "deadline": "+14d",
  "estimate": 120,
  "acceptanceCriteria": "Loader applies deterministic precedence for core global and project extensions.",
  "author": "maintainer-agent",
  "message": "Create extension loader task",
  "assignee": "maintainer-agent",
  "parent": "pm-epic01",
  "reviewer": "maintainer-reviewer",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop",
  "release": "v0.1",
  "blockedBy": "pm-arch-review",
  "blockedReason": "Awaiting architecture sign-off",
  "unblockNote": "Resume implementation once review notes are resolved",
  "reporter": "maintainer-agent",
  "severity": "medium",
  "environment": "cli",
  "reproSteps": "Create conflicting extension registrations across project/global scopes",
  "resolution": "Apply deterministic precedence in extension loader bootstrap",
  "expectedResult": "Loader applies project-over-global precedence deterministically",
  "actualResult": "Registration order currently varies by load path",
  "affectedVersion": "v0.1",
  "fixedVersion": "v0.2",
  "component": "extension-host",
  "regression": "false",
  "customerImpact": "Unpredictable extension behavior increases operator overhead",
  "definitionOfReady": "Extension loading behavior is clarified in docs.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Ship deterministic extension loading",
  "value": "Makes extension behavior predictable for agents and humans",
  "impact": "Reduces configuration and precedence drift",
  "outcome": "Extension loader applies deterministic precedence",
  "whyNow": "Extension loading is foundational for the remaining roadmap",
  "dep": ["id=pm-epic01,kind=parent,author=maintainer-agent,created_at=now"],
  "comment": ["author=maintainer-agent,created_at=now,text=Why this task exists align extension load precedence behavior."],
  "note": ["author=maintainer-agent,created_at=now,text=Initial implementation plan wire loader in runtime bootstrap."],
  "learning": [],
  "linkedFile": ["path=src/core/extensions/loader.ts,scope=project,note=planned implementation file"],
  "linkedTest": ["command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240,note=sandbox-safe regression"],
  "doc": ["path=docs/ARCHITECTURE.md,scope=project,note=implementation reference"]
}
```

### Example: append body update

```json
{
  "action": "append",
  "id": "pm-a1b2",
  "body": "Implemented lock TTL and stale lock override."
}
```

Expected wrapper return shape:

```json
{
  "content": [
    { "type": "text", "text": "..." }
  ],
  "details": {
    "action": "create",
    "item": {}
  }
}
```

## 10) Multi-Agent Etiquette

- Claim before heavy edits.
- Release when blocked or context-switching.
- Use comments for handoff notes.
- Avoid silent force-claim unless policy allows and conflict is stale.
- Keep item descriptions stable; append details in body/notes/comments.

## 11) Troubleshooting for Agents

Lock conflict:

- inspect ownership and lock age
- retry later or use `--force` with explicit rationale

Not found:

- normalize ID and verify with `pm list-all --limit ...`

Search mismatch:

- run `pm reindex`
- check provider/vector store config with `pm health`

Extension issues:

- run with `--no-extensions` to isolate core behavior
- inspect `pm health` extension checks
- verify active extension selectors in settings (`search.provider`, `vector_store.adapter`) when semantic search/reindex behavior differs from baseline
- verify manifest capability declarations include any new API usage (`parser`, `preflight`, `services`) to avoid activation failures
- when debugging runtime behavior changes, inspect parser/preflight/service override collisions in health/profile diagnostics (last registration wins)
- use SDK contracts from `@unbrained/pm-cli/sdk` (not internal `src/core/...` imports) for extension authoring and examples

## 12) Dogfood Logging Protocol (Required)

From now on in this repository, all implementation work must be tracked through `pm` items and `pm` mutations.

Rules:

- Every code change must be linked to at least one `pm` item.
- For every change-set/commit-sized unit of work, agents must:
  - create or update relevant `pm` item(s)
  - link changed files via `pm files`
  - link verification via `pm test`/`pm docs` as applicable
  - add a comment with evidence (what changed, why, what was verified)
  - ensure history is written through `pm` mutation commands (never by editing `.agents/pm` files directly)
- Until full command coverage exists, prioritize implementing the minimal missing subset needed for logging:
  - `append`
  - `comments`
  - `notes`
  - `learnings`
  - `files`
  - `test`
  - `test-all`
  - `docs`
  - `update`
  - `claim`
  - `release`

### All-Flags Create Template (copy/paste)

`pm create` strict mode (default / `--create-mode strict`) enforces every repeatable seed flag as concrete input; pass concrete values for each of `--dep`, `--comment`, `--note`, `--learning`, `--file`, `--test`, and `--doc`. If a repeatable field is intentionally empty during staged capture, use `--create-mode progressive` and backfill required metadata before close.

```bash
pm create \
  --title "..." \
  --description "..." \
  --type Task \
  --status open \
  --priority 1 \
  --tags "pm-cli,milestone:0,area:core,core" \
  --body "..." \
  --deadline +1d \
  --estimate 60 \
  --acceptance-criteria/--ac "..." \
  --unset definition-of-ready \
  --unset order \
  --unset goal \
  --unset objective \
  --unset value \
  --unset impact \
  --unset outcome \
  --unset why-now \
  --author "..." \
  --message "..." \
  --unset assignee \
  --unset parent \
  --unset reviewer \
  --unset risk \
  --unset confidence \
  --unset sprint \
  --unset release \
  --unset blocked-by \
  --unset blocked-reason \
  --unset unblock-note \
  --unset reporter \
  --unset severity \
  --unset environment \
  --unset repro-steps \
  --unset resolution \
  --unset expected-result \
  --unset actual-result \
  --unset affected-version \
  --unset fixed-version \
  --unset component \
  --unset regression \
  --unset customer-impact \
  --dep <DEP> \
  --comment <COMMENT> \
  --note <NOTE> \
  --learning <LEARNINGS> \
  --file <FILES> \
  --test <TESTS> \
  --doc <DOCS>
```

Notes:

- `--type` values come from the runtime type registry (built-ins plus `settings.item_types.definitions` and extension registrations).
- Custom type metadata can be passed with repeatable `--type-option key=value` flags (or `--clear-type-options` to explicitly clear).
- For staged governance capture without placeholder repeatables, use `--create-mode progressive` and backfill required metadata before close.

### Epic Template With Comment + Note

```bash
pm create \
  --title "Milestone X - ..." \
  --description "..." \
  --type Epic \
  --status open \
  --priority 0 \
  --tags "pm-cli,milestone:X,area:...,core" \
  --body "..." \
  --deadline +7d \
  --estimate 240 \
  --acceptance-criteria/--ac "..." \
  --unset definition-of-ready \
  --unset order \
  --unset goal \
  --unset objective \
  --unset value \
  --unset impact \
  --unset outcome \
  --unset why-now \
  --author "..." \
  --message "MESSAGE" \
  --unset assignee \
  --unset parent \
  --unset reviewer \
  --unset risk \
  --unset confidence \
  --unset sprint \
  --unset release \
  --unset blocked-by \
  --unset blocked-reason \
  --unset unblock-note \
  --dep "id=pm-xxxx,kind=blocks,author=...,created_at=now" \
  --comment "author=...,created_at=now,text=Why this epic exists." \
  --note "author=...,created_at=now,text=How success is measured." \
  --learning <LEARNINGS> \
  --file <FILES> \
  --test <TESTS> \
  --doc <DOCS>
```
