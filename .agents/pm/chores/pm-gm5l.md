{
  "id": "pm-gm5l",
  "title": "Harden settings serialization contract coverage",
  "description": "Strengthen release-readiness tests to enforce exact settings.json key ordering from PRD defaults.",
  "type": "Chore",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs",
    "area:tests",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T14:49:38.366Z",
  "updated_at": "2026-03-06T15:02:59.184Z",
  "deadline": "2026-03-07T14:49:38.366Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "settings-store coverage asserts exact top-level and nested settings key order from PRD defaults; targeted and full sandboxed regressions pass with coverage at 100%.",
  "dependencies": [
    {
      "id": "pm-wo8",
      "kind": "related",
      "created_at": "2026-03-06T14:49:38.366Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T14:49:38.366Z",
      "author": "maintainer-agent",
      "text": "Why this exists: PRD requires exact settings key order and this guard prevents silent serializer drift."
    },
    {
      "created_at": "2026-03-06T14:49:48.673Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: strengthen settings-store unit assertions to enforce exact PRD key order across top-level and nested settings blocks without changing runtime behavior."
    },
    {
      "created_at": "2026-03-06T15:02:55.141Z",
      "author": "maintainer-agent",
      "text": "Implemented settings-store contract hardening: tests/unit/settings-store.spec.ts now asserts exact serialized settings key order for top-level and nested objects (locks, output, extensions, search, providers, vector_store). Evidence: pm test pm-gm5l --run --timeout 3600 --json passed 2/2 linked tests; pm test-all --status in_progress --timeout 3600 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 3600 --json passed totals items=91 linked_tests=267 passed=63 failed=0 skipped=204. Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T14:49:38.366Z",
      "author": "maintainer-agent",
      "text": "Plan: tighten settings-store assertions for exact key order and verify with sandboxed targeted plus coverage runs."
    }
  ],
  "files": [
    {
      "path": "tests/unit/settings-store.spec.ts",
      "scope": "project",
      "note": "add exact key-order contract assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/settings-store.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "targeted sandbox regression"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative settings key-order contract"
    }
  ],
  "close_reason": "settings serialization contract coverage hardened with exact key-order assertions and passing sandboxed regressions"
}

Add deterministic assertions for top-level and nested settings key order and keep docs-contract coverage aligned.
