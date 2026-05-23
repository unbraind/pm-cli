# pm-changelog

Generate `CHANGELOG.md` from pm-cli items for local releases, GitHub Actions, runners, and scripts.

The package provides:

- `pm-changelog`, a standalone CLI that reads `pm list-all --json` or JSON input
- `createChangelog()`, `generateChangelog()`, `mergeChangelog()`, and `writeChangelog()` programmatic APIs
- `pm changelog generate`, a pm-cli extension command

## Install

Install as a pm package from GitHub:

```bash
pm install github.com/unbraind/pm-changelog --project
```

Then run the extension command:

```bash
pm changelog generate --mode prepend --output CHANGELOG.md
```

Install the standalone CLI/API package from npm:

```bash
npm install --save-dev pm-changelog @unbrained/pm-cli
```

Use the local checkout for development:

```bash
npm install
npm run build
```

Local checkout extension install:

```bash
pm install ./pm-changelog --project
```

The repository tracks `dist/` intentionally so GitHub and local pm package installs work without a build step. npm packaging still runs `npm run build` through `prepack`.

Package metadata is declared in `package.json` under `pm`, and the runtime extension manifest is `manifest.json` at the package root.

Supported package-manager sources:

```bash
pm install github.com/unbraind/pm-changelog --project
pm install npm:pm-changelog --project
pm install ./pm-changelog --project
```

## Package Layout

```text
pm-changelog/
  manifest.json       # pm extension manifest loaded by the package manager
  package.json        # npm metadata plus pm package catalog/install metadata
  LICENSE             # MIT license for npm and public repository consumers
  dist/               # built CLI, API, and extension runtime tracked for pm installs
  src/                # TypeScript source
  test/               # node:test coverage for generator, CLI, and runner behavior
```

## Release Verification

Run the full local release gate before tagging or publishing:

```bash
npm run release:check
```

The release gate type-checks the TypeScript source, runs the full test suite, audits production dependencies, verifies the npm package contents with a dry run, and checks that `CHANGELOG.md` is current.

Release tags follow the pm CLI date-based convention: `vYYYY.MM.DD`, or `vYYYY.MM.DD-N` for additional releases on the same day. npm package metadata uses the SemVer-compatible equivalent without the leading `v` or zero-padded numeric components, for example `2026.5.23`.

## CLI

Generate `CHANGELOG.md` from the current pm project:

```bash
pm-changelog
```

Generate release notes for a CI release:

```bash
pm-changelog --pm-root . --version "$GITHUB_REF_NAME" --since 2026-05-01
```

Create or update `CHANGELOG.md` while preserving older entries:

```bash
pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --output CHANGELOG.md
```

After building, the package also exposes npm scripts for projects that install it locally:

```bash
npm run changelog -- --version "$GITHUB_REF_NAME"
npm run changelog:check -- --version "$GITHUB_REF_NAME"
```

Emit runner-readable metadata:

```bash
pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --json
```

Fail CI if the committed changelog is stale without rewriting it:

```bash
pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --check
```

Expose summary values to later GitHub Actions steps:

```bash
pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --json --github-output
```

Append the generated changelog markdown to the GitHub Actions job summary:

```bash
pm-changelog --mode prepend --version "$GITHUB_REF_NAME" --github-step-summary
```

Print markdown instead of writing a file:

```bash
pm-changelog --stdout --version 1.2.0
```

Read JSON from a previous step:

```bash
pm list-all --json | pm-changelog --stdin --stdout
```

Use a pinned or wrapped pm executable in a runner:

```bash
pm-changelog --pm-bin ./node_modules/.bin/pm --mode prepend --version "$GITHUB_REF_NAME"
```

Pass runner-specific arguments and a working directory to wrapped pm commands:

```bash
pm-changelog --pm-bin ./pm-wrapper --pm-arg --profile --pm-arg ci --pm-cwd "$GITHUB_WORKSPACE" --mode prepend
```

Generate one section per `release` metadata value from pm items:

```bash
pm-changelog --group-by release --mode prepend --output CHANGELOG.md
```

Useful options:

