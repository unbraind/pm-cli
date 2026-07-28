# Package SDK Contract Conformance

Trackers: [pm-vnk7ob](../.agents/pm/issues/pm-vnk7ob.toon), [pm-w7mqzt](../.agents/pm/tasks/pm-w7mqzt.toon)

## Agent Quick Context

First-party and third-party packages should treat `@unbrained/pm-cli/sdk` and
its documented subpaths as the authoritative contract. Import public result,
option, metadata, and registry types directly. When a package needs the shape
of an SDK module, derive it with `typeof` instead of copying method signatures.

```ts
import * as pmSdk from "@unbrained/pm-cli/sdk";
import type {
  LocatedItem,
  TemplatesListResult,
} from "@unbrained/pm-cli/sdk";

const sdk: typeof pmSdk = pmSdk;
```

Do not declare a package-local interface or type alias with the name of an SDK
export. Do not maintain a hand-written `*SdkModule` interface that repeats SDK
methods. Those mirrors can drift after the host SDK evolves even when the
package itself still typechecks.

## First-Party Gate

`pnpm quality:static` runs
`scripts/release/package-sdk-contract-parity.mjs`. The gate reads the committed
public SDK surface and scans the exact TypeScript sources shipped under
`packages/pm-*/extensions/`. It fails with source locations when it finds:

- a top-level interface or type alias that redeclares a public SDK symbol;
- a `*SdkModule` interface containing a hand-written public SDK method.

The gate is intentionally tied to `sdk/public-surface.json`. When a new public
type is added, regenerate and verify the snapshot:

```bash
pnpm sdk:surface:update
pnpm sdk:surface:check
pnpm quality:static
```

This keeps package authoring customizable without creating a second contract
layer: the SDK supplies stable primitives, while packages own policy, commands,
hooks, rendering, and workflow composition.
