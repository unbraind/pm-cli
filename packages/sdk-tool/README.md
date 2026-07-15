# SDK Custom Tool Exemplar

Tracker: [pm-cbwg](../../.agents/pm/features/pm-cbwg.toon) · [pm-w89s](../../.agents/pm/stories/pm-w89s.toon)

`@unbrained/pm-sdk-tool` is a standalone project-management application built
exclusively on `@unbrained/pm-cli/sdk`. It is deliberately not a pm extension:
it proves that an integrator can create a separate executable and domain model
without importing command implementations, storage internals, or private core
modules.

The exemplar treats project management as context management. In one bounded
workflow it:

- initializes an isolated tracker through `PmClient`;
- registers a `WorkUnit` type and `tool_review` lifecycle status;
- creates a parent/child hierarchy and a typed relationship edge;
- claims, updates, releases, reclaims, and closes domain work;
- records comments, private notes, and linked artifact context;
- consumes list, search, context, and bounded relationship projections;
- runs validation and health diagnostics before completing the lifecycle.

## Run it

Install or pack `@unbrained/pm-cli`, then run the bundled executable against an
absolute tracker path:

```bash
pm-sdk-tool init /tmp/sdk-project/.agents/pm
pm-sdk-tool demo /tmp/sdk-project/.agents/pm README.md
```

The `demo` command returns a small JSON summary suitable for automation. The
library API exposes the same flow:

```js
import {
  initializeCustomTool,
  runCustomToolDemo,
} from "@unbrained/pm-sdk-tool";

const pmRoot = "/tmp/sdk-project/.agents/pm";
await initializeCustomTool(pmRoot);
const result = await runCustomToolDemo({ pmRoot, artifactPath: "README.md" });
console.log(result);
```

Copy this package when building a project-specific tool, then replace the
example type, lifecycle, and orchestration policy. Keep the SDK entrypoint as
the only pm dependency so CLI adapters and internal storage layouts remain free
to evolve.
