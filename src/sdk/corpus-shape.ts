/**
 * @module sdk/corpus-shape
 *
 * Declares portable, versioned synthetic-workspace population shapes and
 * produces deterministic item plans for benchmarks, evaluations, and packages.
 */

/** Stable schema identifier for portable corpus-shape specifications. */
export const PM_CORPUS_SHAPE_SCHEMA =
  "https://schema.unbrained.dev/pm/corpus-shape/v1";

/** Built-in corpus populations covering distinct project-history regimes. */
export type BuiltinCorpusShapeName =
  | "scratch"
  | "representative"
  | "deep-graph"
  | "multi-decade"
  | "disconnected-archive";

/** One weighted relationship kind in a generated corpus. */
export interface CorpusShapeEdgeWeight {
  /** Registered pm relationship kind. */
  kind: string;
  /** Relative deterministic selection weight. */
  weight: number;
}

/** Portable declaration of the population behind a benchmark or evaluation. */
export interface CorpusShape {
  /** Versioned schema identity. */
  schema: typeof PM_CORPUS_SHAPE_SCHEMA;
  /** Stable shape name used by CLIs and reports. */
  name: string;
  /** Human-readable intent and expected use. */
  description: string;
  /** Maximum generated parent-chain depth. */
  hierarchy_depth: number;
  /** Target maximum number of children per generated parent. */
  hierarchy_fanout: number;
  /** Project time spanned by generated timestamps. */
  age_span_days: number;
  /** History entries generated for every item. */
  history_entries_per_item: number;
  /** Evidence comments generated per hundred items. */
  comments_per_100_items: number;
  /** Private notes generated per hundred items. */
  notes_per_100_items: number;
  /** Durable learnings generated per hundred items. */
  learnings_per_100_items: number;
  /** Weighted typed relationship population. */
  edge_kind_mix: readonly CorpusShapeEdgeWeight[];
  /** Number of distinct mutation authors. */
  author_cardinality: number;
  /** Number of disconnected hierarchy/relationship components. */
  component_count: number;
  /** Whether deterministic back-edges should exercise cyclic graph handling. */
  include_cycles: boolean;
  /** Custom item types registered before generation. */
  custom_types: readonly string[];
  /** Custom lifecycle statuses registered before generation. */
  custom_statuses: readonly string[];
  /** Custom metadata fields registered before generation. */
  custom_fields: readonly string[];
}

/** Deterministic SDK plan for one generated corpus item. */
export interface CorpusShapeItemPlan {
  /** Zero-based item position. */
  index: number;
  /** Stable generated item identifier. */
  id: string;
  /** Optional generated parent identifier. */
  parent?: string;
  /** Component assigned by the shape. */
  component: number;
  /** Deterministic timestamp across the declared age span. */
  timestamp: string;
  /** Deterministic author identity. */
  author: string;
  /** Number of history entries to materialize. */
  history_entry_count: number;
  /** Relationship kinds selected for this item. */
  dependency_kinds: readonly string[];
  /** Whether the item receives an evidence comment. */
  has_comment: boolean;
  /** Whether the item receives a private note. */
  has_note: boolean;
  /** Whether the item receives a durable learning. */
  has_learning: boolean;
  /** Custom type selected for this item, when configured. */
  custom_type?: string;
  /** Custom status selected for this item, when configured. */
  custom_status?: string;
}

