import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measurePointReadCosts, runEntrypoint } from "../../../scripts/bench/point-read-costs.mjs";

afterEach(() => { vi.restoreAllMocks(); });

describe("point-read corpus scaling", () => {
  it("holds identity constant and proves explicit scans grow with the corpus", async () => {
    const reports = await measurePointReadCosts([3, 1500], 2);
    expect(reports.map(({ explicit_children_scanned }) => explicit_children_scanned)).toEqual([3, 1500]);
    expect(reports[0].item_id).toBe(reports[1].item_id);
    await expect(measurePointReadCosts([0])).rejects.toThrow("positive integers");
  });

  it("runs default and explicit standalone measurements without import side effects", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const script = path.resolve("scripts/bench/point-read-costs.mjs");
    await expect(runEntrypoint([process.execPath])).resolves.toBe(false);
    await expect(runEntrypoint()).resolves.toBe(false);
    await expect(runEntrypoint([process.execPath, script, "5"])).resolves.toBe(true);
    await expect(runEntrypoint([process.execPath, script])).resolves.toBe(true);
    expect(output).toHaveBeenCalledTimes(2);
  });
});
