# Usage

## pm Extension

Install from npm:

```bash
pm install npm:pm-changelog --project
```

Other supported pm install sources:

```bash
pm install github.com/unbraind/pm-changelog --project
pm install ./pm-changelog --project
```

Generate a changelog from the current pm project:

```bash
pm changelog generate
```

Common extension commands:

```bash
pm changelog generate --release-version 1.2.0 --output CHANGELOG.md
pm changelog generate --stdout --group-by milestone
pm changelog generate --stdout --group-by release
pm changelog generate --release-version-from-package --since-previous-tag --until-release-tag
pm changelog generate --all-release-tags --mode replace
pm changelog generate --mode prepend --release-version "$GITHUB_REF_NAME"
pm changelog generate --check --mode prepend --release-version "$GITHUB_REF_NAME"
```

The extension command uses `--release-version` because `pm --version` is a global CLI flag.

## Standalone CLI

Install:

```bash
npm install --save-dev pm-changelog @unbrained/pm-cli
```

Generate from the current pm project:

```bash
npx pm-changelog
```

Generate release notes in CI:

```bash
npx pm-changelog --pm-root . --version "$GITHUB_REF_NAME" --since 2026-05-01
```

Create or update `CHANGELOG.md` while preserving older entries:

```bash
npx pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --output CHANGELOG.md
```

Emit runner-readable metadata:

```bash
npx pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --json
```

Fail CI if the committed changelog is stale:

```bash
npx pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --check
```

Expose summary values to later GitHub Actions steps:

```bash
npx pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --json --github-output
```

Append generated markdown to the GitHub Actions job summary:

```bash
npx pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --github-step-summary
```

Print markdown instead of writing a file:

```bash
npx pm-changelog --stdout --version 1.2.0
```

Read JSON from a previous step:

```bash
pm list-all --json | npx pm-changelog --stdin --stdout
```

Use a pinned or wrapped pm executable:

```bash
npx pm-changelog --pm-bin ./node_modules/.bin/pm --mode prepend --version "$GITHUB_REF_NAME"
```

Pass runner-specific arguments and a working directory:

```bash
npx pm-changelog --pm-bin ./pm-wrapper --pm-arg --profile --pm-arg ci --pm-cwd "$GITHUB_WORKSPACE" --mode prepend
```

Generate one section per `release` metadata value:

```bash
npx pm-changelog --group-by release --mode prepend --output CHANGELOG.md
```

Make pm item IDs clickable links to their `.toon` files on GitHub:

```bash
npx pm-changelog --group-by release --mode replace \
  --item-url-base https://github.com/owner/repo/blob/main/.agents/pm
```

Rebuild the full changelog from actual git release tags:

```bash
npx pm-changelog --all-release-tags --mode replace --output CHANGELOG.md \
  --item-url-base https://github.com/owner/repo/blob/main/.agents/pm
```

`--all-release-tags` creates a newest-first `Unreleased` section for closed items after the latest tag, then one section per matching git tag. Release section dates come from the tag commit timestamp. Items with a `release` field whose value matches a known tag (`v2026.05.24-7`, `2026.05.24-7`, etc.) are bucketed into that tag's section regardless of timestamps; items without a matching `release` field fall back to each item's `closed_at`, `updated_at`, then `created_at` timestamp. Empty release windows are omitted unless `--include-empty` is passed.

Pair `--all-release-tags` with `--release-version-from-package` (or `--version v<x>`) to insert a section for the pending release before the tag is created — for example during CI when bumping `package.json` ahead of `git tag`.

Each item entry becomes a link: `- Fix something ([pmc-abc](https://github.com/owner/repo/blob/main/.agents/pm/issues/pmc-abc.toon))`. The type subdirectory (`issues/`, `tasks/`, `chores/`, `features/`, `epics/`) is resolved automatically from the item's type.

## Opt-in enhancements

All of the following flags are strictly additive: omitting them produces byte-for-byte identical output to earlier versions, so they are safe to adopt incrementally in CI.

