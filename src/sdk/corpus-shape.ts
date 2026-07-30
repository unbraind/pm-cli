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
  /** Custom statuses that should use terminal lifecycle semantics. */
  terminal_statuses: readonly string[];
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
  /** Observed maximum number of children assigned to one parent. */
  hierarchy_fanout: number;
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

/** Incremental corpus-profile measurement without retaining item plans. */
export interface CorpusShapeMeasurement {
  /** Add one generated plan in generation order. */
  add(plan: CorpusShapeItemPlan): void;
  /** Finish the measurement and return its conformance profile. */
  finish(): CorpusShapeProfile;
}

type ExactCorpusShape<Shape extends CorpusShape> = Shape &
  Record<Exclude<keyof Shape, keyof CorpusShape>, never>;

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      `Corpus shape ${field} must be a positive safe integer`,
    );
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
export function defineCorpusShape<const Shape extends CorpusShape>(
  shape: ExactCorpusShape<Shape>,
): Readonly<Shape> {
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
  if (
    shape.terminal_statuses.some(
      (status) => !shape.custom_statuses.includes(status),
    )
  ) {
    throw new TypeError(
      "Corpus shape terminal_statuses must be declared in custom_statuses",
    );
  }
  const detached: Shape = structuredClone(shape);
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
    terminal_statuses: [],
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
    terminal_statuses: [],
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
    terminal_statuses: [],
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
    terminal_statuses: ["archived"],
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
    terminal_statuses: ["archived"],
    custom_fields: ["archive_source"],
  }),
});

/** Return all built-in corpus-shape declarations in stable name order. */
export function listBuiltinCorpusShapes(): readonly Readonly<CorpusShape>[] {
  return Object.keys(BUILTIN_CORPUS_SHAPES)
    .sort()
    .map((name) => BUILTIN_CORPUS_SHAPES[name as BuiltinCorpusShapeName]);
}

/** Resolve one built-in corpus shape or reject an unknown name. */
export function resolveBuiltinCorpusShape(name: string): Readonly<CorpusShape> {
  const normalized = name.trim().toLowerCase() as BuiltinCorpusShapeName;
  if (!Object.hasOwn(BUILTIN_CORPUS_SHAPES, normalized)) {
    throw new TypeError(
      `Unknown corpus shape "${name}". Available: ${Object.keys(BUILTIN_CORPUS_SHAPES).join(", ")}`,
    );
  }
  return BUILTIN_CORPUS_SHAPES[normalized];
}

const expandedEdgeKinds = new WeakMap<
  Readonly<CorpusShape>,
  readonly string[]
>();

