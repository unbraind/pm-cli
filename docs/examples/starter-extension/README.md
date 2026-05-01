# Starter Extension

This example demonstrates all extension capability categories through the public SDK import `@unbrained/pm-cli/sdk`.

## Agent Quick Context

- Copy this folder when you need a complete capability reference.
- Use `pm extension init ./my-extension` when you need a smaller scaffold.
- Keep production extensions narrower than this example.

Related docs:

- [Extensions](../../EXTENSIONS.md)
- [SDK](../../SDK.md)

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | declares extension metadata and capabilities |
| `package.json` | declares local package metadata and SDK dependency |
| `index.js` | registers examples for each capability category |

## Capability Coverage

| Capability | Example surface |
|------------|-----------------|
| `commands` | `api.registerCommand(...)` |
| `parser` | `api.registerParser(...)` |
| `preflight` | `api.registerPreflight(...)` |
| `services` | `api.registerService(...)` |
| `renderers` | `api.registerRenderer(...)` |
| `hooks` | command, read, write, and index hooks |
| `schema` | item fields, item types, migrations |
| `importers` | importer and exporter registration |
| `search` | search provider and vector adapter |

## Quick Start

Copy into an extension root:

```bash
mkdir -p .agents/pm/extensions
cp -R docs/examples/starter-extension .agents/pm/extensions/starter-extension
cd .agents/pm/extensions/starter-extension
npm install
```

Activate and test from the repository root:

```bash
pm extension activate starter-extension --project
pm starter ping --name "agent"
pm extension doctor --detail summary
```

## Notes

- This starter is for learning and scaffold reference.
- Real extensions should declare only the capabilities they need.
- Keep service, parser, and preflight overrides narrow and well tested.
- Return deterministic JSON-like objects from command handlers.
