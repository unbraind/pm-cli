{
  "id": "pm-h22w",
  "title": "Sync legacy prompt docs with create contract",
  "description": "Align prompt templates that still show minimal pm create syntax with the current explicit PRD contract.",
  "type": "Chore",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs",
    "contract",
    "pm-cli",
    "prompts"
  ],
  "created_at": "2026-03-06T14:08:27.897Z",
  "updated_at": "2026-03-06T14:23:37.197Z",
  "deadline": "2026-03-07T14:08:27.897Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "Prompt docs no longer show minimal create syntax or unsupported dependency sugar and include the current explicit create contract for safe agent usage.",
  "comments": [
    {
      "created_at": "2026-03-06T14:08:27.897Z",
      "author": "maintainer-agent",
      "text": "Why this exists prevent stale prompt guidance from creating unsupported pm usage"
    },
    {
      "created_at": "2026-03-06T14:08:47.804Z",
      "author": "maintainer-agent",
      "text": "Planned changeset update legacy prompt docs to current create contract guardrails and add release-readiness regression assertion."
    },
    {
      "created_at": "2026-03-06T14:23:36.856Z",
      "author": "maintainer-agent",
      "text": "Implemented prompt contract sync: updated docs/prompts/prompt-00.md and docs/prompts/idea.md to remove legacy create/update/activity guidance and added release-readiness regression assertions for legacy prompt docs. Evidence: node dist/cli.js test pm-h22w --run --timeout 3600 --json passed 1 of 1 linked tests; node dist/cli.js test-all --status in_progress --timeout 3600 --json passed totals items=1 linked_tests=1 passed=1 failed=0 skipped=0; node dist/cli.js test-all --status closed --timeout 3600 --json passed totals items=90 linked_tests=266 passed=63 failed=0 skipped=203; node scripts/run-tests.mjs coverage passed with 50 test files 400 tests and 100 percent coverage lines branches functions statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T14:08:27.897Z",
      "author": "maintainer-agent",
      "text": "Plan update prompt docs then add regression assertion and verify with sandbox tests"
    }
  ],
  "files": [
    {
      "path": "docs/prompts/idea.md",
      "scope": "project",
      "note": "legacy prompt synopsis wording"
    },
    {
      "path": "docs/prompts/prompt-00.md",
      "scope": "project",
      "note": "legacy command surface wording"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "guard prompt docs contract drift"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "docs contract regression"
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
      "note": "authoritative create contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public create contract wording"
    }
  ],
  "close_reason": "Legacy prompt docs now enforce current explicit create contract guidance and release-readiness checks passed with 100 percent coverage."
}

Legacy prompts like prompt-00 and idea still show simplified create/update syntax and unsupported flag sugar. Update those docs to reflect the current explicit create contract and avoid unsupported command guidance.
