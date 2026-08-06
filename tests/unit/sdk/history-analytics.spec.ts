import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendHistoryEntry } from "../../../src/core/history/history.js";
import type { HarnessSignalDescriptor } from "../../../src/core/shared/author.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import type { HistoryEntry } from "../../../src/types/index.js";
import {
  _testOnlyHistoryAnalytics,
  evaluateProvenanceCoverage,
  runFleetAttributionAnalytics,
  runProvenanceCoverageAnalytics,
} from "../../../src/sdk/history-analytics.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function historyEntry(ts: string, op: string, status?: string): HistoryEntry {
  return {
    ts,
    author: "agent",
    author_source: "detected",
    agent_harness: "codex",
    agent_model: "gpt-5.6-sol",
    agent_provenance: {
      model: { value: "gpt-5.6-sol", source: "environment" },
    },
    op,
    patch: status
      ? [{ op: "replace", path: "/metadata/status", value: status }]
      : [],
    before_hash: `${ts}-before`,
    after_hash: `${ts}-after`,
  };
}

describe("bounded immutable-history analytics", () => {
  it("makes undeclared and inert provenance dimensions observable", () => {
    const descriptors: HarnessSignalDescriptor[] = [
      {
        harness: "codex",
        provenance_environment_keys: { effort: ["CODEX_EFFORT"] },
        provenance_unavailable_dimensions: ["model", "role", "version"],
      },
    ];
    const entries = [
      {
        ...historyEntry("2026-08-05T10:00:00.000Z", "update"),
        agent_provenance: { effort: null },
      },
    ];
    expect(evaluateProvenanceCoverage(entries, descriptors, 1)).toMatchObject({
      inert: [{ harness: "codex", dimension: "effort", explicit_samples: 1 }],
      undeclared: expect.arrayContaining(["topic"]),
      warnings: expect.arrayContaining([
        "provenance_dimension_inert:codex:effort:1",
        "provenance_dimension_undeclared:topic",
      ]),
    });
  });

  it("derives honest fleet rates and defect escapes from indexed history", async () => {
    await withTempPmPath(async (context) => {
      const stream = path.join(context.pmPath, "history", "pm-source.jsonl");
      await appendHistoryEntry(
        stream,
        historyEntry("2026-08-05T10:00:00.000Z", "create", "open"),
      );
      await appendHistoryEntry(
        stream,
        historyEntry("2026-08-06T10:00:00.000Z", "close", "closed"),
      );
      await appendHistoryEntry(
        stream,
        historyEntry("2026-08-06T11:00:00.000Z", "comments_add"),
      );
      const result = await runFleetAttributionAnalytics(
        context.pmPath,
        [
          {
            id: "pm-regression",
            type: "Issue",
            dependencies: [{ id: "pm-source", kind: "discovered_from" }],
          },
        ],
        new Set(["closed", "canceled"]),
        {
          since: "2026-08-05T00:00:00.000Z",
          eventLimit: 100,
          minimumSample: 1,
        },
      );
      expect(result).toMatchObject({
        policy: "observational_only_not_for_authorization_or_routing",
        minimum_sample: 1,
        window: { source: "history_event_index", truncated: false },
      });
      expect(result.dimensions[0]).toMatchObject({
        dimension: "harness",
        status: "available",
        rows: [
          {
            value: "codex",
            events: 3,
            state_events: 2,
            annotation_events: 1,
            closes: 1,
            defect_escapes: 1,
            defect_escape_rate: 1,
            sample_status: "available",
          },
        ],
      });
      await expect(
        runProvenanceCoverageAnalytics(context.pmPath, undefined, {
          since: "2026-08-05T00:00:00.000Z",
          eventLimit: 100,
          minimumSample: 1,
        }),
      ).resolves.toMatchObject({
        observations: expect.arrayContaining([
          expect.objectContaining({
            harness: "codex",
            dimension: "model",
            observed: 3,
          }),
        ]),
      });
    });
  });

  it("validates bounded window controls and classifies event primitives", () => {
    expect(_testOnlyHistoryAnalytics.annotationOperation("note_add")).toBe(
      true,
    );
    expect(_testOnlyHistoryAnalytics.annotationOperation("update")).toBe(false);
    expect(
      _testOnlyHistoryAnalytics.statusFromEntry(
        historyEntry("2026-08-06T10:00:00.000Z", "update", "closed"),
      ),
    ).toBe("closed");
    expect(
      _testOnlyHistoryAnalytics.resolveHistoryAnalyticsSince("-1h"),
    ).toMatch(/Z$/u);
    expect(
      _testOnlyHistoryAnalytics.resolveHistoryAnalyticsSince(undefined),
    ).toMatch(/Z$/u);
    expect(
      _testOnlyHistoryAnalytics.parseHistoryAnalyticsLimit(undefined),
    ).toBe(10_000);
    expect(_testOnlyHistoryAnalytics.parseMinimumSample(undefined)).toBe(5);
    for (const invoke of [
      () => _testOnlyHistoryAnalytics.parseHistoryAnalyticsLimit(0),
      () => _testOnlyHistoryAnalytics.parseMinimumSample(0),
      () => _testOnlyHistoryAnalytics.resolveHistoryAnalyticsSince("invalid"),
      () => _testOnlyHistoryAnalytics.resolveHistoryAnalyticsSince("-0d"),
    ]) {
      expect(invoke).toThrowError(PmCliError);
      try {
        invoke();
      } catch (error) {
        expect((error as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
      }
    }
  });

  it("reports truncation, reopens, unavailable dimensions, and insufficient samples", async () => {
    await withTempPmPath(async (context) => {
      const stream = path.join(context.pmPath, "history", "pm-reopen.jsonl");
      await appendHistoryEntry(
        stream,
        historyEntry("2026-08-05T10:00:00.000Z", "create", "open"),
      );
      await appendHistoryEntry(
        stream,
        historyEntry("2026-08-05T11:00:00.000Z", "close", "closed"),
      );
      await appendHistoryEntry(
        stream,
        historyEntry("2026-08-05T12:00:00.000Z", "update", "open"),
      );
      const truncated = await runFleetAttributionAnalytics(
        context.pmPath,
        [
          { id: "pm-task", type: "Task" },
          {
            id: "pm-issue-empty",
            type: "Issue",
            dependencies: [{ id: "pm-never-closed", kind: "discovered_from" }],
          },
          { id: "pm-issue-without-dependencies", type: "Issue" },
        ],
        new Set(["closed"]),
        {
          since: "2026-08-05T00:00:00.000Z",
          eventLimit: 1,
          minimumSample: 2,
        },
      );
      expect(truncated.window).toMatchObject({
        events: 1,
        truncated: true,
        next_cursor: expect.any(String),
      });
      const complete = await runFleetAttributionAnalytics(
        context.pmPath,
        [],
        new Set(["closed"]),
        {
          since: "2026-08-05T00:00:00.000Z",
          eventLimit: 10,
          minimumSample: 2,
        },
      );
      expect(complete.dimensions[0].rows[0]).toMatchObject({
        reopens: 1,
        sample_status: "insufficient",
        throughput_per_day: null,
        rework_rate: null,
        defect_escape_rate: null,
      });

      const empty = await runFleetAttributionAnalytics(
        context.pmPath,
        [],
        new Set(["closed"]),
        { since: "2027-01-01T00:00:00.000Z" },
      );
      expect(empty.dimensions).toEqual([
        { dimension: "harness", status: "unavailable", rows: [] },
        { dimension: "model", status: "unavailable", rows: [] },
        { dimension: "author_source", status: "unavailable", rows: [] },
      ]);
    });
  });

  it("sorts equal event buckets and reads provenance fallbacks", () => {
    const codex = historyEntry("2026-08-05T10:00:00.000Z", "update");
    const aider = {
      ...historyEntry("2026-08-05T11:00:00.000Z", "update"),
      agent_harness: "aider",
      agent_model: undefined,
      agent_provenance: {
        model: { value: "model-b", source: "environment" as const },
      },
    };
    const dimension = _testOnlyHistoryAnalytics.buildFleetDimension(
      "harness",
      [
        { item_id: "pm-a", entry: codex },
        { item_id: "pm-b", entry: aider },
      ],
      [],
      new Set(["closed"]),
      1,
      1,
    );
    expect(dimension.rows.map((row) => row.value)).toEqual(["aider", "codex"]);
    expect(_testOnlyHistoryAnalytics.provenanceValue(aider, "model")).toBe(
      "model-b",
    );
    expect(
      _testOnlyHistoryAnalytics.provenanceValue(aider, "author_source"),
    ).toBe("detected");
    expect(_testOnlyHistoryAnalytics.statusFromEntry(codex)).toBeUndefined();
  });
});
