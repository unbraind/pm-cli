import { describe, expect, it } from "vitest";

import {
  diffTestRunMeasurements,
  parseTestRunMeasurements,
  queryTestRunMeasurementsBelow,
} from "../../../src/sdk/test/measurements";
import type { ItemTestRunSummary } from "../../../src/types";

const BASE_RUN: ItemTestRunSummary = {
  run_id: "run-1",
  kind: "test",
  status: "passed",
  started_at: "2026-07-29T00:00:00.000Z",
  finished_at: "2026-07-29T00:00:01.000Z",
  recorded_at: "2026-07-29T00:00:01.000Z",
  passed: 1,
  failed: 0,
  skipped: 0,
};

describe("SDK test-run measurements", () => {
  it("parses, deduplicates, sorts, and timestamps typed evidence", () => {
    expect(parseTestRunMeasurements(undefined, BASE_RUN.recorded_at)).toEqual(
      [],
    );
    expect(
      parseTestRunMeasurements(
        [
          "latency=12.5,unit=ms,threshold=20,coverage=99.5,unit=percent",
          "coverage=100,unit=percent,threshold=100",
        ],
        BASE_RUN.recorded_at,
      ),
    ).toEqual([
      {
        name: "coverage",
        value: 100,
        unit: "percent",
        threshold: 100,
        recorded_at: BASE_RUN.recorded_at,
      },
      {
        name: "latency",
        value: 12.5,
        unit: "ms",
        threshold: 20,
        recorded_at: BASE_RUN.recorded_at,
      },
    ]);
  });

  it("rejects malformed values and attributes", () => {
    expect(() =>
      parseTestRunMeasurements(["coverage=not-a-number"], BASE_RUN.recorded_at),
    ).toThrow(/Invalid --measure/);
    expect(() =>
      parseTestRunMeasurements(["coverage=100,unit="], BASE_RUN.recorded_at),
    ).toThrow(/Invalid --measure attribute/);
  });

  it("filters below thresholds and diffs the newest two values", () => {
    const runs: ItemTestRunSummary[] = [
      {
        ...BASE_RUN,
        measurements: [
          {
            name: "coverage",
            value: 98,
            unit: "percent",
            recorded_at: BASE_RUN.recorded_at,
          },
        ],
      },
      {
        ...BASE_RUN,
        run_id: "run-2",
        recorded_at: "2026-07-29T01:00:01.000Z",
        measurements: [
          {
            name: "coverage",
            value: 100,
            unit: "percent",
            recorded_at: "2026-07-29T01:00:01.000Z",
          },
        ],
      },
    ];
    expect(queryTestRunMeasurementsBelow(runs, "coverage", 100)).toEqual([
      expect.objectContaining({ run_id: "run-1", value: 98 }),
    ]);
    expect(diffTestRunMeasurements(runs, "coverage")).toEqual({
      name: "coverage",
      latest: 100,
      previous: 98,
      delta: 2,
      unit: "percent",
    });
    expect(diffTestRunMeasurements(runs, "latency")).toEqual({
      name: "latency",
      latest: null,
      previous: null,
      delta: null,
      unit: undefined,
    });
    expect(
      queryTestRunMeasurementsBelow(
        [{ ...BASE_RUN, measurements: undefined }],
        "coverage",
        100,
      ),
    ).toEqual([]);
    expect(
      diffTestRunMeasurements(
        [{ ...BASE_RUN, measurements: undefined }],
        "coverage",
      ),
    ).toMatchObject({ latest: null, previous: null, delta: null });
  });
});