Group items inside each release by type, status, or tag instead of the default keep-a-changelog categories:

```bash
npx pm-changelog --stdout --section-by type
npx pm-changelog --stdout --section-by label
```

Render Conventional-Commits headings (`Features`, `Bug Fixes`, `Documentation`, ...) while keeping the default category bucketing:

```bash
npx pm-changelog --stdout --conventional
```

Append a per-release contributor list (from `assignee`, falling back to `author`):

```bash
npx pm-changelog --stdout --contributors
```

Trim large histories to the most recent releases or to releases at/after a version:

```bash
npx pm-changelog --all-release-tags --stdout --limit 10
npx pm-changelog --all-release-tags --stdout --since-version 2.0.0
```

Emit a structured changelog document (releases -> sections -> items) for downstream tooling:

```bash
npx pm-changelog --all-release-tags --changelog-json > changelog.json
```

Surface breaking changes in a dedicated section (items whose type/tag/title contains `breaking`, or that carry a truthy `breaking` flag). The breaking items still appear in their normal category below, so this is purely additive:

```bash
npx pm-changelog --stdout --breaking-changes
```

Get a suggested semver bump from the in-scope items (breaking -> major, feature -> minor, fix -> patch). Printed as JSON to stdout; never writes the changelog and never alters default markdown. It is also embedded in `--changelog-json` output when combined:

```bash
npx pm-changelog --suggest-semver
npx pm-changelog --changelog-json --suggest-semver
```

Append a short preview of each item body to its entry (first N characters, single-lined; truncated with an ellipsis when longer):

```bash
npx pm-changelog --stdout --body-preview 80
```

Prefix section headings with conventional emoji (`Added 🎉`, `Fixed 🐛`, ...; unknown custom headings pass through unchanged):

```bash
npx pm-changelog --stdout --emoji-prefix
```

The same flags are available on the pm extension command:

```bash
pm changelog generate --stdout --section-by status
pm changelog generate --stdout --conventional --contributors
pm changelog generate --changelog-json
```

## Options

