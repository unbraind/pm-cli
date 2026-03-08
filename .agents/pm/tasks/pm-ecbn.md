{
  "id": "pm-ecbn",
  "title": "Restore full todos import metadata parity",
  "description": "Preserve current ItemFrontMatter optional metadata when importing todos markdown so import/export round-trips do not silently drop planning, workflow, and issue fields.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-todos",
    "code",
    "docs",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-08T13:57:37.636Z",
  "updated_at": "2026-03-08T14:27:34.644Z",
  "deadline": "2026-03-09T13:56:50.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "Todos import preserves canonical optional front-matter fields currently supported by ItemFrontMatter including planning workflow and issue metadata; PRD and README describe the parity guarantee; targeted and full sandboxed regressions pass with 100% coverage preserved.",
  "definition_of_ready": "Gap reproduced by code inspection against ItemFrontMatter and no active duplicate item exists.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Close todos import parity drift",
  "value": "Prevents silent metadata loss in extension workflows.",
  "impact": "Improves migration safety and cross-tool compatibility for real project tracking.",
  "outcome": "Todos markdown round-trips preserve canonical pm metadata.",
  "why_now": "Milestone 5 still documents todos hardening as partial and current import behavior contradicts that intent.",
  "parent": "pm-3s0",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-08",
  "release": "v0.1",
  "component": "extensions/todos",
  "regression": true,
  "customer_impact": "Users importing todos markdown can currently lose planning and issue metadata without warning.",
  "dependencies": [
    {
      "id": "pm-3s0",
      "kind": "related",
      "created_at": "2026-03-08T13:57:37.636Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T13:57:37.636Z",
      "author": "maintainer-agent",
      "text": "Why this exists todos import currently drops many canonical front matter fields even though export writes them."
    },
    {
      "created_at": "2026-03-08T13:57:45.631Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update PRD and README to state todos import preserves canonical optional ItemFrontMatter fields during round-trip import-export, then hydrate missing import mappings in src/extensions/builtins/todos/import-export.ts and add regression coverage in tests/unit/todos-extension.spec.ts before running pm test and pm test-all sweeps."
    },
    {
      "created_at": "2026-03-08T13:59:37.193Z",
      "author": "maintainer-agent",
      "text": "Implementation update: PRD and README now state todos import preserves canonical optional ItemFrontMatter metadata when present. src/extensions/builtins/todos/import-export.ts now hydrates the missing planning workflow and issue metadata fields with deterministic enum and boolean normalization, and tests/unit/todos-extension.spec.ts adds a focused regression fixture covering those fields."
    },
    {
      "created_at": "2026-03-08T14:01:08.967Z",
      "author": "maintainer-agent",
      "text": "Coverage follow-up: added regression alias coverage for todos import so string false and numeric 1/0 inputs exercise the new boolean normalization branches before rerunning the item-linked coverage gate."
    },
    {
      "created_at": "2026-03-08T14:02:20.153Z",
      "author": "maintainer-agent",
      "text": "Coverage follow-up: added enum sanitization coverage for numeric order, empty risk, invalid severity, and direct boolean regression passthrough so the new todos import helpers meet the 100% coverage gate."
    },
    {
      "created_at": "2026-03-08T14:03:39.808Z",
      "author": "maintainer-agent",
      "text": "Coverage follow-up: added normalization edge coverage for order=not-an-integer, regression=\"0\", and unsupported regression=2 so the remaining todos import helper branches are exercised without broadening runtime behavior."
    },
    {
      "created_at": "2026-03-08T14:04:42.852Z",
      "author": "maintainer-agent",
      "text": "Coverage follow-up: added unsupported regression string coverage so todos import boolean normalization now exercises the remaining string fallthrough branch before final validation."
    },
    {
      "created_at": "2026-03-08T14:11:06.155Z",
      "author": "maintainer-agent",
      "text": "Validation note: concurrent pm test-all sweeps contend on shared coverage artifacts in this repo, so release validation is being rerun sequentially after one parallel in_progress sweep showed a false-negative coverage drop despite standalone pm test passing at 100%."
    },
    {
      "created_at": "2026-03-08T14:27:34.337Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed on current changes. pm test pm-ecbn --run --timeout 7200 passed both linked commands after targeted coverage follow-ups; node scripts/run-tests.mjs coverage reports 100% statements branches functions and lines, and node scripts/run-tests.mjs test -- tests/unit/todos-extension.spec.ts passed 20/20. Sequential regression sweeps then passed: pm test-all --status in_progress --timeout 7200 => items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 => items=150 linked_tests=382 passed=68 failed=0 skipped=314. Note: parallel test-all sweeps produced a false-negative coverage race on shared coverage artifacts, so final evidence uses the sequential rerun."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T13:57:37.636Z",
      "author": "maintainer-agent",
      "text": "Plan update docs first then hydrate missing fields in todos import and add round trip regression coverage."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "todos extension parity contract wording"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public todos extension wording"
    },
    {
      "path": "src/extensions/builtins/todos/import-export.ts",
      "scope": "project",
      "note": "todos import normalization gap"
    },
    {
      "path": "tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "note": "round trip parity regression coverage"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted todos regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative extension parity contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public todos extension parity contract"
    }
  ],
  "close_reason": "Todos import now preserves canonical optional metadata and the full sequential regression sweep is green."
}

Current todos export writes full front matter but todos import only hydrates a subset of ItemFrontMatter. This silently drops definition_of_ready, planning metadata, blocked metadata, reviewer/risk/confidence/release, and issue-specific fields on re-import. Update docs first then implement import normalization and regression coverage so round-trips are lossless for canonical fields.
