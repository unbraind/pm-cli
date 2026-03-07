{
  "id": "pm-q35x",
  "title": "Harden include-linked path containment",
  "description": "Prevent search include-linked corpus reads from traversing outside project/global scope roots.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search",
    "area:security",
    "code",
    "docs",
    "milestone:4",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T20:55:49.857Z",
  "updated_at": "2026-03-04T21:08:06.352Z",
  "deadline": "2026-03-05T20:55:49.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "search --include-linked ignores linked file/doc/test paths that resolve outside their allowed project/global roots; traversal-style paths do not influence scoring; docs and tests are updated; coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-cwp",
      "kind": "related",
      "created_at": "2026-03-04T20:55:49.857Z",
      "author": "maintainer-agent"
    },
    {
      "id": "pm-j7a",
      "kind": "parent",
      "created_at": "2026-03-04T20:55:49.857Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T20:55:49.857Z",
      "author": "maintainer-agent",
      "text": "Security hardening follow-up for include-linked baseline with scope root containment checks"
    },
    {
      "created_at": "2026-03-04T20:56:03.040Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD and README first to document that include-linked only reads files inside project/global roots and skips out-of-scope paths, then implement root containment in search linked corpus loading and add regression tests for traversal-style linked paths."
    },
    {
      "created_at": "2026-03-04T20:56:51.958Z",
      "author": "maintainer-agent",
      "text": "Docs-first update completed: PRD and README now explicitly require include-linked linked-content reads to stay inside project/global scope roots and skip out-of-scope paths deterministically."
    },
    {
      "created_at": "2026-03-04T20:57:43.564Z",
      "author": "maintainer-agent",
      "text": "Implemented change-set: search linked-corpus loading now enforces scope-root containment before read-hook dispatch and file reads, so include-linked ignores paths that resolve outside project/global roots; added unit regression covering traversal-style project/global linked paths to ensure they are skipped and do not influence scoring."
    },
    {
      "created_at": "2026-03-04T21:07:34.998Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-q35x --run --timeout 7200 --json passed after one coverage-fix iteration (search.ts line-coverage branch for root-equal linked path); run_results now passed=2 failed=0 skipped=0. Regression sweeps: pm test-all --status in_progress --timeout 7200 --json totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json totals items=59 linked_tests=190 passed=57 failed=0 skipped=133. Coverage statement: node scripts/run-tests.mjs coverage reports All files 100% statements/branches/functions/lines."
    },
    {
      "created_at": "2026-03-04T21:08:06.352Z",
      "author": "maintainer-agent",
      "text": "Post-close environment check: refreshed global install from current repo state with npm install -g . and verified pm --version outputs 0.1.0."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T20:55:49.857Z",
      "author": "maintainer-agent",
      "text": "Docs first update PRD and README then enforce containment in search linked corpus loader"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first security behavior update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first include-linked hardening note"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "contain linked reads to allowed roots"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "regression coverage for traversal containment"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "targeted include-linked containment unit coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user contract"
    }
  ]
}

Context: PRD security section requires path input validation; include-linked currently resolves linked paths without explicit scope-root containment checks. Approach: docs-first clarify containment behavior, then enforce root-bounded linked reads for project/global scope and add regression tests.