| Option | Default | Description |
|---|---:|---|
| `--output <file>` | `CHANGELOG.md` | Output path |
| `--stdout` | false | Print markdown instead of writing a file |
| `--input <file>` | - | Read pm JSON from a file |
| `--stdin` | false | Read pm JSON from stdin |
| `--pm-root <dir>` | - | Run `pm --path <dir> list-all --json` |
| `--pm-bin <file>` | `pm` | pm executable to run, useful for pinned local installs and runner wrappers |
| `--pm-arg <arg>` | - | Extra argument passed before `list-all --json`; repeat for multiple args |
| `--pm-cwd <dir>` | - | Working directory for running pm |
| `--version <version>` | `Unreleased` | Version heading |
| `--date <date>` | today | Release date |
| `--since <date>` | - | Include items changed on or after date |
| `--until <date>` | - | Include items changed on or before date |
| `--status <list>` | `closed` | Comma-separated statuses |
| `--group-by <mode>` | `version` | `version`, `release`, or `milestone` |
| `--mode <mode>` | `replace` | `replace` or `prepend` existing changelog |
| `--json` | false | Print JSON summary for automation |
| `--check` | false | Do not write; exit 1 if the output file would change |
| `--github-output` | false | Write `output`, `mode`, `action`, `changed`, `item_count`, and `bytes` to `$GITHUB_OUTPUT` |
| `--github-step-summary` | false | Append generated markdown to `$GITHUB_STEP_SUMMARY` |
| `--include-empty` | false | Emit an empty section when no items match |
| `--include-links` | false | Include item `url` values in generated entries |

## pm-cli command

```bash
pm changelog generate
pm changelog generate --release-version 1.2.0 --output CHANGELOG.md
pm changelog generate --stdout --group-by milestone
pm changelog generate --stdout --group-by release
pm changelog generate --mode prepend --release-version "$GITHUB_REF_NAME"
pm changelog generate --check --mode prepend --release-version "$GITHUB_REF_NAME"
```

The pm extension command uses `--release-version` because `pm --version` is a global CLI flag. The standalone `pm-changelog` binary uses `--version`.

## Programmatic API

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

Item links are omitted by default so public CI jobs do not accidentally publish private tracker URLs. Pass `--include-links` or `includeLinks: true` when item URLs are safe to expose. When links are included, credentials, query strings, and fragments are stripped before markdown is emitted.

You can also pass items directly:

```ts
import { generateChangelog } from "pm-changelog";

const markdown = generateChangelog({
  version: "1.2.0",
  items: [
    {
      id: "pm-123",
      title: "Fix CSV import status handling",
      status: "closed",
      type: "Bug",
      tags: ["fix"],
      updated_at: "2026-05-17T09:00:00Z",
    },
  ],
});
```

Runner wrappers can provide extra pm arguments, a working directory, and environment:

```ts
import { readPmItems } from "pm-changelog";

const items = readPmItems({
  pmBin: process.env.PM_BIN ?? "pm",
  pmArgs: ["--profile", "ci"],
  cwd: process.env.GITHUB_WORKSPACE,
  env: process.env,
});
```

## Categorization

Items are grouped into Keep a Changelog-style sections using `type`, `tags`, and title keywords:

- `Added`: feature, feat, added, add, new
- `Changed`: change, refactor, update, improve
- `Fixed`: fix, bug, hotfix, regression
- `Removed`: removed, delete
- `Security`: security, CVE, vulnerability
- `Deprecated`: deprecated, deprecation
- `Other`: anything else

## GitHub Actions Example

```yaml
name: Changelog

on:
  workflow_dispatch:
  release:
    types: [published]

jobs:
  changelog:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - name: Generate changelog
        id: changelog
        run: node dist/cli.js --mode prepend --version "${GITHUB_REF_NAME}" --output CHANGELOG.md --json --github-output --github-step-summary
      - name: Commit changelog
        if: steps.changelog.outputs.changed == 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add CHANGELOG.md
          git commit -m "docs: update changelog"
          git push
```

## Build

```bash
npm run build
```

TypeScript 5, ES2022 target, NodeNext module resolution.

## License

MIT
