import { describe, expect, it } from "vitest";
import type { AssuranceItemRecord } from "../../../../src/sdk/governance/assurance.js";
import {
  analyzeDefectChangeRisk,
  buildDefectRecurrenceIndex,
  type DefectRecurrencePolicy,
} from "../../../../src/sdk/governance/defect-recurrence.js";
import {
  analyzeDefectRecurrenceCoverage,
  parseDefectRecurrenceCoverageRequest,
} from "../../../../src/sdk/governance/defect-recurrence-coverage.js";

import { buildDefectRecurrenceGraph } from "../../../../src/sdk/governance/defect-recurrence-graph.js";

const policy: DefectRecurrencePolicy = {
  version: 1,
  evidence_epoch: "2026-08-17T00:00:00.000Z",
  families: [
    {
      id: "health-verdict",
      version: 1,
      title: "Health verdict authority",
      owner_item_id: "pm-owner",
      escape_class: "production_defect",
      triggers: { item_ids: ["pm-first"] },
      historical_item_ids: ["pm-first"],
      checks: { local: ["node test-health.mjs"], hosted: ["CI / health"] },
      negative_control: { item_ids: ["pm-first"] },
      budget: { max_escape_rate: 0, max_false_positive_rate: 0.05 },
    },
  ],
};
const first = {
  id: "pm-first",
  status: "closed",
  type: "Issue",
  escape_class: "production_defect",
};
const second = {
  id: "pm-second",
  status: "open",
  type: "Issue",
  dependencies: [{ id: first.id, kind: "recurs_from" }],
  files: [{ path: "src/health-next.ts", scope: "project" }],
};