/** Measured population profile attached to generated-corpus evidence. */
export interface CorpusShapeProfile {
  /** Shape declaration identity. */
  shape: string;
  /** Generated item count. */
  item_count: number;
  /** Observed distinct author count. */
  author_count: number;
  /** Observed hierarchy component count. */
  component_count: number;
  /** Observed maximum parent-chain depth. */
  hierarchy_depth: number;
  /** Observed minimum and maximum timestamps. */
  timestamp_range: { first: string | null; last: string | null };
  /** Observed total history entries. */
  history_entry_count: number;
  /** Observed annotation totals. */
  annotations: { comments: number; notes: number; learnings: number };
  /** Observed relationship-kind totals. */
  edge_kinds: Record<string, number>;
  /** True when every declared invariant represented by the plan matches. */
  matches_declaration: boolean;
  /** Actionable mismatches, empty for a conforming plan. */
  mismatches: readonly string[];
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Corpus shape ${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `Corpus shape ${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  Object.freeze(value);
}

/** Validate, detach, and deeply freeze a portable corpus-shape declaration. */
export function defineCorpusShape(shape: CorpusShape): Readonly<CorpusShape> {
  if (shape.schema !== PM_CORPUS_SHAPE_SCHEMA) {
    throw new TypeError(`Unsupported corpus shape schema: ${shape.schema}`);
  }
  if (shape.name.trim().length === 0 || shape.description.trim().length === 0) {
    throw new TypeError("Corpus shape name and description must be non-empty");
  }
  positiveInteger(shape.hierarchy_depth, "hierarchy_depth");
  positiveInteger(shape.hierarchy_fanout, "hierarchy_fanout");
  nonNegativeInteger(shape.age_span_days, "age_span_days");
  positiveInteger(shape.history_entries_per_item, "history_entries_per_item");
  nonNegativeInteger(shape.comments_per_100_items, "comments_per_100_items");
  nonNegativeInteger(shape.notes_per_100_items, "notes_per_100_items");
  nonNegativeInteger(shape.learnings_per_100_items, "learnings_per_100_items");
  positiveInteger(shape.author_cardinality, "author_cardinality");
  positiveInteger(shape.component_count, "component_count");
  if (
    shape.edge_kind_mix.length === 0 ||
    shape.edge_kind_mix.some(
      (edge) => edge.kind.trim().length === 0 || edge.weight <= 0,
    )
  ) {
    throw new TypeError(
      "Corpus shape edge_kind_mix requires non-empty kinds with positive weights",
    );
  }
  const detached = structuredClone(shape);
  deepFreeze(detached);
  return detached;
}

const COMMON_EDGE_MIX: readonly CorpusShapeEdgeWeight[] = [
  { kind: "implements", weight: 5 },
  { kind: "blocked_by", weight: 2 },
  { kind: "discovered_from", weight: 2 },
  { kind: "verifies", weight: 2 },
  { kind: "supersedes", weight: 1 },
  { kind: "related", weight: 4 },
];

/** Canonical built-in corpus shapes used by repository and downstream gates. */
export const BUILTIN_CORPUS_SHAPES: Readonly<
  Record<BuiltinCorpusShapeName, Readonly<CorpusShape>>
> = Object.freeze({
  scratch: defineCorpusShape({
    schema: PM_CORPUS_SHAPE_SCHEMA,
    name: "scratch",
    description: "Seconds-old, shallow project with minimal history.",
    hierarchy_depth: 2,
    hierarchy_fanout: 50,
    age_span_days: 0,
    history_entries_per_item: 1,
    comments_per_100_items: 2,
    notes_per_100_items: 1,
    learnings_per_100_items: 1,
    edge_kind_mix: [{ kind: "related", weight: 1 }],
    author_cardinality: 2,
    component_count: 1,
    include_cycles: false,
    custom_types: [],
    custom_statuses: [],
    custom_fields: [],
  }),
  representative: defineCorpusShape({
    schema: PM_CORPUS_SHAPE_SCHEMA,
    name: "representative",
    description: "Medium-lived project with rich evidence and typed lineage.",
    hierarchy_depth: 5,
    hierarchy_fanout: 8,
    age_span_days: 730,
    history_entries_per_item: 12,
    comments_per_100_items: 30,
    notes_per_100_items: 12,
    learnings_per_100_items: 10,
    edge_kind_mix: COMMON_EDGE_MIX,
    author_cardinality: 32,
    component_count: 1,
    include_cycles: false,
    custom_types: ["Experiment"],
    custom_statuses: ["review"],
    custom_fields: ["domain"],
  }),
  "deep-graph": defineCorpusShape({
    schema: PM_CORPUS_SHAPE_SCHEMA,
    name: "deep-graph",
    description: "Deep typed relationship graph with deterministic cycles.",
    hierarchy_depth: 16,
    hierarchy_fanout: 2,
    age_span_days: 3650,
    history_entries_per_item: 6,
    comments_per_100_items: 15,
    notes_per_100_items: 8,
    learnings_per_100_items: 8,
    edge_kind_mix: COMMON_EDGE_MIX,
    author_cardinality: 16,
    component_count: 1,
    include_cycles: true,
    custom_types: [],
    custom_statuses: [],
    custom_fields: [],
  }),
  "multi-decade": defineCorpusShape({
    schema: PM_CORPUS_SHAPE_SCHEMA,
    name: "multi-decade",
    description: "Thirty-year event history with dense per-item evolution.",
    hierarchy_depth: 6,
    hierarchy_fanout: 6,
    age_span_days: 10_958,
    history_entries_per_item: 24,
    comments_per_100_items: 40,
    notes_per_100_items: 20,
    learnings_per_100_items: 16,
    edge_kind_mix: COMMON_EDGE_MIX,
    author_cardinality: 64,
    component_count: 1,
    include_cycles: false,
    custom_types: ["Program"],
    custom_statuses: ["archived"],
    custom_fields: ["portfolio"],
  }),
  "disconnected-archive": defineCorpusShape({
    schema: PM_CORPUS_SHAPE_SCHEMA,
    name: "disconnected-archive",
    description: "Multiple disconnected historical project components.",
    hierarchy_depth: 4,
    hierarchy_fanout: 10,
    age_span_days: 7305,
    history_entries_per_item: 8,
    comments_per_100_items: 10,
    notes_per_100_items: 5,
    learnings_per_100_items: 6,
    edge_kind_mix: COMMON_EDGE_MIX,
    author_cardinality: 24,
    component_count: 5,
    include_cycles: false,
    custom_types: ["Archive"],
    custom_statuses: ["archived"],
    custom_fields: ["archive_source"],
  }),
});

/** Return all built-in corpus-shape declarations in stable name order. */
export function listBuiltinCorpusShapes(): readonly Readonly<CorpusShape>[] {
  return Object.keys(BUILTIN_CORPUS_SHAPES)
    .sort()
    .map(
      (name) =>
        BUILTIN_CORPUS_SHAPES[name as BuiltinCorpusShapeName],
    );
}

/** Resolve one built-in corpus shape or reject an unknown name. */
export function resolveBuiltinCorpusShape(
  name: string,
): Readonly<CorpusShape> {
  const normalized = name.trim().toLowerCase() as BuiltinCorpusShapeName;
  const shape = BUILTIN_CORPUS_SHAPES[normalized];
  if (shape === undefined) {
    throw new TypeError(
      `Unknown corpus shape "${name}". Available: ${Object.keys(BUILTIN_CORPUS_SHAPES).join(", ")}`,
    );
  }
  return shape;
}

function selectedEdgeKinds(
  index: number,
  shape: Readonly<CorpusShape>,
): string[] {
  if (index === 0) {
    return [];
  }
  const expanded = shape.edge_kind_mix.flatMap((entry) =>
    Array.from({ length: entry.weight }, () => entry.kind),
  );
  const kinds = [expanded[index % expanded.length]!];
  if (shape.include_cycles && index > 2 && index % 17 === 0) {
    kinds.push("related");
  }
  return [...new Set(kinds)];
}

/** Build one deterministic corpus item plan without filesystem side effects. */
export function buildCorpusShapeItemPlan(
  shape: Readonly<CorpusShape>,
  index: number,
  itemCount: number,
  seed = 42,
): CorpusShapeItemPlan {
  nonNegativeInteger(index, "item index");
  positiveInteger(itemCount, "item count");
  if (index >= itemCount) {
    throw new RangeError(`Corpus item index ${index} exceeds ${itemCount}`);
  }
  const component = index % Math.min(shape.component_count, itemCount);
  const componentOffset = component;
  const level =
    Math.floor(index / Math.max(1, shape.component_count)) %
    shape.hierarchy_depth;
  const parentIndex =
    level === 0
      ? undefined
      : Math.max(componentOffset, index - shape.component_count);
  const base = Date.UTC(2026, 0, 1);
  const spanMs = shape.age_span_days * 86_400_000;
  const timestamp = new Date(
    base +
      (itemCount === 1
        ? 0
        : Math.round((index / (itemCount - 1)) * spanMs)),
  ).toISOString();
  const annotationBucket = (index * 37 + seed) % 100;
  return {
    index,
    id: `pm-s${index.toString(36).padStart(7, "0")}`,
    ...(parentIndex === undefined
      ? {}
      : {
          parent: `pm-s${parentIndex.toString(36).padStart(7, "0")}`,
        }),
    component,
    timestamp,
    author: `pm-corpus-agent-${(index + seed) % Math.min(shape.author_cardinality, itemCount)}`,
    history_entry_count: shape.history_entries_per_item,
    dependency_kinds: selectedEdgeKinds(index, shape),
    has_comment: annotationBucket < shape.comments_per_100_items,
    has_note: annotationBucket < shape.notes_per_100_items,
    has_learning: annotationBucket < shape.learnings_per_100_items,
    ...(shape.custom_types.length > 0 && index % 11 === 0
      ? { custom_type: shape.custom_types[index % shape.custom_types.length] }
      : {}),
    ...(shape.custom_statuses.length > 0 && index % 13 === 0
      ? {
          custom_status:
            shape.custom_statuses[index % shape.custom_statuses.length],
        }
      : {}),
  };
}

/** Measure a generated plan and fail closed when declared invariants drift. */
export function measureCorpusShapePlan(
  shape: Readonly<CorpusShape>,
  plans: readonly CorpusShapeItemPlan[],
): CorpusShapeProfile {
  const authors = new Set(plans.map((plan) => plan.author));
  const components = new Set(plans.map((plan) => plan.component));
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  let observedDepth = 0;
  for (const plan of plans) {
    let depth = 1;
    let parent = plan.parent;
    const visited = new Set<string>();
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      depth += 1;
      parent = byId.get(parent)?.parent;
    }
    observedDepth = Math.max(observedDepth, depth);
  }
  const edgeKinds: Record<string, number> = {};
  for (const plan of plans) {
    for (const kind of plan.dependency_kinds) {
      edgeKinds[kind] = (edgeKinds[kind] ?? 0) + 1;
    }
  }
  const expectedAuthors = Math.min(shape.author_cardinality, plans.length);
  const expectedComponents = Math.min(shape.component_count, plans.length);
  const mismatches = [
    ...(authors.size === expectedAuthors
      ? []
      : [`author_count:${authors.size}!=${expectedAuthors}`]),
    ...(components.size === expectedComponents
      ? []
      : [`component_count:${components.size}!=${expectedComponents}`]),
    ...(observedDepth <= shape.hierarchy_depth
      ? []
      : [`hierarchy_depth:${observedDepth}>${shape.hierarchy_depth}`]),
    ...(plans.every(
      (plan) =>
        plan.history_entry_count === shape.history_entries_per_item,
    )
      ? []
      : ["history_entries_per_item:drift"]),
  ];
  const timestamps = plans.map((plan) => plan.timestamp).sort();
  return {
    shape: shape.name,
    item_count: plans.length,
    author_count: authors.size,
    component_count: components.size,
    hierarchy_depth: observedDepth,
    timestamp_range: {
      first: timestamps[0] ?? null,
      last: timestamps.at(-1) ?? null,
    },
    history_entry_count: plans.reduce(
      (total, plan) => total + plan.history_entry_count,
      0,
    ),
    annotations: {
      comments: plans.filter((plan) => plan.has_comment).length,
      notes: plans.filter((plan) => plan.has_note).length,
      learnings: plans.filter((plan) => plan.has_learning).length,
    },
    edge_kinds: edgeKinds,
    matches_declaration: mismatches.length === 0,
    mismatches,
  };
}
