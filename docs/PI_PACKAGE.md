# Pi Native Package

pm-cli ships an official Pi package so Pi can use pm through a native extension instead of shelling out to the `pm` CLI.

## Install

After the package is published:

```bash
pi install npm:@unbrained/pm-cli
```

If you install an unscoped npm alias, use the same Pi syntax, for example `pi install npm:pm-cli`. The published package in this repository is `@unbrained/pm-cli`.

From a local checkout:

```bash
pnpm build
pi install -l .
# or try without writing settings
pi --no-extensions -e .
```

`pnpm build` is required for local checkouts because the Pi extension imports the compiled native integration from `dist/pi/native.js`.

## Package Resources

The root `package.json` declares the Pi manifest:

- `pi.extensions`: `.pi/extensions/pm-cli/index.js`
- `pi.skills`: `.pi/skills`
- `pi.prompts`: `.pi/prompts`

The extension registers:

- native `pm` tool using pm command modules directly, not the `pm` shell command
- `/pm-context`, `/pm-start`, `/pm-close`, and `/pm-actions` helper commands
- status footer entry `pm native`

## Native Tool Usage

Use the Pi `pm` tool with an `action` field. Examples:

```json
{ "action": "context", "limit": 10 }
{ "action": "search", "query": "pi extension", "limit": 10 }
{ "action": "start-task", "id": "pm-1234", "author": "pi-agent" }
{ "action": "files", "id": "pm-1234", "add": ["path=src/file.ts,scope=project,note=implementation"], "author": "pi-agent" }
{ "action": "close-task", "id": "pm-1234", "text": "Verified and complete", "author": "pi-agent", "validateClose": "warn" }
```

For real project tracking, leave `path` unset. For tests, set `path` to a sandbox pm root and isolate `PM_GLOBAL_PATH`.

## Supported Surface

The native integration covers the core pm action set exposed by the SDK contracts: init/config/extensions, item creation and lifecycle, list/search/context/calendar/activity, files/docs/deps/tests, validation/health/gc/contracts, templates, test-runs, and guide workflows.
