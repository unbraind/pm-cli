# SDK-only custom project tool

Tracked by [pm-cbwg](../../../.agents/pm/features/pm-cbwg.toon) and
[pm-w89s](../../../.agents/pm/stories/pm-w89s.toon).

This package is the end-to-end acceptance proof for pm's universal-tool goal.
It is a standalone domain CLI, not an extension: its implementation imports
only `@unbrained/pm-cli/sdk` and composes customization, lifecycle, query,
context, annotation, linked-resource, relationship, and governance primitives.

Run the acceptance suite, including the executable adapter contract, against
fresh temporary workspaces:

```bash
node scripts/run-tests.mjs test -- tests/unit/sdk/sdk-universal-tool-exemplar.spec.ts
```

The `pm-custom` flow registers a `Deliverable` type and `reviewing` status,
creates a related parent/child graph, records comments/notes/learnings, links
workspace evidence, reads list/search/context/dependency projections, closes
the work with resolution evidence, and returns health/history verification as
structured JSON. It never imports `src/core`, `src/cli`, or spawns `pm`.

Use [src/index.ts](src/index.ts) as the copyable library pattern and
[src/cli.ts](src/cli.ts) as the process-independent executable adapter. The
package maps `pm-custom` to [src/entry.ts](src/entry.ts), which wires that
adapter to Node.js arguments, author identity, output streams, and exit status.
