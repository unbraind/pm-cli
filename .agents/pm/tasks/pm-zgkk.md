{
  "id": "pm-zgkk",
  "title": "M4: Mutation-triggered search cache invalidation",
  "description": "Invalidate deterministic search cache artifacts after item mutations so stale index/search artifacts are never treated as current between reindex runs.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search-indexing",
    "code",
    "milestone:4",
    "pm-cli",
    "priority:1"
  ],
  "created_at": "2026-03-03T22:38:40.837Z",
  "updated_at": "2026-03-03T22:57:30.315Z",
  "deadline": "2026-03-10T23:59:00.000Z",
  "author": "cursor-maintainer-agent",
  "estimated_minutes": 150,
  "acceptance_criteria": "After successful mutating commands stale search cache artifacts are invalidated deterministically as best effort and non-fatal docs reflect behavior and regression coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-cwp",
      "kind": "related",
      "created_at": "2026-03-03T22:38:40.837Z",
      "author": "cursor-maintainer-agent"
    },
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-03-03T22:38:40.837Z",
      "author": "cursor-maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-03T22:38:40.837Z",
      "author": "cursor-maintainer-agent",
      "text": "Gap discovered during docs and implementation audit because reindex artifacts can become stale after mutations."
    },
    {
      "created_at": "2026-03-03T22:38:57.674Z",
      "author": "cursor-maintainer-agent",
      "text": "Planned changeset: docs-first define mutation-triggered search cache invalidation baseline then add shared post-mutation invalidation helper and wire it into mutating command paths with deterministic non-fatal behavior."
    },
    {
      "created_at": "2026-03-03T22:44:28.774Z",
      "author": "cursor-maintainer-agent",
      "text": "Implemented docs-first baseline update in PRD and README then wired post-mutation search cache invalidation in CLI mutating command paths and added unit plus integration regression coverage."
    },
    {
      "created_at": "2026-03-03T22:46:10.638Z",
      "author": "cursor-maintainer-agent",
      "text": "Follow-up fix: added src/core/search/cache.ts to vitest coverage include list to preserve release-readiness coverage-contract parity after introducing the new helper module."
    },
    {
      "created_at": "2026-03-03T22:47:23.327Z",
      "author": "cursor-maintainer-agent",
      "text": "Follow-up fix: removed branchy warning formatting in src/core/search/cache.ts by normalizing warning reason via String(error) to preserve 100% global branch coverage."
    },
    {
      "created_at": "2026-03-03T22:57:18.614Z",
      "author": "cursor-maintainer-agent",
      "text": "Evidence: pnpm build passed. Mandatory run passed: node dist/cli.js test pm-zgkk --run --timeout 7200 --json with linked results passed=4 failed=0 skipped=0. Regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 7200 --json => totals items=8 linked_tests=34 passed=15 failed=0 skipped=19; node dist/cli.js test-all --status closed --timeout 7200 --json => totals items=34 linked_tests=119 passed=49 failed=0 skipped=70. Coverage proof: sandboxed coverage run reports All files 100% lines branches functions and statements. Follow-up items created: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-03T22:38:40.837Z",
      "author": "cursor-maintainer-agent",
      "text": "Plan is docs-first invalidation baseline then post-mutation invalidation helper then unit and integration coverage."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-03T22:38:40.837Z",
      "author": "cursor-maintainer-agent",
      "text": "Search freshness improves incrementally via deterministic invalidation before full mutation-triggered embedding refresh."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first mutation cache invalidation baseline"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first search freshness baseline update"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "wire mutation success invalidation across command actions"
    },
    {
      "path": "src/core/search",
      "scope": "project",
      "note": "planned invalidation helper location"
    },
    {
      "path": "src/core/search/cache.ts",
      "scope": "project",
      "note": "new helper to invalidate search cache artifacts"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "regression for post-mutation cache invalidation"
    },
    {
      "path": "tests/unit/search-cache.spec.ts",
      "scope": "project",
      "note": "unit coverage for cache invalidation helper"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include alignment for new search cache helper"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "coverage gate regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "mutation invalidation integration regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-cache.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted cache invalidation unit regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "search helper regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow and test-safety contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing search behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing search freshness contract"
    }
  ]
}

Implement a deterministic post-mutation invalidation step that removes stale index/manifest.json and search/embeddings.jsonl artifacts after successful writes with failure containment and docs/tests parity.
