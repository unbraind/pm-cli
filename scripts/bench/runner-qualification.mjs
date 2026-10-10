/** Preserve benchmark runner evidence without subtracting its cost from product ratchets. Tracker: pm-bj7rq0. */
import os from "node:os";

/** Capture portable scheduling and memory context; these observations do not establish a failure cause. */
export function captureRunnerEnvironment() {
  return {
    observed_at: new Date().toISOString(),
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    available_parallelism: os.availableParallelism(),
    load_average: os.loadavg(),
    free_memory_bytes: os.freemem(),
    total_memory_bytes: os.totalmem(),
  };
}

/** Classify bare-process controls independently of all product latency and RSS measurements. */
export function qualifyBenchmarkRunner(controls, budget, noiseMarginMs) {
  const ceiling = budget?.max_import_ms;
  if (!Number.isFinite(ceiling) || ceiling < 0 || controls.length === 0 ||
    controls.some((control) => !Number.isFinite(control?.p50_ms) || control.p50_ms < 0 || !Number.isSafeInteger(control.runs) || control.runs < 1)) {
    return { status: "unqualified", reason: "control_unavailable" };
  }
  const maximum = Math.max(...controls.map((control) => control.p50_ms));
  return {
    status: maximum <= ceiling + noiseMarginMs ? "qualified" : "unqualified",
    reason: maximum <= ceiling + noiseMarginMs ? "control_within_budget" : "control_over_budget",
    maximum_control_median_ms: maximum,
    maximum_allowed_ms: ceiling + noiseMarginMs,
  };
}

/** Keep failed admission unsuccessful and retain the complete report instead of discarding diagnostics. */
export function benchmarkAdmissionError(label, report, violations, qualification) {
  const productAdmission = qualification.status === "qualified" ? "failed" : "unverified";
  const code = qualification.status === "qualified" ? "benchmark_product_budget_exceeded" : "benchmark_runner_unqualified";
  return Object.assign(new Error(`${label} gate failed:\n${violations.join("\n")}\n${JSON.stringify({ code, product_admission: productAdmission, runner_qualification: qualification, report })}`), {
    code,
    product_admission: productAdmission,
    runner_qualification: qualification,
    report,
    violations,
  });
}
