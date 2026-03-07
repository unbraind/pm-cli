{
  "id": "pm-8fvl",
  "title": "Harden recursive test-all detection for npx package specs",
  "description": "Reject linked test commands that invoke pm test-all via npx package-spec forms like pm-cli@latest.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:test-command",
    "code",
    "milestone:3",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-05T00:01:19.931Z",
  "updated_at": "2026-03-05T00:16:36.548Z",
  "deadline": "2026-03-06T00:01:19.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 75,
  "acceptance_criteria": "pm test --add rejects recursive test-all invocations launched through npx package specs such as pm-cli@latest; unit tests cover detection paths; sandboxed regression and coverage remain at 100 percent.",
  "dependencies": [
    {
      "id": "pm-k3zx",
      "kind": "related",
      "created_at": "2026-03-05T00:01:19.931Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T00:01:19.931Z",
      "author": "cursor-maintainer",
      "text": "Docs require recursive pm test-all entries to be rejected and package-spec launchers currently bypass validation."
    },
    {
      "created_at": "2026-03-05T00:01:31.917Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: update PRD/README wording to explicitly include npx package-spec recursive forms, then harden src/cli/commands/test.ts detection and add unit regression coverage."
    },
    {
      "created_at": "2026-03-05T00:02:54.435Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update completed: PRD README and AGENTS now explicitly include package-spec launcher forms (for example npx pm-cli@latest --json test-all) in recursive test-all reject/skip requirements."
    },
    {
      "created_at": "2026-03-05T00:03:35.199Z",
      "author": "cursor-maintainer",
      "text": "Implemented parser hardening in src/cli/commands/test.ts by normalizing package specifiers before pm-cli launcher matching; added unit regressions for npx pm-cli@latest and npx pm-cli@0.1.0 add-time rejection plus runtime skip coverage."
    },
    {
      "created_at": "2026-03-05T00:05:16.901Z",
      "author": "cursor-maintainer",
      "text": "Follow-up fix after initial coverage run: removed unreachable empty-specifier branch in normalizePackageSpecifier and added scoped package regression cases (npx @scope/pm-cli@latest recursive reject plus npx @scope non-pm passthrough) to restore 100% coverage."
    },
    {
      "created_at": "2026-03-05T00:06:21.258Z",
      "author": "cursor-maintainer",
      "text": "Coverage follow-up: added npx @scope/pm-cli recursive rejection case to exercise scoped package branch without explicit version suffix so branch coverage remains at 100 percent."
    },
    {
      "created_at": "2026-03-05T00:16:32.203Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-8fvl --run --timeout 2400 --json passed 2/2 linked tests (coverage + targeted test-command suite). pm test-all --status in_progress --timeout 2400 --json totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 2400 --json totals items=64 linked_tests=202 passed=57 failed=0 skipped=145. Coverage gate output reports 100% statements/branches/functions/lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T00:01:19.931Z",
      "author": "cursor-maintainer",
      "text": "Plan docs-first clarification then parser hardening in src/cli/commands/test.ts plus targeted unit regressions."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent rule alignment for recursive launcher forms"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first recursive launcher contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first recursive launcher contract update"
    },
    {
      "path": "src/cli/commands/test.ts",
      "scope": "project",
      "note": "recursive invocation detection logic"
    },
    {
      "path": "tests/unit/test-command.spec.ts",
      "scope": "project",
      "note": "coverage for npx package-spec recursion variants"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/test-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted recursion guard regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "authoritative agent workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative recursive command safety contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public test command behavior contract"
    }
  ]
}

Current validation catches pm test-all recursion for direct pm/node/npx forms but allows package-spec invocations such as npx pm-cli@latest --json test-all. This task hardens parser coverage and keeps runtime skip logic aligned with docs.