describe("recorded recurrence lineages", () => {
  it("orders inherited and direct reasons together by signal, value and match", () => {
    const mixedPolicy: DefectRecurrencePolicy = { ...policy, families: [{ ...policy.families[0]!, triggers: {
      item_ids: [first.id], file_patterns: ["src/*"], package_names: ["pm-health"], tags: ["assurance"],
    } }] };
    const index = buildDefectRecurrenceIndex(mixedPolicy, [first, { ...second, files: [{ path: "src/z.ts" }, { path: "src/a.ts" }] }]);
    const report = analyzeDefectChangeRisk(index, { files: ["src/z.ts", "src/a.ts"], item_ids: [second.id], package_names: ["pm-health"], tags: ["assurance"] });
    expect(report.items[0]?.reasons).toEqual([
      { signal: "file", value: "src/a.ts", matched: "recurs_from:health-verdict" },
      { signal: "file", value: "src/a.ts", matched: "src/*" },
      { signal: "file", value: "src/z.ts", matched: "recurs_from:health-verdict" },
      { signal: "file", value: "src/z.ts", matched: "src/*" },
      { signal: "item", value: second.id, matched: "health-verdict" },
      { signal: "package", value: "pm-health", matched: "pm-health" },
      { signal: "tag", value: "assurance", matched: "assurance" },
    ]);
  });

  it("counts duplicate targets once while preserving reciprocal and self edges", () => {
    const graph = buildDefectRecurrenceGraph(policy.families, new Map([
      ["pm-first", { targets: ["pm-first", "pm-first", "pm-second", "pm-second"], files: [] }],
      ["pm-second", { targets: ["pm-first"], files: [] }],
    ]));
    expect(graph.edge_count).toBe(3);
    expect(graph.lineages).toHaveLength(1);
    expect(graph.lineages[0]?.item_ids).toEqual(["pm-first", "pm-second"]);
  });

  it("normalizes recurrence targets and linked file paths before inheriting checks", () => {
    const spaced = { ...second,
      dependencies: [{ id: ` ${first.id} `, kind: "recurs_from" }],
      files: [{ path: " src/health-next.ts ", scope: "project" }],
    };
    const index = buildDefectRecurrenceIndex(policy, [first, spaced]);
    expect(analyzeDefectChangeRisk(index, { files: ["src/health-next.ts"] })).toMatchObject({
      risk_detected: true, required_local_checks: ["node test-health.mjs"],
    });
    expect(analyzeDefectRecurrenceCoverage(policy, [first, spaced])).toMatchObject({
      ok: true, population: { item_count: 2, missing_item_count: 0 },
    });
  });

  it("inherits a registered family's checks through recorded edges and linked files", () => {
    const index = buildDefectRecurrenceIndex(policy, [first, second]);
    for (const change of [
      { item_ids: [second.id] },
      { files: ["src/health-next.ts"] },
    ]) {
      expect(analyzeDefectChangeRisk(index, change)).toMatchObject({
        risk_detected: true,
        required_local_checks: ["node test-health.mjs"],
        required_hosted_checks: ["CI / health"],
      });
    }
    expect(
      analyzeDefectChangeRisk(index, { files: ["src/unrelated.ts"] })
        .risk_detected,
    ).toBe(false);
    expect(
      analyzeDefectRecurrenceCoverage(policy, [first, second]),
    ).toMatchObject({
      ok: true,
      population: {
        item_count: 2,
        covered_item_count: 2,
        uncovered_item_count: 0,
        unclassified_item_count: 1,
      },
    });
  });

  it("names unregistered recurrence items without treating unrelated items as defects", () => {
    const uncovered = {
      ...second,
      id: "pm-third",
      dependencies: [{ id: "pm-fourth", kind: "recurs_from" }],
    };
    const items = [
      first,
      second,
      uncovered,
      { ...first, id: "pm-fourth" },
      { ...first, id: "pm-unrelated" },
    ];
    const report = analyzeDefectRecurrenceCoverage(policy, items, {
      limit: 1,
      uncoveredOnly: true,
    });
    expect(report).toMatchObject({
      ok: false,
      total: 2,
      population: {
        item_count: 4,
        covered_item_count: 2,
        uncovered_item_count: 2,
      },
    });
    expect(report.items[0]?.item_id).toBe("pm-fourth");
    expect(report.next_cursor).toBeTypeOf("string");
    const next = analyzeDefectRecurrenceCoverage(policy, items, {
      limit: 1,
      uncoveredOnly: true,
      cursor: report.next_cursor,
    });
    expect(next.items.map((row) => row.item_id)).toEqual(["pm-third"]);
    expect(next.next_cursor).toBeUndefined();
  });

  it("invalidates inherited checks when a recurrence edge is removed incrementally", () => {
    const initial = buildDefectRecurrenceIndex(policy, [first, second]);
    const disconnected = { ...second, dependencies: [] };
    const updated = buildDefectRecurrenceIndex(policy, [disconnected], {
      previous_index: initial,
      changed_item_ids: [second.id],
    });
    const rebuilt = buildDefectRecurrenceIndex(policy, [first, disconnected]);
    expect(updated.index_fingerprint).toBe(rebuilt.index_fingerprint);
    expect(updated.index_fingerprint).not.toBe(initial.index_fingerprint);
    expect(
      analyzeDefectChangeRisk(updated, {
        files: ["src/health-next.ts"],
        item_ids: [second.id],
      }).risk_detected,
    ).toBe(false);
  });
  it("traverses deep cyclic evidence and ignores association or external references", () => {
    const items = Array.from({ length: 12000 }, (_, index) => ({
      id: index === 0 ? first.id : `pm-deep-${index}`,
      status: "closed",
      type: "Issue",
      dependencies: [
        {
          kind: "recurs_from",
          id:
            index === 1
              ? first.id
              : index === 0
                ? "pm-deep-11999"
                : `pm-deep-${index - 1}`,
        },
      ],
      escape_class: "production_defect",
    }));
    const report = analyzeDefectRecurrenceCoverage(
      policy,
      [
        ...items,
        {
          id: "pm-associated",
          status: "open",
          type: "Issue",
          dependencies: [{ kind: "related", id: first.id }],
        },
        {
          id: "pm-external",
          status: "open",
          type: "Issue",
          dependencies: [
            { kind: "recurs_from", id: first.id, source_kind: "external" },
          ],
        },
      ],
      { limit: 1 },
    );
    expect(report.population).toMatchObject({
      item_count: 12000,
      edge_count: 12000,
      lineage_count: 1,
      covered_item_count: 12000,
      escape_rate: 1,
    });
    expect(report.items).toHaveLength(1);
    expect(report.ok).toBe(true);
  });

  it("distinguishes missing references and unknown classifications without certifying a zero escape rate", () => {
    const items = [{ ...second, escape_class: "unrecognized" }];
    const report = analyzeDefectRecurrenceCoverage(policy, items);
    expect(report).toMatchObject({
      ok: false,
      population: {
        missing_item_count: 1,
        classified_item_count: 0,
        unclassified_item_count: 2,
        escape_rate: null,
        escape_rate_lower_bound: 0,
      },
    });
    expect(report.items.find((row) => row.item_id === first.id)?.finding).toBe(
      "missing_recurrence_item",
    );
    expect(
      analyzeDefectRecurrenceCoverage(policy, []).population.escape_rate,
    ).toBeNull();
    expect(() =>
      analyzeDefectRecurrenceCoverage(policy, [first, first]),
    ).toThrow("Duplicate recurrence item");
  });

  it("binds paging to the complete graph and filter but allows a different row limit", () => {
    const items = [first, second];
    const initial = analyzeDefectRecurrenceCoverage(policy, items, {
      limit: 1,
    });
    expect(
      analyzeDefectRecurrenceCoverage(policy, [...items].reverse()).fingerprint,
    ).toBe(initial.fingerprint);
    expect(
      analyzeDefectRecurrenceCoverage(policy, items, {
        cursor: initial.next_cursor,
        limit: 100,
      }).items,
    ).toHaveLength(1);
    for (const changed of [
      [{ ...first, escape_class: "nightly_regression" }, second],
      [first, { ...second, files: [] }],
      [first, { ...second, dependencies: [] }],
    ])
      expect(() =>
        analyzeDefectRecurrenceCoverage(policy, changed, {
          cursor: initial.next_cursor,
        }),
      ).toThrow("does not match");
    expect(() =>
      analyzeDefectRecurrenceCoverage(policy, items, {
        cursor: initial.next_cursor,
        uncoveredOnly: true,
      }),
    ).toThrow("does not match");
    const pastEnd = Buffer.from(
      JSON.stringify({ fingerprint: initial.fingerprint, offset: 3 }),
    ).toString("base64url");
    expect(() =>
      analyzeDefectRecurrenceCoverage(policy, items, { cursor: pastEnd }),
    ).toThrow("exceeds");
    for (const cursor of [
      "invalid",
      Buffer.from("null").toString("base64url"),
      Buffer.from(
        JSON.stringify({ fingerprint: initial.fingerprint, offset: -1 }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ fingerprint: initial.fingerprint, offset: "1" }),
      ).toString("base64url"),
    ]) {
      expect(() =>
        analyzeDefectRecurrenceCoverage(policy, items, { cursor }),
      ).toThrow("cursor");
    }
  });

  it("validates transport requests and rejects unsafe limits", () => {
    expect(() => parseDefectRecurrenceCoverageRequest({ policy, change: {} })).toThrow("does not accept change");
    expect(parseDefectRecurrenceCoverageRequest({ policy })).toEqual({
      policy,
    });
    expect(
      parseDefectRecurrenceCoverageRequest({
        policy,
        limit: 1,
        cursor: "next",
        uncoveredOnly: true,
      }),
    ).toEqual({ policy, limit: 1, cursor: "next", uncoveredOnly: true });
    for (const value of [null, [], 1])
      expect(() => parseDefectRecurrenceCoverageRequest(value)).toThrow(
        "object",
      );
    expect(() =>
      parseDefectRecurrenceCoverageRequest({ policy, uncoveredOnly: "true" }),
    ).toThrow("boolean");
    for (const limit of [0, 101, 1.1, Number.NaN])
      expect(() =>
        analyzeDefectRecurrenceCoverage(policy, [], { limit }),
      ).toThrow("limit");
  });

  it("rejects malformed relationship evidence and keeps global linked files out of change triggers", () => {
    const malformed = {
      ...second,
      dependencies: [
        null,
        [],
        4,
        {},
        { kind: "recurs_from", id: "" },
        { kind: "recurs_from", id: 4 },
        { kind: "recurs_from", id: first.id },
        { kind: "recurs_from", id: first.id },
      ],
      files: [
        null,
        [],
        4,
        {},
        { path: "global.ts", scope: "global" },
        { path: "z.ts" },
        { path: "a.ts", scope: "project" },
      ],
    } as unknown as AssuranceItemRecord;
    const uncovered = {
      ...second,
      id: "pm-zzz",
      dependencies: [{ kind: "recurs_from", id: "pm-yyy" }],
    };
    const items = [uncovered, malformed, first];
    const coverage = analyzeDefectRecurrenceCoverage(policy, items);
    expect(coverage.population).toMatchObject({
      edge_count: 2,
      lineage_count: 2,
      missing_item_count: 1,
      uncovered_item_count: 2,
    });
    const index = buildDefectRecurrenceIndex(policy, items);
    expect(Object.keys(index.file_families ?? {})).toEqual(["a.ts", "z.ts"]);
    expect(
      analyzeDefectChangeRisk(index, {
        files: ["global.ts"],
        item_ids: [uncovered.id],
      }).risk_detected,
    ).toBe(false);
    expect(
      analyzeDefectChangeRisk(index, { files: ["a.ts", "z.ts"] })
        .required_local_checks,
    ).toEqual(["node test-health.mjs"]);
    const noArrays = {
      ...second,
      dependencies: {},
      files: {},
    } as unknown as AssuranceItemRecord;
    expect(
      analyzeDefectRecurrenceCoverage(policy, [noArrays]).population.item_count,
    ).toBe(0);
  });

  it("excludes canonical global provenance and cross-system locators from local coverage", () => {
    const external = [
      { id: first.id, source_kind: "global" },
      { id: first.id, source_kind: " EXTERNAL " },
      { id: "https://example.test/items/1" },
      { id: "github:example/repo#1" },
    ].map((edge, index) => ({
      id: `pm-external-${index}`,
      status: "open",
      type: "Issue",
      dependencies: [{ kind: "recurs_from", ...edge }],
    }));
    expect(
      analyzeDefectRecurrenceCoverage(policy, [first, ...external]),
    ).toMatchObject({
      ok: true,
      population: { item_count: 0, edge_count: 0 },
    });
    const malformedSource = {
      ...second,
      dependencies: [{ kind: "recurs_from", id: first.id, source_kind: 4 }],
    } as unknown as AssuranceItemRecord;
    expect(
      analyzeDefectRecurrenceCoverage(policy, [first, malformedSource])
        .population.item_count,
    ).toBe(2);
  });

  it("accepts a legacy sparse index and preserves independent lineages across incremental updates", () => {
    const initial = buildDefectRecurrenceIndex(policy, [first]);
    const { recurrence_records: _records, ...legacy } = initial;
    const upgraded = buildDefectRecurrenceIndex(policy, [second], {
      previous_index: legacy,
      changed_item_ids: [second.id],
    });
    expect(
      analyzeDefectChangeRisk(upgraded, { item_ids: [second.id] })
        .risk_detected,
    ).toBe(true);
    const changed = { ...second, files: [{ path: "z.ts" }, { path: "a.ts" }] };
    const extra = { ...second, id: "pm-third", files: [{ path: "other.ts" }] };
    const baseline = buildDefectRecurrenceIndex(policy, [first, second, extra]);
    const incremental = buildDefectRecurrenceIndex(policy, [changed], {
      previous_index: baseline,
      changed_item_ids: [second.id],
    });
    expect(incremental.index_fingerprint).toBe(
      buildDefectRecurrenceIndex(policy, [extra, first, changed])
        .index_fingerprint,
    );
    expect(
      analyzeDefectChangeRisk(incremental, { files: ["other.ts", "z.ts"] })
        .risk_detected,
    ).toBe(true);
  });
  it("retains prototype-named item identifiers during incremental lineage propagation", () => {
    const initial = buildDefectRecurrenceIndex(policy, [first]);
    const recurring = { ...second, id: "__proto__" };
    const incremental = buildDefectRecurrenceIndex(policy, [recurring], {
      previous_index: initial,
      changed_item_ids: [recurring.id],
    });
    expect(Object.hasOwn(incremental.item_families, recurring.id)).toBe(true);
    expect(incremental.index_fingerprint).toBe(
      buildDefectRecurrenceIndex(policy, [first, recurring]).index_fingerprint,
    );
  });
});
