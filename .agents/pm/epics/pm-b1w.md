{
  "id": "pm-b1w",
  "title": "Milestone 5 - Extension System + Built-ins",
  "description": "Milestone epic for extension framework and required built-in adapters.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:extensions",
    "core",
    "milestone:5",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:01:12.207Z",
  "updated_at": "2026-03-04T20:49:24.559Z",
  "deadline": "2026-03-13T23:01:12.207Z",
  "author": "steve",
  "estimated_minutes": 540,
  "acceptance_criteria": "Milestone 5 checklist items are implemented with precedence checks.",
  "dependencies": [
    {
      "id": "pm-f45",
      "kind": "blocks",
      "created_at": "2026-02-17T23:01:12.207Z",
      "author": "steve"
    },
    {
      "id": "pm-j7a",
      "kind": "child",
      "created_at": "2026-02-17T23:01:12.207Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:01:12.207Z",
      "author": "steve",
      "text": "Milestone 5 enables custom behavior while preserving core safety."
    },
    {
      "created_at": "2026-03-04T15:44:57.708Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed follow-up task pm-3aeu to align hook lifecycle docs and implementation for gc onIndex dispatch (mode=gc, deterministic cache-target totals) with full pm test and pm test-all evidence recorded."
    },
    {
      "created_at": "2026-03-04T16:01:34.491Z",
      "author": "maintainer-agent",
      "text": "Progress update: closed follow-up task pm-433d implementing extension command-path canonicalization (trim/lowercase/internal whitespace collapse) with PRD/README updates, targeted extension-loader tests, and full pm test + pm test-all validation at 100% coverage."
    },
    {
      "created_at": "2026-03-04T16:50:05.509Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed child task pm-qkx0 after hardening extension API registration validation for malformed command definition and renderer handler payloads with full pm test and pm test-all regression evidence at 100 percent coverage."
    },
    {
      "created_at": "2026-03-04T19:31:13.784Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed follow-up task pm-30lh after docs-first hook-registration validation hardening (PRD/README + extension loader + tests) with pm test and pm test-all evidence at 100% coverage."
    },
    {
      "created_at": "2026-03-04T19:52:55.150Z",
      "author": "steve",
      "text": "Progress update: closed child task pm-0e8w after docs-first and code hardening for extension command-handler context snapshot isolation (cloned args/options/global) with pm test and both pm test-all sweeps passing at 100% coverage."
    },
    {
      "created_at": "2026-03-04T20:13:20.926Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed follow-up task pm-8d71 after docs-first and implementation hardening for command override and renderer snapshot isolation; extension failure/fallback paths now prevent mutation leakage, with pm test plus pm test-all sweeps passing at 100% coverage."
    },
    {
      "created_at": "2026-03-04T20:35:02.075Z",
      "author": "maintainer-agent",
      "text": "Progress update: closed follow-up task pm-xyv3 after docs-first + implementation update for activity history-directory onRead hook dispatch; added unit regression coverage and completed mandatory pm test plus pm test-all sweeps with 100% coverage gate passing."
    },
    {
      "created_at": "2026-03-04T20:41:06.623Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: perform milestone-5 closure validation by running linked coverage + regression sweeps (pm test + pm test-all), confirm docs/implementation parity for extension architecture contracts, then close if acceptance criteria is met."
    },
    {
      "created_at": "2026-03-04T20:49:24.087Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-b1w --run --timeout 2400 passed (node scripts/run-tests.mjs coverage; 48/48 files and 358/358 tests). Regression sweeps passed via pm test-all --status in_progress --timeout 2400 (items=1, passed=1, failed=0, skipped=0) and pm test-all --status closed --timeout 2400 (items=58, passed=57, failed=0, skipped=132 deterministic dedupe). Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T23:01:12.207Z",
      "author": "steve",
      "text": "Success means extension precedence and health reporting are deterministic."
    }
  ],
  "files": [
    {
      "path": "src/core/extensions/index.ts",
      "scope": "project",
      "note": "active extension dispatch"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "extension activation and hook runtime"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "extension loader deterministic behavior"
    },
    {
      "path": "tests/unit/extensions-runtime.spec.ts",
      "scope": "project",
      "note": "extension runtime and override isolation"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full coverage gate for milestone closure"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood tracking and release workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative milestone-5 checklist"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public extension command contract"
    }
  ]
}

Implement extension loading hooks and built-in integrations.
