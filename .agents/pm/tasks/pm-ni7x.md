{
  "id": "pm-ni7x",
  "title": "Pi wrapper numeric scalar flag parity",
  "description": "Allow Pi wrapper numeric JSON inputs for numeric CLI flags without requiring string coercion at caller side.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-pi",
    "code",
    "doc",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T23:13:22.240Z",
  "updated_at": "2026-03-05T09:33:50.283Z",
  "deadline": "2026-03-05T23:13:22.240Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 60,
  "acceptance_criteria": "Pi wrapper accepts numeric JSON values for priority/estimate/limit/timeout while preserving string compatibility. Docs mention this behavior and targeted unit coverage plus regression suite pass at 100 percent coverage.",
  "dependencies": [
    {
      "id": "pm-igv",
      "kind": "related",
      "created_at": "2026-03-04T23:13:22.240Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T23:13:22.240Z",
      "author": "cursor-maintainer",
      "text": "Why this exists: Pi tool callers often emit JSON numbers for numeric flags and wrapper should accept that deterministically."
    },
    {
      "created_at": "2026-03-04T23:13:33.716Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update README and PRD to document numeric scalar parity for Pi wrapper numeric flags; then update wrapper schema and arg builder to accept number|string values and add targeted unit coverage."
    },
    {
      "created_at": "2026-03-04T23:14:01.737Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update complete: README and PRD now document Pi wrapper numeric scalar parity for priority estimate limit and timeout before implementation changes."
    },
    {
      "created_at": "2026-03-04T23:14:58.950Z",
      "author": "cursor-maintainer",
      "text": "Implemented code changes: docs/pi/extensions/pm/index.ts now accepts number|string for priority estimate limit and timeout, schema exposes anyOf string or number for those fields, and pushOption stringifies finite numeric inputs deterministically while ignoring non-finite values."
    },
    {
      "created_at": "2026-03-04T23:14:59.122Z",
      "author": "cursor-maintainer",
      "text": "Added regression coverage in tests/unit/pi-agent-extension.spec.ts for numeric scalar mapping across create list-open and test-all paths plus schema anyOf checks for numeric-capable fields."
    },
    {
      "created_at": "2026-03-04T23:23:57.405Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-ni7x --run --timeout 7200 --json passed linked tests 2/2 with zero failures. pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=63 linked_tests=200 passed=57 failed=0 skipped=143. Coverage proof from sandboxed coverage runs remained 100 percent lines branches functions and statements (All files 100 100 100 100). Follow-up items created: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T23:13:22.240Z",
      "author": "cursor-maintainer",
      "text": "Plan: docs-first update in README and PRD then wrapper schema and helper update plus unit tests."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi wrapper project-scoped module path"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first parity update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first parity update"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "unit coverage updates"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted unit parity coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Pi wrapper contract update"
    }
  ]
}

Context: docs/pi/extensions/pm/index.ts currently types several numeric CLI flags as string-only in tool schema. Approach: docs-first contract note then accept number|string and stringify deterministically when building CLI args.
