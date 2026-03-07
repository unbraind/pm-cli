{
  "id": "pm-wi28",
  "title": "Sync prompt-03 create template with canonical contract",
  "description": "Align docs/prompts/prompt-03.md with current PRD/README/AGENTS create workflow by removing unsupported planned flags from active command templates.",
  "type": "Chore",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs",
    "pm-cli",
    "prompts",
    "release-readiness"
  ],
  "created_at": "2026-03-06T16:23:11.472Z",
  "updated_at": "2026-03-06T16:36:48.412Z",
  "deadline": "2026-03-07T16:23:11.472Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "Prompt-03 active create template uses only current canonical create flags; planned flags remain clearly marked as planned-only; release-readiness contract tests pass.",
  "comments": [
    {
      "created_at": "2026-03-06T16:23:11.472Z",
      "author": "maintainer-agent",
      "text": "Discovered prompt-03 drift with unsupported planned flags shown as active create usage."
    },
    {
      "created_at": "2026-03-06T16:23:19.666Z",
      "author": "maintainer-agent",
      "text": "Implementing docs-first prompt-03 template sync so active examples only use current canonical create flags."
    },
    {
      "created_at": "2026-03-06T16:24:55.022Z",
      "author": "maintainer-agent",
      "text": "Applying second changeset: add explicit close-template guidance to prompt-03 and extend release-readiness contract test coverage to include prompt-03 drift checks."
    },
    {
      "created_at": "2026-03-06T16:36:43.514Z",
      "author": "maintainer-agent",
      "text": "Evidence: node dist/cli.js test pm-wi28 --run passed; node dist/cli.js test-all --status in_progress --timeout 1200 passed (items=1 passed=1 failed=0 skipped=0); node dist/cli.js test-all --status closed --timeout 1200 --json passed (items=96 linked_tests=276 passed=63 failed=0 skipped=213); node scripts/run-tests.mjs coverage passed with 50/50 files and 402/402 tests; coverage remains 100%."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T16:23:11.472Z",
      "author": "maintainer-agent",
      "text": "Plan claim item link docs patch template run targeted release contract tests and pm-linked checks."
    }
  ],
  "files": [
    {
      "path": "docs/prompts/prompt-03.md",
      "scope": "project",
      "note": "primary drift location"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "contract guard coverage update"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "verify release readiness docs contract"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow contract"
    },
    {
      "path": "docs/prompts/prompt-03.md",
      "scope": "project",
      "note": "prompt contract source updated"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "canonical command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ],
  "close_reason": "Prompt-03 now uses the canonical create/start-work/evidence/close templates with planned flags marked as not-yet-canonical; release-readiness contract guard updated and full verification sweeps passed with 100% coverage."
}

Prompt-03 contains legacy all-fields command templates that present planned/not-yet-canonical flags as current usage. This creates contract drift risk for maintainer runs. Update the prompt so active templates only use currently supported create fields while preserving planned flags in the explicit planned-only section.
