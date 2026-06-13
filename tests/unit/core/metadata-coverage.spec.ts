import { describe, expect, it } from "vitest";

import {
  COVERAGE_FIELD_ORDER,
  LIFECYCLE_BUCKET_ORDER,
  computeLifecycleDistribution,
  computeMetadataCoverage,
  emptyGroupLabel,
  filterMissingMetadata,
  groupItemsByDimension,
  hasMissingMetadataFilter,
  isAcMissing,
  isEstimateMissing,
  isResolutionMissing,
  itemMatchesMissingMetadata,
  lifecycleClassifierFromStatusRegistry,
  type CoverageItem,
  type GroupDimension,
  type StatusRegistryLike,
} from "../../../src/core/governance/metadata-coverage.js";

function buildRegistry(): StatusRegistryLike {
  const aliasToId = new Map<string, string>([
    ["open", "open"],
    ["in_progress", "in_progress"],
    ["wip", "in_progress"],
    ["blocked", "blocked"],
    ["closed", "closed"],
    ["done", "closed"],
    ["canceled", "canceled"],
    ["draft", "draft"],
  ]);
  return {
    alias_to_id: aliasToId,
    terminal_statuses: new Set(["closed", "canceled"]),
    terminal_canceled_statuses: new Set(["canceled"]),
    blocked_statuses: new Set(["blocked"]),
    draft_statuses: new Set(["draft"]),
    active_statuses: new Set(["open", "in_progress"]),
    open_status: "open",
  };
}

const classifier = lifecycleClassifierFromStatusRegistry(buildRegistry());

function item(overrides: Partial<CoverageItem> = {}): CoverageItem {
  return {
    type: "Task",
    status: "open",
    tags: [],
    ...overrides,
  };
}

describe("lifecycleClassifierFromStatusRegistry", () => {
  it("classifies each lifecycle bucket via disjoint precedence", () => {
    expect(classifier.classify("canceled")).toBe("canceled");
    expect(classifier.classify("closed")).toBe("closed");
    expect(classifier.classify("blocked")).toBe("blocked");
    expect(classifier.classify("draft")).toBe("draft");
    expect(classifier.classify("open")).toBe("open");
    expect(classifier.classify("in_progress")).toBe("in_progress");
    expect(classifier.classify("mystery")).toBe("other");
  });

  it("normalizes aliases and casing before classifying", () => {
    expect(classifier.classify("WIP")).toBe("in_progress");
    expect(classifier.classify("  done  ")).toBe("closed");
  });

  it("reports terminal statuses", () => {
    expect(classifier.isTerminal("closed")).toBe(true);
    expect(classifier.isTerminal("canceled")).toBe(true);
    expect(classifier.isTerminal("open")).toBe(false);
    expect(classifier.isTerminal("unknown")).toBe(false);
  });
});

describe("missing-metadata predicates", () => {
  it("isAcMissing treats empty/whitespace as missing", () => {
    expect(isAcMissing(item())).toBe(true);
    expect(isAcMissing(item({ acceptance_criteria: "   " }))).toBe(true);
    expect(isAcMissing(item({ acceptance_criteria: "Given X" }))).toBe(false);
  });

  it("isEstimateMissing requires a finite number", () => {
    expect(isEstimateMissing(item())).toBe(true);
    expect(isEstimateMissing(item({ estimated_minutes: Number.NaN }))).toBe(true);
    expect(isEstimateMissing(item({ estimated_minutes: 0 }))).toBe(false);
    expect(isEstimateMissing(item({ estimated_minutes: 60 }))).toBe(false);
  });

  it("isResolutionMissing only applies to terminal items", () => {
    expect(isResolutionMissing(item({ status: "open" }), classifier)).toBe(false);
    expect(isResolutionMissing(item({ status: "closed" }), classifier)).toBe(true);
    expect(isResolutionMissing(item({ status: "closed", resolution: "fixed" }), classifier)).toBe(false);
  });
});

