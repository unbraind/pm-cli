# SDK Surface Map

Where each capability lives, and how to reach the detail without loading
[docs/SDK.md](../../../../docs/SDK.md) whole (~45k tokens).

## Route To A Section, Not To The File

```bash
grep -n "^## \|^### " docs/SDK.md          # heading index, ~40 lines
sed -n '<start>,<end>p' docs/SDK.md        # read one section
```

| Topic                                    | Heading in docs/SDK.md            |
| ---------------------------------------- | --------------------------------- |
| Install and package resolution            | `## Install`                      |
| Entrypoints and import cost               | `## Import Surfaces`              |
| Surface snapshot and breaking-change gate | `### Public-surface compatibility`|
| The full export inventory                 | `## Public Exports`               |
| Building a custom project tool            | `### Build an entire custom project tool` |
| Building a non-PM domain                  | `### Build a non-PM temporal domain` |
| Plan workflows                            | `### Plan workflows`              |
| History, restore, rich item reads         | `### Immutable history and rich item reads` |
| Linked resources and dependency governance| `### Linked resources and dependency governance` |
| Output budgets and discovery              | `### Agent output budgets and discovery` |
| Static and runtime contracts              | `## Static And Runtime Contracts` |
| Atomic workspace transactions             | `### Atomic workspace transactions` |
| Schema evolution                          | `### Schema evolution and workspace history` |
| Query execution                           | `### Query execution`             |
| Context relevance and evaluation          | `### Context relevance and evaluation` |
| Extension capability requirements         | `## Capability Requirements`      |
| Declarative authoring and blueprints      | `## Declarative Authoring`        |
| Testing helpers                           | `## Testing Helpers`              |
| Custom item types                         | `## Custom Item Type`             |
| Importers and exporters                   | `## Importer / Exporter`          |
| Search providers                          | `## Search Provider`              |

## Query The Shipped Surface

`sdk/public-surface.json` ships inside the package, so an integration can read
the exact surface it compiled against without locating repository files.

```bash
SURFACE=node_modules/@unbrained/pm-cli/sdk/public-surface.json

# Which entrypoints exist and how they are classified
jq -r '.entrypoints | to_entries[] | "\(.key)\t\(.value.classification)"' "$SURFACE"

# Does a symbol exist, and where
jq -r --arg n createItem '.entrypoints | to_entries[]
  | select(.value.symbols[]?.name == $n) | .key' "$SURFACE"

# The exact signature the package compiled against
jq -r --arg n createItem '.entrypoints["./sdk"].symbols[]
  | select(.name == $n) | .signature' "$SURFACE"

# Stable error-code vocabulary
jq -r '.error_codes[]' "$SURFACE" | head -30
```

Classifications carry intent:

- `supported` — stable authoring surface.
- `contract_data` — generated contract tables.
- `advanced_export` — reachable but not the recommended path.
- `aggregate_alias` — republishes another entrypoint's declarations verbatim.
- `executable_entry` — the CLI runtime entry, not a typed library API.

## Other Contract Artifacts

| Artifact                                   | Answers                                        |
| ------------------------------------------ | ---------------------------------------------- |
| `pm contracts --summary --json`             | Commands, intents, per-command token ceilings   |
| `pm contracts --command <c> --full --json`  | Flags, exit vocabulary, output contract         |
| `pm contracts --schema-only`                | Item schema, types, statuses, fields            |
| `pm contracts --runtime-only --availability-only` | What this installation actually exposes   |
| `pm contracts --json --full \| jq '.mcp_tools'` | The MCP tool surface                        |
| `pm contracts --json --full \| jq '.relationship_kind_contracts'` | Edge kinds and inverses   |
| `docs/generated/AGENT_COMMAND_SURFACE.md`   | Command visibility tiers                        |

`contracts --json --full` is large enough that the default budget omits it.
Pass `--output-budget unbounded` when scripting it, and never into an agent's
own context unfiltered — pipe it through `jq` first.