function selectedEdgeKinds(
  index: number,
  shape: Readonly<CorpusShape>,
): string[] {
  if (index === 0) {
    return [];
  }
  let expanded = expandedEdgeKinds.get(shape);
  if (expanded === undefined) {
    expanded = shape.edge_kind_mix.flatMap((entry) =>
      Array.from({ length: entry.weight }, () => entry.kind),
    );
    expandedEdgeKinds.set(shape, expanded);
  }
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
  const componentCount = Math.min(shape.component_count, itemCount);
  const component = index % componentCount;
  const componentPosition = Math.floor(index / componentCount);
  let hierarchyCapacity = 0;
  let levelWidth = 1;
  for (let depth = 0; depth < shape.hierarchy_depth; depth += 1) {
    hierarchyCapacity = Math.min(
      Number.MAX_SAFE_INTEGER,
      hierarchyCapacity + levelWidth,
    );
    levelWidth = Math.min(
      Number.MAX_SAFE_INTEGER,
      levelWidth * shape.hierarchy_fanout,
    );
  }
  const treeOffset = componentPosition % hierarchyCapacity;
  const treeStart = componentPosition - treeOffset;
  const parentIndex =
    treeOffset === 0
      ? undefined
      : component +
        (treeStart + Math.floor((treeOffset - 1) / shape.hierarchy_fanout)) *
          componentCount;
  const base = Date.UTC(2026, 0, 1);
  const spanMs = shape.age_span_days * 86_400_000;
  const timestamp = new Date(
    base +
      (itemCount === 1 ? 0 : Math.round((index / (itemCount - 1)) * spanMs)),
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

/** Stateful incremental measurement that bounds retained population metadata. */
class IncrementalCorpusShapeMeasurement implements CorpusShapeMeasurement {
  private readonly shape: Readonly<CorpusShape>;
  private readonly authors = new Set<string>();
  private readonly components = new Set<number>();
  private readonly depths = new Map<string, number>();
  private readonly childCounts = new Map<string, number>();
  private readonly edgeKinds: Record<string, number> = {};
  private readonly expectedEdgeKinds: Record<string, number> = {};
  private readonly annotations = { comments: 0, notes: 0, learnings: 0 };
  private readonly annotationFields;
  private readonly planMismatches: string[] = [];
  private itemCount = 0;
  private observedDepth = 0;
  private observedFanout = 0;
  private historyEntryCount = 0;
  private firstTimestamp: string | null = null;
  private lastTimestamp: string | null = null;

  /** Capture the declaration and its annotation-rate contracts. */
  constructor(shape: Readonly<CorpusShape>) {
    this.shape = shape;
    this.annotationFields = [
      ["comments", "has_comment", shape.comments_per_100_items],
      ["notes", "has_note", shape.notes_per_100_items],
      ["learnings", "has_learning", shape.learnings_per_100_items],
    ] as const;
  }

  /** Retain one deterministic conformance mismatch when its predicate fails. */
  private recordMismatch(mismatched: boolean, message: string): void {
    if (mismatched) this.planMismatches.push(message);
  }

  /** Accumulate a sequence of relationship kinds into one count table. */
  private recordEdgeKinds(
    counts: Record<string, number>,
    kinds: readonly string[],
  ): void {
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  }

  /** Add one generated plan in generation order. */
  add(plan: CorpusShapeItemPlan): void {
    this.itemCount += 1;
    this.authors.add(plan.author);
    this.components.add(plan.component);
    this.recordMismatch(this.depths.has(plan.id), `duplicate_id:${plan.id}`);
    let depth = 1;
    if (plan.parent !== undefined) {
      const parentDepth = this.depths.get(plan.parent);
      this.recordMismatch(
        parentDepth === undefined,
        `parent_missing:${plan.parent}`,
      );
      depth = (parentDepth ?? 0) + 1;
      const childCount = (this.childCounts.get(plan.parent) ?? 0) + 1;
      this.childCounts.set(plan.parent, childCount);
      this.observedFanout = Math.max(this.observedFanout, childCount);
    }
    this.depths.set(plan.id, depth);
    this.observedDepth = Math.max(this.observedDepth, depth);
    this.historyEntryCount += plan.history_entry_count;
    this.recordMismatch(
      plan.history_entry_count !== this.shape.history_entries_per_item,
      "history_entries_per_item:drift",
    );
    this.firstTimestamp =
      this.firstTimestamp === null || plan.timestamp < this.firstTimestamp
        ? plan.timestamp
        : this.firstTimestamp;
    this.lastTimestamp =
      this.lastTimestamp === null || plan.timestamp > this.lastTimestamp
        ? plan.timestamp
        : this.lastTimestamp;
    for (const [annotation, property] of this.annotationFields) {
      this.annotations[annotation] += Number(plan[property]);
    }
    this.recordEdgeKinds(this.edgeKinds, plan.dependency_kinds);
    this.recordEdgeKinds(
      this.expectedEdgeKinds,
      selectedEdgeKinds(plan.index, this.shape),
    );
  }

  /** Finish the measurement and return its conformance profile. */
  finish(): CorpusShapeProfile {
    const expectedAuthors = Math.min(
      this.shape.author_cardinality,
      this.itemCount,
    );
    const expectedComponents = Math.min(
      this.shape.component_count,
      this.itemCount,
    );
    const mismatches = [
      ...this.planMismatches,
      ...(this.itemCount === 0 ? ["item_count:empty"] : []),
      ...(this.authors.size === expectedAuthors
        ? []
        : [`author_count:${this.authors.size}!=${expectedAuthors}`]),
      ...(this.components.size === expectedComponents
        ? []
        : [`component_count:${this.components.size}!=${expectedComponents}`]),
      ...(this.observedDepth <= this.shape.hierarchy_depth
        ? []
        : [
            `hierarchy_depth:${this.observedDepth}>${this.shape.hierarchy_depth}`,
          ]),
      ...(this.observedFanout <= this.shape.hierarchy_fanout
        ? []
        : [
            `hierarchy_fanout:${this.observedFanout}>${this.shape.hierarchy_fanout}`,
          ]),
    ];
    for (const [annotation, , rate] of this.annotationFields) {
      const completeBuckets = Math.floor(this.itemCount / 100);
      const remainder = this.itemCount % 100;
      const minimum =
        completeBuckets * rate + Math.max(0, rate + remainder - 100);
      const maximum = completeBuckets * rate + Math.min(rate, remainder);
      const observed = this.annotations[annotation];
      if (observed < minimum || observed > maximum) {
        mismatches.push(`${annotation}:${observed}!in[${minimum},${maximum}]`);
      }
    }
    const edgeKindNames = new Set([
      ...Object.keys(this.edgeKinds),
      ...Object.keys(this.expectedEdgeKinds),
    ]);
    for (const kind of [...edgeKindNames].sort()) {
      const observed = this.edgeKinds[kind] ?? 0;
      const expected = this.expectedEdgeKinds[kind] ?? 0;
      if (observed !== expected) {
        mismatches.push(`edge_kind:${kind}:${observed}!=${expected}`);
      }
    }
    const uniqueMismatches = [...new Set(mismatches)];
    return {
      shape: this.shape.name,
      item_count: this.itemCount,
      author_count: this.authors.size,
      component_count: this.components.size,
      hierarchy_depth: this.observedDepth,
      hierarchy_fanout: this.observedFanout,
      timestamp_range: {
        first: this.firstTimestamp,
        last: this.lastTimestamp,
      },
      history_entry_count: this.historyEntryCount,
      annotations: { ...this.annotations },
      edge_kinds: { ...this.edgeKinds },
      matches_declaration: uniqueMismatches.length === 0,
      mismatches: uniqueMismatches,
    };
  }
}

/** Create an incremental measurement for a generated corpus population. */
export function createCorpusShapeMeasurement(
  shape: Readonly<CorpusShape>,
): CorpusShapeMeasurement {
  return new IncrementalCorpusShapeMeasurement(shape);
}

/** Measure a generated plan and fail closed when declared invariants drift. */
export function measureCorpusShapePlan(
  shape: Readonly<CorpusShape>,
  plans: readonly CorpusShapeItemPlan[],
): CorpusShapeProfile {
  const measurement = createCorpusShapeMeasurement(shape);
  for (const plan of plans) measurement.add(plan);
  return measurement.finish();
}
