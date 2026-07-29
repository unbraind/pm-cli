# Portable Corpus Shapes

Tracked by [pm-vv2lti](../.agents/pm/issues/pm-vv2lti.toon).

Corpus shapes make the population behind a benchmark, evaluation, or package
test explicit. They separate item count from the characteristics that determine
real project behavior: graph depth, history density, project age, evidence
annotations, author cardinality, disconnected components, custom schema, and
relationship kinds.

## SDK primitives

Package authors can generate their own deterministic populations without
copying repository benchmark scripts:

```ts
import {
  buildCorpusShapeItemPlan,
  createCorpusShapeMeasurement,
  listBuiltinCorpusShapes,
  resolveBuiltinCorpusShape,
} from "@unbrained/pm-cli/sdk";

const shape = resolveBuiltinCorpusShape("representative");
const measurement = createCorpusShapeMeasurement(shape);
for (let index = 0; index < 1_000; index += 1) {
  measurement.add(buildCorpusShapeItemPlan(shape, index, 1_000, 42));
}
const profile = measurement.finish();

if (!profile.matches_declaration) {
  throw new Error(profile.mismatches.join("\n"));
}
```

The incremental measurement avoids retaining a million-item plan in memory.
Each item plan provides stable identifiers, parents, timestamps, authors,
history depth, typed relationship kinds, evidence annotations, and custom
schema selections. Callers retain control over how those plans are written:
direct storage fixtures, public `PmClient` operations, a remote adapter, or
their own package-specific action layer.

`defineCorpusShape` validates and freezes custom declarations. The schema
identifier is `https://schema.unbrained.dev/pm/corpus-shape/v1`.

## Built-in populations

| Shape | Purpose |
|-------|---------|
| `scratch` | Seconds-old, shallow project with minimal history |
| `representative` | Medium-lived project with rich evidence and typed lineage |
| `deep-graph` | Deep relationship graph with deterministic cycles |
| `multi-decade` | Long-lived project with dense history and broad authorship |
| `disconnected-archive` | Many independent historical components |

The scale generator accepts `--shape <name>` and writes a measured profile into
its manifest. Generation fails when the observed deterministic plan does not
conform to the declaration, including hierarchy depth and fanout, exact
relationship-kind selection, history density, and bounded annotation rates.
Custom terminal statuses use terminal lifecycle roles rather than appearing as
active work.

```bash
pnpm build
node scripts/bench/scale-workspace.mjs \
  --output /tmp/pm-shape \
  --items 1000 \
  --shape representative \
  --mode sdk
```

## Same-count evidence

`pnpm benchmark:corpus-shapes` generates both `scratch` and `representative`
with the same count and seed, then measures the same public SDK operations. The
committed [comparison report](performance/corpus-shape-comparison.json) keeps
the measured shape profiles beside operation p95 values and classifies changes
outside a 20 percent host-noise margin.

This comparison is evidence, not a fixed performance gate: it demonstrates why
counts alone cannot describe scale. Regression budgets remain shape-qualified
in `scripts/bench/scale-budgets.json`.