describe("itemMatchesMissingMetadata / filterMissingMetadata", () => {
  it("passes everything when no filter is requested", () => {
    expect(hasMissingMetadataFilter({})).toBe(false);
    expect(itemMatchesMissingMetadata(item({ acceptance_criteria: "x" }), {}, classifier)).toBe(true);
    const items = [item(), item({ acceptance_criteria: "x" })];
    expect(filterMissingMetadata(items, {}, classifier)).toEqual(items);
    expect(filterMissingMetadata(items, {}, classifier)).not.toBe(items);
  });

  it("ANDs specific flags together", () => {
    const both = item({ status: "closed" });
    expect(itemMatchesMissingMetadata(both, { acMissing: true, estimatesMissing: true }, classifier)).toBe(true);
    expect(
      itemMatchesMissingMetadata(item({ acceptance_criteria: "x" }), { acMissing: true }, classifier),
    ).toBe(false);
    expect(
      itemMatchesMissingMetadata(item({ estimated_minutes: 60 }), { estimatesMissing: true }, classifier),
    ).toBe(false);
    expect(
      itemMatchesMissingMetadata(item({ status: "open" }), { resolutionMissing: true }, classifier),
    ).toBe(false);
  });

  it("treats metadataMissing as a union shortcut", () => {
    expect(itemMatchesMissingMetadata(item(), { metadataMissing: true }, classifier)).toBe(true);
    const complete = item({ acceptance_criteria: "x", estimated_minutes: 1, status: "open" });
    expect(itemMatchesMissingMetadata(complete, { metadataMissing: true }, classifier)).toBe(false);
  });

  it("filters lists by predicate", () => {
    const items = [
      item({ acceptance_criteria: "x", estimated_minutes: 1 }),
      item(),
    ];
    expect(filterMissingMetadata(items, { acMissing: true }, classifier)).toHaveLength(1);
  });
});

describe("computeMetadataCoverage", () => {
  it("computes overall and per-type coverage with resolution scoped to terminal items", () => {
    const items: CoverageItem[] = [
      item({ type: "Task", acceptance_criteria: "a", estimated_minutes: 30, tags: ["x"], parent: "pm-1" }),
      item({ type: "Task", status: "closed", resolution: "done" }),
      item({ type: "Bug", status: "closed" }),
    ];
    const report = computeMetadataCoverage(items, classifier);

    // acceptance_criteria: 1 of 3 present.
    expect(report.overall.acceptance_criteria).toEqual({ present: 1, applicable: 3, percent: 33.3 });
    // resolution applies only to the 2 terminal items; 1 present.
    expect(report.overall.resolution).toEqual({ present: 1, applicable: 2, percent: 50 });
    // tags: 1 present, parent: 1 present.
    expect(report.overall.tags.present).toBe(1);
    expect(report.overall.parent.present).toBe(1);

    expect(report.by_type.Bug.acceptance_criteria).toEqual({ present: 0, applicable: 1, percent: 0 });
    expect(report.by_type.Task.resolution).toEqual({ present: 1, applicable: 1, percent: 100 });
  });

  it("reports 100% when a field has no applicable items", () => {
    const report = computeMetadataCoverage([item({ status: "open" })], classifier);
    // No terminal items → resolution applicable=0 → percent defaults to 100.
    expect(report.overall.resolution).toEqual({ present: 0, applicable: 0, percent: 100 });
  });

  it("exposes a stable field order", () => {
    expect(COVERAGE_FIELD_ORDER).toEqual([
      "acceptance_criteria",
      "estimated_minutes",
      "resolution",
      "tags",
      "parent",
    ]);
  });
});

