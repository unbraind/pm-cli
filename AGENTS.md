# AGENTS.md - Operating Rules for `pm`

This document defines how coding agents must use `pm` for planning, execution, and reporting in this repository.

## 1) Core Rules

- Use `pm` as the system of record for project work.
- Prefer deterministic, script-friendly command usage (`--json` when strict parsing is needed).
- Default to TOON output when human + model readability and low token use are desired.
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
- For real repository tracking, do not override `PM_PATH`.
- For tests only, always use sandboxed `PM_PATH` and `PM_GLOBAL_PATH` (or `node scripts/run-tests.mjs ...`).

## 2) Canonical Agent Workflow

### Step A - Pick next work

Use one of:

- `pm list-in-progress --limit 20`
- `pm list-open --limit 20`
- `pm list-blocked --limit 20`

Then filter:

- by type: `--type Task|Feature|Issue|Chore|Epic`
- by priority: `--priority 0..4`
- by tag: `--tag <name>`

### Step B - Claim ownership

- `pm claim <ID>`
- If conflict and explicitly approved: `pm claim <ID> --force`

Rules:

- Do not work unclaimed unless the task is intentionally collaborative.
- If switching context, release previous claim.

### Step C - Clarify task intent

Populate metadata early:

- `pm update <ID> --description "..."`
- `pm update <ID> --acceptance-criteria/--ac "..."`
- `pm update <ID> --estimate <minutes>`
- `pm update <ID> --deadline +1d` (resolved to ISO at write)
- when team-level close-readiness policy changes, update Definition of Done criteria via:
  - `pm config project set definition-of-done --criterion "tests pass" --criterion "linked files/tests/docs present"`

### Step D - Link execution context

Attach references to keep work reproducible:

- Files:
  - `pm files <ID> --add path=src/app.ts,scope=project,note="entrypoint"`
- Tests:
  - `pm test <ID> --add command="node scripts/run-tests.mjs test",scope=project,timeout_seconds=240`
  - `pm test <ID> --add path=tests/history.spec.ts,scope=project`
- Docs:
  - `pm docs <ID> --add path=docs/ARCHITECTURE.md,scope=project`

### Step E - Record progress

Use append-style updates:

- `pm comments <ID> --add "Implemented lock retry path"`
- `pm update <ID> --status in_progress`
- `pm append <ID> --body "Detailed implementation notes..."`

Capture durable notes:

- `pm update <ID> --message "Add design rationale"` with note additions
- Add learnings at the end of significant discoveries.

### Step F - Validate and close

Before close:

1. Run linked tests:
   - `pm test <ID> --run`
2. Run sandbox-safe coverage verification:
   - `node scripts/run-tests.mjs coverage`
3. Optionally run project sweep:
   - `pm test-all --status in_progress`
   - `pm test-all --status closed` (when running a broader release-readiness regression sweep)
   - Avoid linking `pm test-all` itself as an item-level linked test command, since that creates recursive orchestration.
4. Add closure evidence:
   - `pm comments <ID> --add "Evidence: tests X, Y passed; coverage remains 100%."`

Close (current v0.1 workflow):

- `pm close <ID> "<reason>" --author "..." --message "Close: <reason with evidence>"`

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
- `pm test <ID> --add` should only link sandbox-safe test-runner commands: use `node scripts/run-tests.mjs ...` or explicitly set both `PM_PATH` and `PM_GLOBAL_PATH`; sandbox-unsafe runner commands are rejected at add-time, including unsandboxed package-manager run-script variants (for example `npm run test`, `pnpm run test`, `yarn run test`, and `bun run test`) and chained direct test-runner segments that are not explicitly sandboxed.
- `pm test <ID> --run` should defensively skip legacy linked commands that invoke `pm test-all` (including global-flag and package-spec launcher forms such as `pm --json test-all`, `npx @unbrained/pm-cli@latest --json test-all`, `pnpm dlx @unbrained/pm-cli@latest --json test-all`, and `npm exec -- @unbrained/pm-cli@latest --json test-all`) and report deterministic skipped results.
- `pm test-all` deduplicates linked tests by scope+normalized command or scope+path and reports duplicates as skipped; when duplicate keys disagree on `timeout_seconds`, execution uses the deterministic maximum timeout for that key.
- Integration tests should invoke the built CLI (`node dist/cli.js ...`) with explicit `PM_PATH`, `PM_GLOBAL_PATH`, and `PM_AUTHOR`.
- Cleanup temporary test directories after each test/suite.

## 3.2 Community Files Baseline (Release Requirement)

- Keep these files present and current for release readiness:
  - `LICENSE` (MIT) at repository root
  - `CHANGELOG.md` using Keep a Changelog with `[Unreleased]`
  - `CONTRIBUTING.md` with local dev and test workflow
  - `SECURITY.md` with vulnerability reporting instructions
  - `CODE_OF_CONDUCT.md` contributor behavior policy

## 4) Token Minimization Rules (TOON-first)

