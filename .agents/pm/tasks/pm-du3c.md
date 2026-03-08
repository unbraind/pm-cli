{
  "id": "pm-du3c",
  "title": "Docs parity: mark Pi wrapper packaging polish as implemented",
  "description": "Docs-first alignment to remove stale post-v0.1 roadmap wording for Pi wrapper packaging/distribution polish now that fallback packaging behavior is implemented and tested.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:docs",
    "area:extensions-pi",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "release-readiness"
  ],
  "created_at": "2026-03-08T18:23:37.306Z",
  "updated_at": "2026-03-08T18:40:27.144Z",
  "deadline": "2026-03-09T20:00:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "PRD.md and README.md no longer describe Pi wrapper packaging/distribution polish as roadmap work, docs remain consistent with implemented behavior, and release-readiness tests pass at 100% coverage.",
  "definition_of_ready": "Drift confirmed between docs and closed implementation evidence in pm-bdz5.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Keep docs authoritative against implemented Pi wrapper behavior",
  "value": "Prevents roadmap confusion for maintainers and users",
  "impact": "Improves trust in docs for release decisions",
  "outcome": "Pi wrapper packaging status is documented as implemented",
  "why_now": "Current docs still mark an already-complete capability as roadmap",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-08",
  "release": "v0.1",
  "expected_result": "Docs show implemented status for Pi wrapper packaging polish",
  "affected_version": "0.1.0",
  "component": "documentation",
  "regression": false,
  "customer_impact": "Reduces ambiguity for contributors relying on roadmap text",
  "dependencies": [
    {
      "id": "pm-bdz5",
      "kind": "related",
      "created_at": "2026-03-08T18:23:37.306Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T18:23:37.306Z",
      "author": "maintainer-agent",
      "text": "Why this exists docs currently lag completed Pi wrapper packaging polish and need authoritative alignment."
    },
    {
      "created_at": "2026-03-08T18:24:01.297Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits update PRD and README to remove stale roadmap wording for Pi wrapper packaging polish then tighten release-readiness docs contract assertions."
    },
    {
      "created_at": "2026-03-08T18:25:09.406Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first alignment by removing stale PRD roadmap wording for Pi wrapper packaging polish, clarifying README packaging resilience status, and adding a release-readiness assertion to prevent regression."
    },
    {
      "created_at": "2026-03-08T18:40:24.857Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-du3c --run --timeout 7200 --json passed linked tests 2/2 including coverage and targeted release-readiness contract. pm test-all --status in_progress --timeout 7200 --json passed with items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed with items=157 linked_tests=394 passed=72 failed=0 skipped=322. Coverage remains 100 percent statements branches functions lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T18:23:37.306Z",
      "author": "maintainer-agent",
      "text": "Plan update PRD and README wording then adjust release-readiness assertion and run pm validations."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "roadmap wording correction"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "roadmap wording correction"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "guard against future drift"
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
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract alignment"
    }
  ],
  "close_reason": "Docs now reflect implemented Pi wrapper packaging polish and contract tests enforce this wording; all required pm validation sweeps passed with 100 percent coverage."
}

Context: PRD.md and README.md still describe Pi wrapper packaging/distribution polish as post-v0.1 roadmap, but implementation and closed evidence exist in pm-bdz5. Approach: update docs first and strengthen release-readiness contract assertions so drift is caught.
