import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureContextReadCosts, runEntrypoint } from "../../../scripts/bench/context-read-costs.mjs";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("context read cost measurements", () => {
  it("measures real concurrent writes and exact recall with a bounded small corpus", async () => {
    const [result] = await measureContextReadCosts([300], 2, 2);
    expect(result).toMatchObject({ items: 300, exact_recall: 1, fleet_serves: 4, fleet_writers: 2 });
    expect(result.mean_serve_written_bytes).toBeGreaterThan(0);
    expect(result.min_lock_wait_ms).toBeLessThanOrEqual(result.p50_lock_wait_ms);
    expect(result.p50_lock_wait_ms).toBeLessThanOrEqual(result.p95_lock_wait_ms);
    expect(result.p95_lock_wait_ms).toBeLessThanOrEqual(result.max_lock_wait_ms);
    expect(result.physical_ledger_bytes).toBeLessThanOrEqual(262_144);
    await expect(measureContextReadCosts([0])).rejects.toThrow("positive integers");
    vi.stubEnv("PM_CONTEXT_USAGE_DISABLED", "1");
    await expect(measureContextReadCosts([20], 1, 1)).rejects.toThrow("persistence receipt");
  });

  it("runs explicit and default command-line measurements and stays inert when imported", async () => {
    const script = path.resolve("scripts/bench/context-read-costs.mjs");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runEntrypoint([process.execPath])).resolves.toBe(false);
    await expect(runEntrypoint()).resolves.toBe(false);
    await expect(runEntrypoint([process.execPath, script, "20"])).resolves.toBe(true);
    await expect(runEntrypoint([process.execPath, script])).resolves.toBe(true);
    expect(output).toHaveBeenCalledTimes(2);
  });
});
