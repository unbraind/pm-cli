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
| `--date <date>` | today | Release date |
| `--since <date>` | - | Include items changed on or after date |
| `--until <date>` | - | Include items changed on or before date |
| `--status <list>` | `closed` | Comma-separated statuses |
| `--group-by <mode>` | `version` | `version`, `release`, or `milestone` |
| `--mode <mode>` | `replace` | `replace` or `prepend` existing changelog |
| `--json` | false | Print JSON summary for automation |
| `--check` | false | Do not write; exit 1 if the output file would change |
| `--github-output` | false | Write summary fields to `$GITHUB_OUTPUT` |
| `--github-step-summary` | false | Append generated markdown to `$GITHUB_STEP_SUMMARY` |
| `--include-empty` | false | Emit an empty section when no items match |
| `--include-links` | false | Include item `url` values in generated entries |

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
});

console.log({
  action: result.action,
  changed: result.changed,
  items: result.itemCount,
  output: result.output,
});
```

Use `version` when a runner is generating one release section from the current job context. Use `groupBy: "release"` or `--group-by release` when pm items already carry release metadata and a runner should rebuild multiple sections in one pass.

Item links are omitted by default so public CI jobs do not accidentally publish private tracker URLs. Pass `--include-links` or `includeLinks: true` only when item URLs are safe to expose. When links are included, credentials, query strings, and fragments are stripped before markdown is emitted.
