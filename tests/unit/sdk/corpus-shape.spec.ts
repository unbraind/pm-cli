import { describe, expect, it } from "vitest";
import {
  BUILTIN_CORPUS_SHAPES,
  PM_CORPUS_SHAPE_SCHEMA,
  buildCorpusShapeItemPlan,
  defineCorpusShape,
  listBuiltinCorpusShapes,
  measureCorpusShapePlan,
  resolveBuiltinCorpusShape,
  type CorpusShape,
} from "../../../src/sdk/corpus-shape.js";

function validShape(overrides: Partial<CorpusShape> = {}): CorpusShape {
  return {
    schema: PM_CORPUS_SHAPE_SCHEMA,
    name: "test",
    description: "Test corpus shape",
    hierarchy_depth: 3,
    hierarchy_fanout: 2,
    age_span_days: 30,
    history_entries_per_item: 2,
    comments_per_100_items: 10,
    notes_per_100_items: 5,
    learnings_per_100_items: 3,
    edge_kind_mix: [{ kind: "related", weight: 1 }],
    author_cardinality: 4,
    component_count: 2,
    include_cycles: false,
    custom_types: [],
    custom_statuses: [],
    custom_fields: [],
    ...overrides,
  };
}

describe("corpus shape SDK", () => {
  it("publishes every named conformance population in stable order", () => {
    expect(listBuiltinCorpusShapes().map((shape) => shape.name)).toEqual([
      "deep-graph",
      "disconnected-archive",
      "multi-decade",
      "representative",
      "scratch",
    ]);
    expect(resolveBuiltinCorpusShape(" REPRESENTATIVE ")).toBe(
      BUILTIN_CORPUS_SHAPES.representative,
    );
    expect(() => resolveBuiltinCorpusShape("missing")).toThrow(
      /Available: scratch, representative, deep-graph, multi-decade, disconnected-archive/,
    );
  });

  it("validates shape declarations and detaches caller state", () => {
    const source = validShape();
    const defined = defineCorpusShape(source);
    source.name = "mutated";
    expect(defined.name).toBe("test");

    for (const invalid of [
      validShape({ schema: "bad" as typeof PM_CORPUS_SHAPE_SCHEMA }),
      validShape({ name: "" }),
      validShape({ description: "" }),
      validShape({ hierarchy_depth: 0 }),
      validShape({ hierarchy_fanout: 0 }),
      validShape({ age_span_days: -1 }),
      validShape({ history_entries_per_item: 0 }),
      validShape({ comments_per_100_items: -1 }),
      validShape({ notes_per_100_items: -1 }),
      validShape({ learnings_per_100_items: -1 }),
      validShape({ author_cardinality: 0 }),
      validShape({ component_count: 0 }),
      validShape({ edge_kind_mix: [] }),
      validShape({ edge_kind_mix: [{ kind: "", weight: 1 }] }),
      validShape({ edge_kind_mix: [{ kind: "related", weight: 0 }] }),
    ]) {
      expect(() => defineCorpusShape(invalid)).toThrow(/Corpus shape|Unsupported/);
    }
  });

  it("builds deterministic typed plans and measures declared invariants", () => {
    for (const shape of listBuiltinCorpusShapes()) {
      const plans = Array.from({ length: 100 }, (_, index) =>
        buildCorpusShapeItemPlan(shape, index, 100, 17),
      );
      expect(measureCorpusShapePlan(shape, plans)).toMatchObject({
        shape: shape.name,
        item_count: 100,
        author_count: Math.min(shape.author_cardinality, 100),
        component_count: Math.min(shape.component_count, 100),
        history_entry_count: 100 * shape.history_entries_per_item,
        matches_declaration: true,
        mismatches: [],
      });
      expect(plans[0]).toMatchObject({
        index: 0,
        id: "pm-s0000000",
        history_entry_count: shape.history_entries_per_item,
      });
      if (shape.age_span_days === 0) {
        expect(plans.at(-1)?.timestamp).toBe(plans[0]?.timestamp);
      } else {
        expect(plans.at(-1)?.timestamp).not.toBe(plans[0]?.timestamp);
      }
    }
  });

  it("fails item bounds and reports measured drift", () => {
    const shape = defineCorpusShape(validShape());
    expect(() => buildCorpusShapeItemPlan(shape, -1, 2)).toThrow(
      /non-negative/,
    );
    expect(() => buildCorpusShapeItemPlan(shape, 0, 0)).toThrow(/positive/);
    expect(() => buildCorpusShapeItemPlan(shape, 2, 2)).toThrow(/exceeds/);
    expect(buildCorpusShapeItemPlan(shape, 0, 1).timestamp).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    const plans = [
      buildCorpusShapeItemPlan(shape, 0, 2),
      {
        ...buildCorpusShapeItemPlan(shape, 1, 2),
        author: "unexpected",
        component: 0,
        history_entry_count: 99,
        parent: "pm-missing",
      },
    ];
    expect(measureCorpusShapePlan(shape, plans)).toMatchObject({
      matches_declaration: false,
      mismatches: expect.arrayContaining([
        "component_count:1!=2",
        "history_entries_per_item:drift",
      ]),
    });
    expect(
      measureCorpusShapePlan(shape, plans.map((plan) => ({ ...plan, author: "same" })))
        .mismatches,
    ).toContain("author_count:1!=2");
    expect(measureCorpusShapePlan(shape, [])).toMatchObject({
      timestamp_range: { first: null, last: null },
      matches_declaration: true,
    });

    const deepPlans = Array.from({ length: 4 }, (_, index) => ({
      ...buildCorpusShapeItemPlan(shape, index, 4),
      parent: index === 0 ? undefined : `pm-s${(index - 1).toString(36).padStart(7, "0")}`,
      author: `author-${index}`,
      component: index % 2,
    }));
    expect(measureCorpusShapePlan(shape, deepPlans).mismatches).toContain(
      "hierarchy_depth:4>3",
    );
    deepPlans[0] = { ...deepPlans[0], parent: deepPlans[1]?.id };
    expect(measureCorpusShapePlan(shape, deepPlans).hierarchy_depth).toBeGreaterThan(
      0,
    );
  });
});
