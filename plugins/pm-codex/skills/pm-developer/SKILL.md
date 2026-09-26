---
name: pm-developer
description: Use when implementing, debugging, refactoring, or shipping code, tests, or docs tracked by pm. Keep SDK behavior and verification linked to the active item.
license: MIT
---

# pm Developer

Orient with pm-workflow before editing. Claim the canonical item and keep its
scope aligned with the change.

1. Read the complete source owner and relevant tests before editing. For a
   regression, identify the observable contract and the change that would
   make its test fail.
2. Put domain behavior in the public pm SDK. Keep CLI and MCP adapters thin,
   with transport-specific tests only where those boundaries add risk.
3. Link changed files, docs, and isolated runnable tests through pm_files,
   pm_docs, and pm_test.
4. Run the focused test, build, full coverage, static quality, and installed
   consumer checks required by the affected contract. Keep tracker test roots
   separate from the real repository.
5. Record exact results in pm_comments. Close with structured resolution,
   expected, and actual fields only when the criteria are actually met.

Prefer pm_contracts for flags and the SDK public surface for integration APIs.
An unknown review provider or missing check is not approval.