| Option | Default | Description |
|---|---:|---|
| `--output <file>` | `CHANGELOG.md` | Output path |
| `--stdout` | false | Print markdown instead of writing a file |
| `--input <file>` | - | Read pm JSON from a file |
| `--stdin` | false | Read pm JSON from stdin |
| `--pm-root <dir>` | - | Run `pm --path <dir> list-all --json` |
| `--pm-bin <file>` | `pm` | pm executable to run |
| `--pm-arg <arg>` | - | Extra argument passed before `list-all --json`; repeat for multiple args |
| `--pm-cwd <dir>` | - | Working directory for running pm |
| `--version <version>` | `Unreleased` | Version heading for the standalone CLI |
| `--release-version-from-package` | false | Read the version heading from the nearest `package.json` |
| `--date <date>` | today | Release date |
| `--since <date>` | - | Include items changed on or after date |
| `--since-previous-tag` | false | Derive `--since` from the previous git tag. If the current release tag exists, the previous tag before it is used; otherwise the latest tag before `HEAD` is used. |
| `--until <date>` | - | Include items changed on or before date |
| `--until-release-tag` | false | Derive `--until` from the current release tag when it exists (`v<version>` or `<version>`). Useful after a release tag has been created so post-release tracker changes do not move the published section. |
| `--all-release-tags` | false | Rebuild full changelog history from git release tag windows, including an `Unreleased` section for post-latest-tag closed items. |
| `--release-tag-pattern <glob>` | `v*` | Git tag glob used by `--all-release-tags`. |
| `--status <list>` | `closed` | Comma-separated statuses |
| `--group-by <mode>` | `version` | `version`, `release`, or `milestone` (controls how release sections are bucketed) |
| `--section-by <mode>` | `category` | Within-release grouping: `category` (default, keep-a-changelog), `type`, `status`, or `label` |
| `--conventional` | false | With the default `category` grouping, render Conventional-Commits headings (`Features`, `Bug Fixes`, ...) instead of `Added`/`Fixed`/... |
| `--contributors` | false | Append a `Contributors` list per release derived from item `assignee` (falling back to `author`) |
| `--limit <n>` | - | Keep only the most recent N release sections (only affects `--all-release-tags`/`--group-by` history output) |
| `--since-version <v>` | - | Keep only releases at or newer than version `<v>` (`Unreleased` is always kept; history output only) |
| `--changelog-json` | false | Print the full structured changelog document (releases -> sections -> items) as JSON to stdout. Distinct from `--json` (CI summary) |
| `--breaking-changes` | false | Emit an additional `Breaking Changes` section per release listing items detected as breaking (type/tag/title contains `breaking`, or a truthy `breaking` flag) |
| `--suggest-semver` | false | Print a suggested semver bump (`major`/`minor`/`patch`/`none`) as JSON to stdout; never writes the changelog. Also embedded in `--changelog-json` output |
| `--body-preview <n>` | - | Append the first N characters of each item's body to its entry (single-lined, truncated with an ellipsis when longer) |
| `--emoji-prefix` | false | Prefix section headings with conventional emoji (`Added 🎉`, `Fixed 🐛`, ...); unknown headings pass through unchanged |
| `--mode <mode>` | `replace` | `replace` or `prepend` existing changelog |
| `--json` | false | Print JSON summary for automation |
| `--check` | false | Do not write; exit 1 if the output file would change |
| `--github-output` | false | Write summary fields to `$GITHUB_OUTPUT` |
| `--github-step-summary` | false | Append generated markdown to `$GITHUB_STEP_SUMMARY` |
| `--include-empty` | false | Emit an empty section when no items match. When using `--all-release-tags`, empty release windows are omitted by default; pass this flag to keep them as `No changes.` sections. |
| `--include-links` | false | Include item `url` values in generated entries |
| `--item-url-base <url>` | - | Make item IDs clickable links to their `.toon` files; point to `.agents/pm` in the repo (e.g. `https://github.com/owner/repo/blob/main/.agents/pm`). The type subdirectory (`issues/`, `tasks/`, `chores/`, etc.) is derived automatically from each item's type. |

## TypeScript API

```ts
import { readPmItems, writeChangelog } from "pm-changelog";

const items = readPmItems({
  pmRoot: process.cwd(),
  pmBin: "./node_modules/.bin/pm",
});

const result = writeChangelog({
  items,
  output: "CHANGELOG.md",
  mode: "prepend",
  groupBy: "release",
  since: process.env.CHANGELOG_SINCE,
  includeLinks: false,
  itemUrlBase: "https://github.com/owner/repo/blob/main/.agents/pm",
});

console.log({
  action: result.action,
  changed: result.changed,
  items: result.itemCount,
  output: result.output,
});
```

Use `version` when a runner is generating one release section from the current job context. Use `groupBy: "release"` or `--group-by release` when pm items already carry release metadata and a runner should rebuild multiple sections in one pass.

Use `--all-release-tags` for a full project `CHANGELOG.md` that should reflect actual git/npm release history. Use the single-release `--release-version-from-package --since-previous-tag --until-release-tag` path for release note jobs that only publish the current tag section.

For date-based release projects, prefer the package-owned release context flags instead of wrapper scripts:

```bash
pm changelog generate --release-version-from-package --since-previous-tag --until-release-tag --output CHANGELOG.md
```

Item links are omitted by default so public CI jobs do not accidentally publish private tracker URLs. Pass `--include-links` or `includeLinks: true` only when item URLs are safe to expose. When links are included, credentials, query strings, and fragments are stripped before markdown is emitted.

Pass `--item-url-base` or `itemUrlBase` to make item IDs themselves clickable links pointing directly to the `.toon` files in the repository. The tool derives the correct type subdirectory (`issues/`, `tasks/`, `chores/`, `features/`, `epics/`) from each item's type automatically — no configuration per type is needed.
