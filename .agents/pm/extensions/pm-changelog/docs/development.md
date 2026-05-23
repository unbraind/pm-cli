# Development

## Layout

```text
pm-changelog/
  manifest.json          pm extension manifest
  package.json           npm metadata plus pm package catalog metadata
  src/                   TypeScript source
  test/                  TypeScript test source
  dist/                  built CLI, API, and extension runtime
  docs/                  detailed documentation
```

`dist/` is tracked intentionally so GitHub and local pm package installs work without a build step. npm packaging still runs `npm run build` through `prepack`.

## TypeScript Policy

Source and tests are TypeScript. Do not add JavaScript source files.

The pm extension must use the official SDK surface:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Do not import private pm-cli internals or add local SDK shims. If an official SDK feature is missing or broken, open an issue in `unbraind/pm-cli` and document the package-side impact in pm project management.

## Commands

Install dependencies:

```bash
npm ci
```

Build:

```bash
npm run build
```

Type-check:

```bash
npm run check
```

Run tests:

```bash
npm test
```

Regenerate changelog:

```bash
npm run changelog
```

Verify changelog:

```bash
npm run changelog:check
```

Run the full release gate:

```bash
npm run release:check
```

## pm Project Management

Use pm items for release governance, features, tasks, chores, issues, and verification evidence.

Recommended checks:

```bash
pm health --json
pm validate --json --check-metadata --check-resolution --check-lifecycle --check-command-references --check-history-drift --strict-exit
pm list-all --json
```

Every release-readiness item should record:

- Acceptance criteria.
- Files and docs touched.
- Tests and commands run.
- GitHub/npm/security evidence.
- Final resolution and actual result.

Close items before final changelog generation so `CHANGELOG.md` includes the completed work.

## Temporary Install Test

Use a clean folder to prove pm package installation:

```bash
npm run build
tmp="$(mktemp -d)"
cd "$tmp"
pm init --json
pm install /home/steve/container/pm-packages/pm-changelog --project --json
pm package doctor --project --json --detail deep
pm create --type task --title "Verify pm-changelog install" --description "Smoke test" --status closed --json
pm changelog generate --output CHANGELOG.md --release-version smoke --date 2026-05-24 --json
```

For published package verification, replace the local path with:

```bash
pm install npm:pm-changelog --project --json
```

## Secret Review

Before public release, scan reachable history and filenames for private data. Synthetic test fixtures such as sanitized `token=secret` URLs are acceptable only when documented as false positives.
