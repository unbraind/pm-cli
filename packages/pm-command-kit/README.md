# @unbrained/pm-command-kit

First-party **exemplar package** for the pm extension `commands` capability. Copy this
package wholesale when you want to ship your own pm command: it demonstrates the three
command-facing SDK registration APIs in their smallest complete form.

## What it demonstrates

| API                                       | What the exemplar does                                                                                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.registerCommand(definition)`         | Registers `pm command-kit echo` with a FULL `CommandDefinition`: `name`, `action`, `tier`, `family`, `description`, `intent`, `arguments` (required variadic positional), `flags`, `examples`, `failure_hints`, and a pure `run` handler.                                         |
| `api.registerParser(command, override)`   | Preprocesses parsed options before the handler runs: rewrites the deprecated `--shout` alias to `--upper`, coerces `--repeat` to a positive integer, and trims/dedupes `--decorations` values. The override returns a delta (`{ options }`) that is merged over the parsed input. |
| `api.registerFlags(targetCommand, flags)` | Injects an inert, namespaced `--kit-note <text>` flag into the EXISTING core `pm list` command — the pattern for augmenting commands you do not own.                                                                                                                              |

## Install

```bash
pm install command-kit --project
```

## Usage

```bash
pm command-kit echo "hello world"
pm command-kit echo hello --upper --repeat 2
pm command-kit echo hello --decorations star,spark --decorations wave
pm command-kit echo hello --shout            # parser rewrites --shout to --upper
pm list --kit-note "triage pass"             # injected flag; core list ignores it
```

The command returns a structured result (rendered as TOON or JSON by the host):

```json
{
  "action": "command-kit-echo",
  "message": "HELLO",
  "lines": ["HELLO", "HELLO"],
  "repeat": 2,
  "upper": true,
  "decorations": []
}
```

## Package anatomy

```
packages/pm-command-kit/
├── package.json                       # pm resources: aliases, extensions, catalog, docs
├── README.md
└── extensions/command-kit/
    ├── manifest.json                  # capabilities, trusted, sandbox_profile, permissions
    └── index.ts                       # authored and loaded directly with type stripping
```

Key conventions for authors:

- `index.ts` is both the authored source and the runtime entrypoint. pm strips types
  when loading it, so there is no duplicate compiled module to keep synchronized.
  Type-only SDK imports retain editor/typecheck support without adding runtime imports.
- The module's `manifest.capabilities` literal must match `manifest.json` exactly
  (`commands` for `registerCommand`, `schema` for flag definitions/`registerFlags`,
  `parser` for `registerParser`).
- This extension is pure compute (no fs/network/env/process access), so the manifest
  declares `"trusted": true`, `"sandbox_profile": "strict"`, and all six permission keys
  (`fs_read`, `fs_write`, `network`, `env_read`, `env_write`, `process_spawn`) as `false`.
  Declare only what your extension actually does — the extension policy engine evaluates
  these fields when sandbox/trust enforcement is enabled.
- `activation.commands` in `manifest.json` lists both package-owned commands and
  existing commands that receive injected flags so the host can lazily activate the
  extension before option validation.
- Unit tests can validate this package's three command-facing registrations with
  public SDK helpers: `assertRegisteredCommandContract(...)` for the owned command,
  `assertRegisteredParserOverride(...)` for parser rewrites, and
  `assertRegisteredFlags(...)` for the injected `pm list --kit-note` flag.
