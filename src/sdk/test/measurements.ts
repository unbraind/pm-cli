/**
 * @module sdk/test/measurements
 *
 * Defines universal numeric evidence primitives for linked verification runs.
 */
import type {
  ItemTestRunSummary,
  TestRunMeasurement,
} from "../../types/index.js";
import { EXIT_CODE, PmCliError } from "../runtime-primitives.js";

/** Maximum measurements retained on one run summary. */
export const TEST_RUN_MEASUREMENT_LIMIT = 32;

/** One latest-versus-previous metric comparison. */
export interface TestRunMeasurementDiff {
  /** Metric selected by the caller. */
  name: string;
  /** Latest recorded value, or null when no value exists. */
  latest: number | null;
  /** Previous recorded value, or null when fewer than two values exist. */
  previous: number | null;
  /** Latest minus previous, or null when a comparison is unavailable. */
  delta: number | null;
  /** Unit from the latest available measurement. */
  unit?: string;
}

function splitTestRunMeasurementSpecs(values: string[] | undefined): string[] {
  const specs: string[] = [];
  for (const raw of values ?? []) {
    let current: string[] = [];
    for (const segment of raw.split(",")) {
      const key = segment.slice(0, segment.indexOf("=")).trim();
      if (current.length > 0 && key !== "unit" && key !== "threshold") {
        specs.push(current.join(","));
        current = [];
      }
      current.push(segment);
    }
    specs.push(current.join(","));
  }
  return specs;
}

/** Parse repeatable `name=value[,unit=...][,threshold=...]` CLI evidence. */
export function parseTestRunMeasurements(
  values: string[] | undefined,
  recordedAt: string,
): TestRunMeasurement[] {
  const measurements = splitTestRunMeasurementSpecs(values).map((raw) => {
    const [metricPair, ...attributes] = raw.split(",");
    const separator = metricPair.indexOf("=");
    const name = metricPair.slice(0, separator).trim();
    const valueText = metricPair.slice(separator + 1).trim();
    const value = Number(valueText);
    if (
      separator <= 0 ||
      name.length === 0 ||
      valueText.length === 0 ||
      !Number.isFinite(value)
    ) {
      throw new PmCliError(
        `Invalid --measure "${raw}"; expected name=value[,unit=...][,threshold=...]`,
        EXIT_CODE.USAGE,
      );
    }
    let unit: string | undefined;
    let threshold: number | undefined;
    for (const attribute of attributes) {
      const attributeSeparator = attribute.indexOf("=");
      const key = attribute.slice(0, attributeSeparator).trim();
      const attributeValue = attribute.slice(attributeSeparator + 1).trim();
      if (key === "unit" && attributeValue.length > 0) {
        unit = attributeValue;
      } else if (
        key === "threshold" &&
        attributeValue.length > 0 &&
        Number.isFinite(Number(attributeValue))
      ) {
        threshold = Number(attributeValue);
      } else {
        throw new PmCliError(
          `Invalid --measure attribute "${attribute}"`,
          EXIT_CODE.USAGE,
        );
      }
    }
    return {
      name,
      value,
      unit,
      threshold,
      recorded_at: recordedAt,
    };
  });
  const deduplicated = new Map(
    measurements.map((measurement) => [measurement.name, measurement]),
  );
  return [...deduplicated.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, TEST_RUN_MEASUREMENT_LIMIT);
}

/** Return run-bound measurements below a caller-provided metric threshold. */
export function queryTestRunMeasurementsBelow(
  runs: ItemTestRunSummary[],
  name: string,
  threshold: number,
): Array<TestRunMeasurement & { run_id: string }> {
  return runs.flatMap((run) =>
    (run.measurements ?? [])
      .filter(
        (measurement) =>
          measurement.name === name && measurement.value < threshold,
      )
      .map((measurement) => ({ ...measurement, run_id: run.run_id })),
  );
}

/** Compare the two newest values of one metric across bounded run history. */
export function diffTestRunMeasurements(
  runs: ItemTestRunSummary[],
  name: string,
): TestRunMeasurementDiff {
  const values = runs
    .flatMap((run) => run.measurements ?? [])
    .filter((measurement) => measurement.name === name)
    .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));
  const latest = values[0];
  const previous = values[1];
  return {
    name,
    latest: latest?.value ?? null,
    previous: previous?.value ?? null,
    delta:
      latest !== undefined && previous !== undefined
        ? latest.value - previous.value
        : null,
    unit: latest?.unit,
  };
}
