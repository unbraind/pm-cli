{
  "id": "pm-oie4",
  "title": "Sync AGENTS Pi create example with explicit contract",
  "description": "Align AGENTS Pi wrapper create example with PRD-required create fields and add regression coverage.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs",
    "area:tests",
    "contract",
    "pi-wrapper",
    "pm-cli"
  ],
  "created_at": "2026-03-06T13:52:02.707Z",
  "updated_at": "2026-03-06T14:04:54.462Z",
  "deadline": "2026-03-07T13:52:02.707Z",
  "author": "maintainer-agent",
  "estimated_minutes": 45,
  "acceptance_criteria": "AGENTS Pi create example uses full explicit create payload and release-readiness test fails if required create keys disappear from that example.",
  "comments": [
    {
      "created_at": "2026-03-06T13:52:02.707Z",
      "author": "maintainer-agent",
      "text": "Why this exists keep AGENTS Pi create usage aligned with current explicit create contract."
    },
    {
      "created_at": "2026-03-06T13:52:19.701Z",
      "author": "maintainer-agent",
      "text": "Planned changeset update AGENTS Pi create example to explicit all-fields payload and add release-readiness assertion that required create keys remain documented in that example."
    },
    {
      "created_at": "2026-03-06T14:04:46.079Z",
      "author": "maintainer-agent",
      "text": "Implemented docs+test sync: AGENTS Pi wrapper create example now documents the explicit all-fields payload including repeatable seed arrays; release-readiness contract suite now asserts required Pi create example keys and repeatable array presence. Evidence: pm test pm-oie4 --run --timeout 3600 --json passed 2/2 linked tests; pm test-all --status in_progress --timeout 3600 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 3600 --json passed totals items=89 linked_tests=264 passed=62 failed=0 skipped=202; node scripts/run-tests.mjs coverage passed (50 files 399 tests) with 100% lines branches functions statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T13:52:02.707Z",
      "author": "maintainer-agent",
      "text": "Plan update AGENTS example then add regression assertion in release readiness tests then verify via sandboxed test runner."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Pi wrapper create example contract sync"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "assert AGENTS Pi create example required fields"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/help-readme-contract.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "docs parity regression suite"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "release readiness docs contract checks"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "target document for Pi create payload update"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative create contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "cross-check public create contract wording"
    }
  ],
  "close_reason": "AGENTS Pi wrapper create example now matches explicit create payload contract and release-readiness regression enforces it; linked tests plus coverage passed with no failures."
}

AGENTS section 9 still shows a minimal Pi create payload that omits required create fields. Update docs and release-readiness tests so Pi usage mirrors current create contract and stays deterministic.
