{
  "id": "pm-oadl",
  "title": "Release readiness contract audit and next fix",
  "description": "Audit current repo against PRD/README/AGENTS, run safe regressions, and implement the highest-value contract-aligned fix.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "maintainer",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T15:16:40.917Z",
  "updated_at": "2026-03-06T15:24:30.180Z",
  "deadline": "2026-03-07T15:16:40.917Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "One contract-aligned improvement is implemented and verified with sandbox-safe tests and coverage evidence logged.",
  "comments": [
    {
      "created_at": "2026-03-06T15:16:40.917Z",
      "author": "maintainer-agent",
      "text": "Starting maintainer run to keep repo release-ready and contract-aligned."
    },
    {
      "created_at": "2026-03-06T15:17:01.264Z",
      "author": "maintainer-agent",
      "text": "Plan: detect PRD README AGENTS drift and implement the smallest highest-value contract-alignment fix."
    },
    {
      "created_at": "2026-03-06T15:19:39.203Z",
      "author": "maintainer-agent",
      "text": "Next changeset: add a contract test that enforces AGENTS all-flags pm create template parity with required CLI create flags."
    },
    {
      "created_at": "2026-03-06T15:19:59.340Z",
      "author": "maintainer-agent",
      "text": "Refined changeset: document repo-local PM_CMD bootstrap guidance in AGENTS and add a release-contract test to keep that guidance from drifting."
    },
    {
      "created_at": "2026-03-06T15:24:29.987Z",
      "author": "maintainer-agent",
      "text": "Evidence: added AGENTS session bootstrap guidance and a release-readiness contract test for PM_CMD/PM_AUTHOR workflow tokens. Commands run: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts; node dist/cli.js test pm-oadl --run; node dist/cli.js test-all --status in_progress. Result: all passed and coverage remains 100 percent."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T15:16:40.917Z",
      "author": "maintainer-agent",
      "text": "First detect drift and pick smallest high-value fix before broad refactors."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "bootstrap invocation guidance"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "contract guard for AGENTS bootstrap guidance"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "sandbox-safe coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression command"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ],
  "close_reason": "Added AGENTS bootstrap invocation guidance and contract guardrails; linked regression and in-progress sweep passed with 100 percent coverage."
}

Continuous maintainer run: bootstrap, detect drift, implement one high-value improvement, verify, and document evidence.