describe("groupItemsByDimension", () => {
  it("groups by assignee with an explicit unassigned label, sorted by total desc", () => {
    const items = [
      item({ assignee: "alice", status: "open" }),
      item({ assignee: "alice", status: "closed" }),
      item({ status: "open" }),
    ];
    const result = groupItemsByDimension(items, "assignee", classifier);
    expect(result.total_items).toBe(3);
    expect(result.rows[0]).toMatchObject({ label: "alice", key: "alice", total: 2 });
    expect(result.rows[0].buckets.open).toBe(1);
    expect(result.rows[0].buckets.closed).toBe(1);
    expect(result.rows[1]).toMatchObject({ label: "(unassigned)", key: null, total: 1 });
  });

  it("groups by tag, expanding multi-tag items and honoring tagPrefix", () => {
    const items = [
      item({ tags: ["domain:game", "layer:server"], status: "open" }),
      item({ tags: ["domain:infra"], status: "closed" }),
      item({ tags: ["other:thing"], status: "open" }),
    ];
    const result = groupItemsByDimension(items, "tag", classifier, { tagPrefix: "domain:" });
    const labels = result.rows.map((row) => row.label);
    expect(labels).toContain("domain:game");
    expect(labels).toContain("domain:infra");
    // The third item has no domain: tag → falls into (untagged).
    expect(labels).toContain("(untagged)");
    expect(labels).not.toContain("layer:server");
  });

  it("treats items with no tags array as untagged", () => {
    const result = groupItemsByDimension([{ type: "Task", status: "open" }], "tag", classifier);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ label: "(untagged)", key: null, total: 1 });
  });

  it("groups by priority, parent, type, and status", () => {
    const byPriority = groupItemsByDimension(
      [item({ priority: 1 }), item({})],
      "priority",
      classifier,
    );
    expect(byPriority.rows.map((r) => r.label).sort()).toEqual(["(no priority)", "P1"]);

    const byParent = groupItemsByDimension([item({ parent: "pm-1" }), item({})], "parent", classifier);
    expect(byParent.rows.map((r) => r.label)).toContain("(unparented)");

    const byType = groupItemsByDimension([item({ type: "Bug" })], "type", classifier);
    expect(byType.rows[0].label).toBe("Bug");

    const byStatus = groupItemsByDimension([item({ status: "closed" })], "status", classifier);
    expect(byStatus.rows[0].label).toBe("closed");
  });

  it("falls back to explicit labels when type/status keys are blank", () => {
    const byType = groupItemsByDimension([{ type: "", status: "open" }], "type", classifier);
    expect(byType.rows[0]).toMatchObject({ label: "(untyped)", key: null });

    const byStatus = groupItemsByDimension([{ type: "Task", status: "" }], "status", classifier);
    expect(byStatus.rows[0]).toMatchObject({ label: "(no status)", key: null });
  });

  it("sorts the empty group last when totals tie", () => {
    const items = [item({ assignee: "zed" }), item({})];
    const result = groupItemsByDimension(items, "assignee", classifier);
    expect(result.rows.map((r) => r.label)).toEqual(["zed", "(unassigned)"]);
  });

  it("sorts ties by label and keeps a real key ahead of the empty group", () => {
    const items = [item({ assignee: "bob" }), item({ assignee: "amy" })];
    const result = groupItemsByDimension(items, "assignee", classifier);
    expect(result.rows.map((r) => r.label)).toEqual(["amy", "bob"]);

    const tieWithEmpty = groupItemsByDimension([item({}), item({ assignee: "amy" })], "assignee", classifier);
    expect(tieWithEmpty.rows.map((r) => r.label)).toEqual(["amy", "(unassigned)"]);
  });
});

describe("labels, distribution, and constants", () => {
  it("exposes explicit empty-group labels per dimension", () => {
    const dimensions: GroupDimension[] = ["assignee", "priority", "tag", "parent", "type", "status"];
    expect(dimensions.map((d) => emptyGroupLabel(d))).toEqual([
      "(unassigned)",
      "(no priority)",
      "(untagged)",
      "(unparented)",
      "(untyped)",
      "(no status)",
    ]);
  });

  it("computes a lifecycle distribution across all buckets", () => {
    const dist = computeLifecycleDistribution(
      [item({ status: "open" }), item({ status: "in_progress" }), item({ status: "closed" })],
      classifier,
    );
    expect(dist.open).toBe(1);
    expect(dist.in_progress).toBe(1);
    expect(dist.closed).toBe(1);
    expect(dist.canceled).toBe(0);
    expect(LIFECYCLE_BUCKET_ORDER).toHaveLength(7);
  });
});
