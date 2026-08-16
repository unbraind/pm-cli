---
name: pm-sdk
description: Implements pm-cli integrations on the published @unbrained/pm-cli SDK entrypoints and runtime contracts. Use when authoring extensions, embedding pm in another tool, building a domain on pm primitives, or keeping a wrapper aligned with command/action schema changes.
license: MIT
compatibility: Requires Node.js and access to pm contracts output for runtime parity checks.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: sdk-integration
---

# pm SDK Skill

The SDK is the implementation; the CLI and the MCP server are thin consumers of
it. Anything the CLI can do is reachable from the published surface, and an
integration should never import repository internals to get it.

## Load Order

| Tier | Load                                            | Cost      | When                                  |
| ---- | ----------------------------------------------- | --------- | ------------------------------------- |
| 0    | This file                                       | ~700 tok  | Always.                               |
| 1    | `pm contracts --summary`                        | ~2.6k     | The command/action surface.           |
| 1    | `sdk/public-surface.json`                       | query it  | Exact exported symbols and signatures.|
| 2    | `pm contracts --command <cmd> --full --json`    | ~1-4k     | One command's complete contract.      |
| 3    | `references/*.md` below                         | ~0.3-1k   | Procedure detail.                     |
| 4    | `docs/SDK.md` **by section only**               | 45k whole | Never read whole; grep to a heading.  |

Optional deep routing that never goes stale:

```bash
pm install guide-shell --project
pm guide sdk
pm guide tokens --depth brief
```

## Entrypoints

Import the narrowest entrypoint that owns the capability. Startup cost is
proportional to what you import.

| Export                                    | Capability family                                        |
| ----------------------------------------- | -------------------------------------------------------- |
| `@unbrained/pm-cli/sdk/core`              | Items, schema, profile, transactions, runtime primitives  |
| `@unbrained/pm-cli/sdk/query`             | List and search engines, filtering, pagination, rendering |
| `@unbrained/pm-cli/sdk/graph`             | Relationship stores, traversal, analytics, remediation    |
| `@unbrained/pm-cli/sdk/governance`        | Validation, health, gc, transaction cleanup               |
| `@unbrained/pm-cli/sdk/merge`             | VCS-neutral tracker merge contracts                       |
| `@unbrained/pm-cli/sdk/authoring`         | Extension blueprints, builders, manifests                 |
| `@unbrained/pm-cli/sdk/contracts`         | Static command/action contracts, expected-error protocol  |
| `@unbrained/pm-cli/sdk/runtime`           | Embedded command execution, package runtime helpers       |
| `@unbrained/pm-cli/sdk/testing`           | Package and extension assertion/invocation helpers        |
| `@unbrained/pm-cli/sdk`                   | Compatibility aggregate over every supported export       |
| `@unbrained/pm-cli/sdk/public-surface.json` | Machine-readable surface snapshot shipped with the package |
| `@unbrained/pm-cli/cli`                   | Executable entry (`runPmCli`), not a typed library API    |

Query the shipped surface instead of guessing a symbol name:

```bash
jq -r '.entrypoints["./sdk/graph"].symbols[].name' \
  node_modules/@unbrained/pm-cli/sdk/public-surface.json | head -40
```

## Non-Negotiables

- Never import from `src/core/...` or any unpublished module path. The boundary
  is gated and a private import fails the build.
- Never mirror an SDK type in your own package. Import it or derive it with
  `typeof`; a hand-copied signature becomes immutable consumer code.
- Treat `pm contracts` output as the source of truth for flags, actions, and
  availability. Snapshot it in a test so drift fails rather than surprises.
- Author identity is detected automatically. Pass an author only for a
  deliberate identity override.

## Integration Loop

1. Capture the runtime surface: `pm contracts --schema-only`,
   `pm contracts --runtime-only --availability-only`.
2. Map payload fields to contract keys — do not assume the CLI flag spelling
   equals the SDK option key.
3. Implement against the narrowest entrypoint.
4. Add a regression test that fails when a required contract field drifts.
5. Verify the packed artifact, not just the working tree.

## Surface Compatibility

The published surface is a reviewed artifact. Additive changes are recorded;
removals and signature changes require an explicit acknowledgement with a
reason that stays in the snapshot.

```bash
pnpm sdk:surface:check
pnpm sdk:surface:update
pnpm sdk:surface:update -- --acknowledge-breaking "<release rationale>"
```

Every package export that declares a `types` path must carry a classification,
so a new public entrypoint cannot ship ungoverned.

## References

| Need                                        | Load                                                    | Cost     |
| ------------------------------------------- | -------------------------------------------------------- | -------- |
| Step-by-step integration checklist           | [Integration checklist](references/INTEGRATION_CHECKLIST.md) | ~400 tok |
| Prompt templates                             | [Prompts](references/PROMPTS.md)                          | ~200 tok |
| Which entrypoint owns which capability       | [Surface map](references/SURFACE_MAP.md)                  | ~900 tok |
| Building a non-PM domain on pm primitives    | [Domain modeling](references/DOMAIN_MODELING.md)          | ~900 tok |
