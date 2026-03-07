{
  "id": "pm-ip91",
  "title": "M4 roadmap: Advanced provider optimization",
  "description": "Optimize embedding provider execution by deduplicating normalized embedding inputs per request while preserving deterministic output cardinality/order.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:search",
    "milestone:4",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:18.346Z",
  "updated_at": "2026-03-07T17:50:54.794Z",
  "deadline": "2026-03-08T17:38:25.498Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Embedding request execution deduplicates repeated normalized inputs per provider call, preserves deterministic output order/cardinality, and is covered by sandbox-safe tests.",
  "comments": [
    {
      "created_at": "2026-03-07T17:38:25.667Z",
      "author": "maintainer-agent",
      "text": "Planned change: add deterministic per-request embedding input dedupe in provider execution path to reduce redundant upstream calls while preserving output order and cardinality."
    },
    {
      "created_at": "2026-03-07T17:50:54.444Z",
      "author": "maintainer-agent",
      "text": "Implemented deterministic per-request normalized embedding-input dedupe in provider request execution with fan-out back to original order/cardinality. Updated PRD.md and README.md to capture the new provider optimization contract, and added unit coverage for dedupe+fan-out behavior in embedding-provider tests. Evidence: pm test pm-ip91 --run --timeout 1800 passed; pm test-all --status in_progress --timeout 1800 passed (items=1 linked_tests=2); pm test-all --status closed --timeout 1800 passed (items=131 linked_tests=344 failed=0); coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "document provider dedupe behavior"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document provider dedupe behavior"
    },
    {
      "path": "src/core/search/providers.ts",
      "scope": "project",
      "note": "provider dedupe optimization implementation"
    },
    {
      "path": "tests/unit/embedding-provider.spec.ts",
      "scope": "project",
      "note": "provider dedupe optimization tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "sandbox-safe full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/embedding-provider.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted sandbox-safe provider tests"
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
      "note": "governing search/provider contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior contract"
    }
  ],
  "close_reason": "Per-request provider dedupe optimization implemented with docs/test parity; pm test + test-all sweeps passed and coverage remains 100%."
}

Implement advanced provider optimizations for semantic search as per PRD.
