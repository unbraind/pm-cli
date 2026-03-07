{
  "id": "pm-vdh",
  "title": "M0: Deterministic serializer utilities",
  "description": "Implement and validate deterministic serialization helpers used by hashing/history paths.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:determinism",
    "core",
    "milestone:0",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:06.839Z",
  "updated_at": "2026-02-19T01:28:01.998Z",
  "deadline": "2026-02-20T23:02:06.839Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Serialization helpers produce stable deterministic bytes across supported JSON-like inputs and edge cases are covered by automated tests.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:06.839Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-19T00:16:29.256Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: harden deterministic serialization utilities for JSON-like and edge-case inputs, add explicit unit coverage for sorting/undefined-skipping/fallback coercion behavior, and include the core serializer utility in enforced coverage scope."
    },
    {
      "created_at": "2026-02-19T00:17:34.181Z",
      "author": "maintainer-agent",
      "text": "Implemented serializer hardening: stableStringify now canonicalizes Date values and respects object toJSON outputs when they differ from the original object, while preserving deterministic sorted-key behavior for plain objects and undefined-field omission."
    },
    {
      "created_at": "2026-02-19T00:39:25.049Z",
      "author": "maintainer-agent",
      "text": "Follow-up changeset: replaced generic fallback stringification in stableStringify with explicit bigint/undefined/symbol/function handling plus deterministic terminal fallback token to satisfy lint quality constraints without changing canonical object ordering."
    },
    {
      "created_at": "2026-02-19T00:41:12.844Z",
      "author": "maintainer-agent",
      "text": "Coverage follow-up fix: refactored serializer type-branch flow to eliminate an unreachable terminal fallback line while retaining deterministic handling for bigint/undefined/symbol/function/Date/toJSON/object values."
    },
    {
      "created_at": "2026-02-19T00:41:45.626Z",
      "author": "maintainer-agent",
      "text": "Type-safety correction: switched serializer branch guards back to direct typeof checks so TypeScript can narrow unknown values correctly without reintroducing non-deterministic fallback behavior."
    },
    {
      "created_at": "2026-02-19T00:42:51.606Z",
      "author": "maintainer-agent",
      "text": "Added serializer unit assertion for anonymous function fallback to close remaining branch-coverage gap in core/shared/serialization.ts."
    },
    {
      "created_at": "2026-02-19T01:06:56.887Z",
      "author": "maintainer-agent",
      "text": "Lint follow-up: replaced typeof-undefined check with direct undefined comparison and moved namedFallback helper to test-module scope to satisfy static quality warnings without behavior changes."
    },
    {
      "created_at": "2026-02-19T01:28:01.655Z",
      "author": "maintainer-agent",
      "text": "Evidence: node dist/cli.js test pm-vdh --run --timeout 1800 --json passed all linked checks (coverage + targeted determinism tests + build). Coverage gate remains 100% lines/branches/functions/statements, including src/core/shared/serialization.ts. Regression sweeps passed with no failures: node dist/cli.js test-all --status in_progress --timeout 1800 --json => items=5 linked_tests=23 passed=22 failed=0 skipped=1; node dist/cli.js test-all --status closed --timeout 1800 --json => items=13 linked_tests=34 passed=31 failed=0 skipped=3."
    }
  ],
  "files": [
    {
      "path": "src/core/shared/serialization.ts",
      "scope": "project",
      "note": "deterministic serializer implementation"
    },
    {
      "path": "tests/unit/determinism.spec.ts",
      "scope": "project",
      "note": "existing determinism regression coverage"
    },
    {
      "path": "tests/unit/serialization-utils.spec.ts",
      "scope": "project",
      "note": "new edge-case serializer tests"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include for deterministic serializer utility"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "coverage gate in sandbox"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/determinism.spec.ts tests/unit/serialization-utils.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "targeted serializer determinism tests"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "compile validation"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing contract"
    }
  ]
}

Build reusable deterministic serialization and hashing utilities.
