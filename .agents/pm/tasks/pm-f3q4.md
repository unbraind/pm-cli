{
  "id": "pm-f3q4",
  "title": "M5 follow-up: dispatch onWrite hooks for create and restore",
  "description": "Ensure create and restore mutation paths emit onWrite hooks for item/history writes and surface hook warnings deterministically.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:create",
    "area:extensions-hooks",
    "area:restore",
    "code",
    "doc",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-05T15:33:46.422Z",
  "updated_at": "2026-03-05T15:46:20.465Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Create and restore emit onWrite hook events for item and history writes; README and PRD reflect call-site coverage; tests cover hook dispatch and warnings; coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-p8p",
      "kind": "related",
      "created_at": "2026-03-05T15:33:46.422Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T15:33:46.422Z",
      "author": "maintainer-agent",
      "text": "Follow-up to hook lifecycle: add missing onWrite dispatch for create/restore write paths."
    },
    {
      "created_at": "2026-03-05T15:34:12.876Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first update hook lifecycle call-site coverage in PRD/README, then add onWrite hook dispatch (item + history paths) in create/restore command paths and extend unit coverage for warning propagation and dispatch counts."
    },
    {
      "created_at": "2026-03-05T15:34:40.851Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD.md and README.md now include create/restore item-history write paths in implemented hook lifecycle call-site coverage before command-path code changes."
    },
    {
      "created_at": "2026-03-05T15:36:15.576Z",
      "author": "maintainer-agent",
      "text": "Implemented code changes: create and restore command paths now dispatch onWrite hooks for both item files and history streams, and surface aggregated hook warnings in command results."
    },
    {
      "created_at": "2026-03-05T15:45:37.215Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-f3q4 --run --timeout 2400 --json passed (linked_tests=2, passed=2, failed=0, skipped=0). pm test-all --status in_progress --timeout 2400 --json passed (items=1, linked_tests=2, passed=2, failed=0, skipped=0). pm test-all --status closed --timeout 2400 --json passed (items=74, linked_tests=226, passed=60, failed=0, skipped=166). Coverage proof from sandboxed coverage runs remained 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-03-05T15:46:20.465Z",
      "author": "maintainer-agent",
      "text": "Post-close release-readiness check: rebuilt project and refreshed global install from current repo state (pnpm build && npm install -g /home/steve/GITHUB_RELEASE/pm-cli), then verified pm --version=0.1.0."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T15:33:46.422Z",
      "author": "maintainer-agent",
      "text": "Implement docs-first then update command code and targeted unit coverage."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "create onWrite dispatch"
    },
    {
      "path": "src/cli/commands/restore.ts",
      "scope": "project",
      "note": "restore onWrite dispatch"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "create hook regression coverage"
    },
    {
      "path": "tests/unit/restore-command.spec.ts",
      "scope": "project",
      "note": "restore hook regression coverage"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts tests/unit/restore-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted create restore hook tests"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "hook lifecycle call-site coverage"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior contract"
    }
  ]
}

Extend hook call-site coverage so create/restore mutation writes are observable by extensions.