- Prefer default TOON output for list/search/get in agent loops.
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
pm list-open --type Task --priority 0 --limit 5
pm claim pm-a1b2
pm update pm-a1b2 --status in_progress --description "Implement restore replay"
pm files pm-a1b2 --add path=src/history.ts,scope=project,note="restore implementation"
pm test pm-a1b2 --add command="node scripts/run-tests.mjs test",scope=project,timeout_seconds=240
pm comments pm-a1b2 --add "Restore replay implemented with hash checks"
pm test pm-a1b2 --run
node scripts/run-tests.mjs coverage
pm close pm-a1b2 "history replay tests passed; restore emits restore history event" --author "..." --message "Close: history replay tests passed; restore emits restore history event"
pm release pm-a1b2
```

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
Install the bundled Pi extension with `pm install pi --project` (default) or `pm install pi --global`.
Load it in Pi with `pi -e ./.pi/extensions/pm-cli/index.ts` (or copy to `.pi/extensions/`).
Use `action: "completion"` with `shell: "bash"|"zsh"|"fish"` to forward to `pm completion <shell>`.
For `create` and `update`, use camelCase wrapper parameters for the canonical CLI scalar fields such as `parent`, `reviewer`, `risk`, `confidence`, `sprint`, `release`, `blockedBy`, `blockedReason`, `unblockNote`, `definitionOfReady`, `order`, `goal`, `objective`, `value`, `impact`, `outcome`, `whyNow`, `reporter`, `severity`, `environment`, `reproSteps`, `resolution`, `expectedResult`, `actualResult`, `affectedVersion`, `fixedVersion`, `component`, `regression`, and `customerImpact`.

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
  "deadline": "none",
  "estimate": 120,
  "acceptanceCriteria": "Loader applies deterministic precedence for core global and project extensions.",
  "author": "maintainer-agent",
  "message": "Create extension loader task",
  "assignee": "none",
  "parent": "none",
  "reviewer": "none",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop",
  "release": "v0.1",
  "blockedBy": "none",
  "blockedReason": "none",
  "unblockNote": "none",
  "reporter": "none",
  "severity": "none",
  "environment": "none",
  "reproSteps": "none",
  "resolution": "none",
  "expectedResult": "none",
  "actualResult": "none",
  "affectedVersion": "none",
  "fixedVersion": "none",
  "component": "none",
  "regression": "none",
  "customerImpact": "none",
  "definitionOfReady": "Extension loading contract is clarified in docs.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Ship deterministic extension loading",
  "value": "Makes extension behavior predictable for agents and humans",
  "impact": "Reduces configuration and precedence drift",
  "outcome": "Extension loader applies deterministic precedence",
  "whyNow": "Extension loading is foundational for the remaining roadmap",
  "dep": ["none"],
  "comment": ["author=maintainer-agent,created_at=now,text=Why this task exists align extension load precedence behavior."],
  "note": ["author=maintainer-agent,created_at=now,text=Initial implementation plan wire loader in runtime bootstrap."],
  "learning": ["none"],
  "linkedFile": ["path=src/core/extensions/loader.ts,scope=project,note=planned implementation file"],
  "linkedTest": ["command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240,note=sandbox-safe regression"],
  "doc": ["path=PRD.md,scope=project,note=authoritative contract"]
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
  - `files`
  - `test`
  - `test-all`
  - `docs`
  - `update`
  - `claim`
  - `release`

### All-Flags Create Template (copy/paste)

`pm create` now enforces every repeatable seed flag as explicit input; pass a concrete value or `none` for each of `--dep`, `--comment`, `--note`, `--learning`, `--file`, `--test`, and `--doc`.

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
  --definition-of-ready/--definition_of_ready "none" \
  --order/--rank none \
  --goal none \
  --objective none \
  --value none \
  --impact none \
  --outcome none \
  --why-now/--why_now none \
  --author "..." \
  --message "..." \
  --assignee none \
  --parent none \
  --reviewer none \
  --risk none \
  --confidence none \
  --sprint none \
  --release none \
  --blocked-by none \
  --blocked-reason none \
  --unblock-note/--unblock_note none \
  --reporter none \
  --severity none \
  --environment none \
  --repro-steps none \
  --resolution none \
  --expected-result none \
  --actual-result none \
  --affected-version none \
  --fixed-version none \
  --component none \
  --regression none \
  --customer-impact none \
  --dep <DEP> \
  --comment <COMMENT> \
  --note <NOTE> \
  --learning <LEARNINGS> \
  --file <FILES> \
  --test <TESTS> \
  --doc <DOCS>
```

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
  --definition-of-ready/--definition_of_ready "none" \
  --order/--rank none \
  --goal none \
  --objective none \
  --value none \
  --impact none \
  --outcome none \
  --why-now/--why_now none \
  --author "..." \
  --message "MESSAGE" \
  --assignee none \
  --parent none \
  --reviewer none \
  --risk none \
  --confidence none \
  --sprint none \
  --release none \
  --blocked-by none \
  --blocked-reason none \
  --unblock-note/--unblock_note none \
  --dep "id=pm-xxxx,kind=blocks,author=...,created_at=now" \
  --comment "author=...,created_at=now,text=Why this epic exists." \
  --note "author=...,created_at=now,text=How success is measured." \
  --learning <LEARNINGS> \
  --file <FILES> \
  --test <TESTS> \
  --doc <DOCS>
```
