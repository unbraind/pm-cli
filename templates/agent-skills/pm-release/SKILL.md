---
name: pm-release
description: Use when preparing a pm release, reviewing its gates, publishing, or verifying the released artifact. Keep source, reviewed head, main, tag, registry, and telemetry evidence distinct.
license: MIT
---

# pm Release

Inspect the release item and current release position before mutation. Search
for an existing release or incident lineage and reuse it.

1. Link the changed files, changelog, compatibility evidence, and release
   tests to the item that owns them.
2. Run the build, full coverage, static quality, security, docs, package,
   version, and hosted analysis gates required by the repository.
3. Verify the exact reviewed PR head and resolve actionable feedback before
   merging. A silent or quota-limited provider is unavailable evidence.
4. After publishing, verify the main commit, tag, GitHub Release, npm
   package, installed npm and Bun consumers, Sentry, and telemetry separately.
5. Record immutable close evidence and release the claim.

Use the repository release pipeline and pm_contracts rather than a remembered
flag spelling. Never assume a successful API request proves a scheduled
release or physical telemetry delivery.
