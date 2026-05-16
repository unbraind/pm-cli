---
name: pm-release
description: Run compatibility-gated pm-cli release workflows with native pm tools, linked evidence, and public-surface verification.
license: MIT
---

# pm Release

Use for release prep, compatibility gates, publication checks, and post-release verification.

## Release Loop

1. Find or create the release item after duplicate checks.
2. Claim it and link release docs, changelog, compatibility scripts, and tests.
3. Run sandboxed compatibility checks before changing release assets.
4. Run full local gates before tagging or publishing.
5. Verify public surfaces after publish and record results through `pm_comments`.

Use `pm_run` for release-adjacent pm actions not exposed as narrow tools.
