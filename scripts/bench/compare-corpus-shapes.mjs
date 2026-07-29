#!/usr/bin/env node

/**
 * Reproducible same-count comparison for two portable corpus populations.
 *
 * Tracker: pm-vv2lti. The report preserves raw SDK benchmark summaries and
 * classifies material p95 differences without turning host noise into a gate.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, repoRoot } from "../release/utils.mjs";
import {
  benchmarkOptionsFromFlags,
  runScaleBenchmarks,
} from "./run-scale-benchmarks.mjs";

const DEFAULT_OUTPUT_PATH = path.join(
  repoRoot,
  "docs",
  "performance",
  "corpus-shape-comparison.json",
);

function relativeChange(left, right) {
  if (left === 0) return right === 0 ? 0 : null;
  return Number((((right - left) / left) * 100).toFixed(1));
}

/** Compare p95 operation latency across same-count benchmark reports. */
export function compareShapeReports(left, right, materialPercent = 20) {
  const leftOperations = left.transports.sdk;
  const rightOperations = right.transports.sdk;
  const operationNames = Object.keys(leftOperations)
    .filter((name) => rightOperations[name] !== undefined)
    .sort();
  const operations = Object.fromEntries(
    operationNames.map((name) => {
      const leftP95 = leftOperations[name].p95_ms;
      const rightP95 = rightOperations[name].p95_ms;
      const percent = relativeChange(leftP95, rightP95);
      return [
        name,
        {
          left_p95_ms: leftP95,
          right_p95_ms: rightP95,
          right_vs_left_percent: percent,
          classification:
            percent === null || Math.abs(percent) < materialPercent
              ? "within_margin"
              : percent > 0
                ? "slower"
                : "faster",
        },
      ];
    }),
  );
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    item_count: left.fixture.item_count,
    seed: left.fixture.seed,
    material_difference_percent: materialPercent,
    left: {
      shape: left.fixture.shape.name,
      measured_profile: left.fixture.shape.measured_profile,
    },
    right: {
      shape: right.fixture.shape.name,
      measured_profile: right.fixture.shape.measured_profile,
    },
    operations,
  };
}

/** Generate both populations and write their same-count comparison evidence. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const { flags } = parseFlags(argv);
  const itemCount = flags.get("items") ?? 100;
  const iterations = flags.get("iterations") ?? 3;
  const seed = flags.get("seed") ?? 42;
  const leftShape =
    flags.get("left-shape") === undefined
      ? "scratch"
      : String(flags.get("left-shape"));
  const rightShape =
    flags.get("right-shape") === undefined
      ? "representative"
      : String(flags.get("right-shape"));
  const outputFlag = flags.get("output");
  const defaultOutputPath = options.defaultOutputPath ?? DEFAULT_OUTPUT_PATH;
  const outputPath =
    outputFlag === undefined || outputFlag === true
      ? defaultOutputPath
      : path.resolve(String(outputFlag));
  const run = options.run ?? runScaleBenchmarks;
  const common = benchmarkOptionsFromFlags(
    new Map([
      ["items", itemCount],
      ["iterations", iterations],
      ["seed", seed],
      ["transport", "sdk"],
    ]),
  );
  const [left, right] = await Promise.all([
    run({ ...common, shape: leftShape }),
    run({ ...common, shape: rightShape }),
  ]);
  if (
    left.fixture.item_count !== right.fixture.item_count ||
    left.fixture.seed !== right.fixture.seed
  ) {
    throw new Error("Corpus comparison requires identical item counts and seeds");
  }
  const report = compareShapeReports(left, right);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, outputPath };
}

/** Execute the comparison entrypoint without mutating process globals in tests. */
export async function runCorpusShapeComparisonEntrypoint(options = {}) {
  const argv = options.argv ?? process.argv;
  if (
    argv[1] === undefined ||
    fileURLToPath(import.meta.url) !== path.resolve(argv[1])
  ) {
    return false;
  }
  try {
    const { report, outputPath } = await (options.run ?? main)(argv.slice(2));
    (options.write ?? ((output) => process.stdout.write(output)))(
      `${JSON.stringify(
        {
          ok: true,
          item_count: report.item_count,
          shapes: [report.left.shape, report.right.shape],
          report: path.relative(repoRoot, outputPath),
        },
        null,
        2,
      )}\n`,
    );
    return true;
  } catch (error) {
    (options.onError ?? ((cause) => fail(String(cause))))(error);
    return false;
  }
}

void runCorpusShapeComparisonEntrypoint();
