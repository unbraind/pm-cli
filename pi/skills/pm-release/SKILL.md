---
name: pm-release
description: Release-readiness workflow for pm projects in Pi. Use when running final validation, coverage, package checks, GitHub checks, and closure evidence through the native pm integration.
license: MIT
compatibility: Pi coding-agent with the @unbrained/pm-cli Pi package installed.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: release
---

# pm Release Workflow for Pi

Use the native `pm` tool for tracker state and linked evidence. Use shell only for non-pm project build/test commands.

## Release Checklist

1. `pm` action `context` with `depth: "standard"`.
2. Run linked tests with `pm` action `test` and `run: true` for active work items.
3. Run validation with `pm` action `validate`, usually `checkResolution: true`, `checkHistoryDrift: true`, and relevant file checks.
4. Run package install/discovery smoke for Pi packages:
   - local: `pi install -l .` or `pi -e .`
   - npm after publish: `pi install npm:@unbrained/pm-cli`
5. Use `gh` only to inspect GitHub checks after pushing.
6. Add a `comments` evidence entry with exact command summaries.
7. Close/release the pm item with `close-task` once acceptance criteria are met.

## Evidence Format

Record:
- Changed package resources (`pi.extensions`, `pi.skills`, `pi.prompts`)
- Native pm tool smoke result
- Build/test/coverage result
- Pi install smoke result
- GitHub checks status
