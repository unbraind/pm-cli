# Starter Extension (All 9 Capabilities)

This example demonstrates a single extension that uses the public SDK only:
`@unbrained/pm-cli/sdk`.

It is intentionally small and "feature complete" as a reference scaffold.

## Files

- `manifest.json` declares all 9 capabilities.
- `package.json` declares the SDK dependency.
- `index.js` registers one or more examples for each capability.

## Capability Coverage

1. `commands` - `api.registerCommand(...)` + `api.registerFlags(...)`
2. `parser` - `api.registerParser(...)`
3. `preflight` - `api.registerPreflight(...)`
4. `services` - `api.registerService(...)`
5. `renderers` - `api.registerRenderer(...)`
6. `hooks` - `api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex`
7. `schema` - `api.registerItemFields/registerItemTypes/registerMigration`
8. `importers` - `api.registerImporter/registerExporter`
9. `search` - `api.registerSearchProvider/registerVectorStoreAdapter`

## Quick Start

1. Copy this folder into an extension root:
   - project: `.agents/pm/extensions/starter-extension`
   - global: `~/.pm-cli/extensions/starter-extension`
2. Install dependencies in that copied folder:

```bash
npm install
```

3. Activate and test:

```bash
pm extension --activate --project starter-extension
pm starter ping --name "agent"
```

## Notes

- This starter is for learning and scaffolding, not production behavior.
- Keep service/renderer overrides narrowly scoped in real extensions.
- Prefer returning deterministic JSON-like objects from handlers.
