# Authoring An Extension

The procedure, with routes into the detail rather than a copy of it.

## Route To A Section

```bash
grep -n "^## " docs/EXTENSIONS.md
sed -n '<start>,<end>p' docs/EXTENSIONS.md
```

| Topic                          | Heading in docs/EXTENSIONS.md |
| ------------------------------ | ----------------------------- |
| Where packages come from        | `## Package Sources`          |
| Package manifest fields         | `## Package Manifest`         |
| Directory layout                | `## Extension Layout`         |
| Extension manifest fields       | `## Extension Manifest`       |
| Capability and governance policy| `## Governance Policy`        |
| Name collisions                 | `## Registration Collisions`  |
| Runtime APIs available          | `## Runtime APIs`             |
| Lifecycle commands              | `## Lifecycle Commands`       |
| Upgrades                        | `## Upgrade Workflow`         |
| Runnable examples               | `## Runnable Examples`        |

Author-time contracts live in
[docs/EXTENSION_AUTHOR_CONTRACTS.md](../../../../docs/EXTENSION_AUTHOR_CONTRACTS.md)
and lifecycle detail in
[docs/EXTENSION_LIFECYCLE.md](../../../../docs/EXTENSION_LIFECYCLE.md).

## Shape

An extension exports `activate(api)` and registers through the `register*`
family, or declares itself with `defineExtension` and a blueprint. Both forms
end in the same registration, so choose declarative authoring when the surface
is static and imperative activation when registration depends on runtime state.

Registrable surfaces:

- Commands and command actions
- Custom item types and their fields
- Statuses with declared lifecycle roles
- Importers and exporters
- Search providers
- Project profiles
- Templates

## Capabilities Are Declared, Not Assumed

The manifest declares what the extension may do. Anything undeclared is not
granted at activation. Declare the minimum, then verify:

```bash
pm package doctor --detail deep
pm contracts --runtime-only --availability-only
```

A declared version bound must be one the loader actually enforces — a bound
written in a field nothing reads is worse than no bound, because it reads as a
guarantee.

## Sources

Extensions come from npm, GitHub, a bundled package, or a local directory, and
the same source works from all four. Package runtime modules use ordinary
static ESM imports from the published SDK entrypoints; they do not locate copied
source files through environment variables or generate loader shims.

Never mirror a public SDK type inside a package. Import it, or derive its shape
with `typeof`. A hand-copied signature becomes immutable consumer code the
moment the package publishes.

## Author Loop

```bash
pm package init <name>                       # scaffold
# ...implement extensions/*.ts...
pm package install <path-or-name> --project          # install locally
pm package doctor --detail deep              # activation diagnostics
pm contracts --command <your-command> --flags-only
pm <your-command> --help --json              # the contract a consumer will read
```

Record the work on a pm item as you go: link the package sources with
`pm files`, the docs with `pm docs`, and a runnable check with `pm test`.

## Release Safety

```bash
pm package doctor --detail deep
pm contracts --runtime-only --availability-only
pm health --check-only
```

An extension that changes what a shared command emits is changing a contract,
not adding a feature. Treat the contract snapshot as the review artifact.
