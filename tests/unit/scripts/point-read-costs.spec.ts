import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBoundedPointRead, measurePointReadCosts, runEntrypoint } from "../../../scripts/bench/point-read-costs.mjs";

import { PmClient } from "@unbrained/pm-cli/sdk/runtime";
import { measureItemMetadataReadWork } from "@unbrained/pm-cli/sdk/query";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("point-read corpus scaling", () => {
  it("holds identity constant and proves explicit scans grow with the corpus", async () => {
    const reports = await measurePointReadCosts([3, 1500], 2);
    expect(reports.map(({ explicit_children_scanned }) => explicit_children_scanned)).toEqual([3, 1500]);
    expect(reports.map(({ ordinary_metadata_enumerations }) => ordinary_metadata_enumerations)).toEqual([0, 0]);
    expect(reports.map(({ explicit_metadata_work }) => explicit_metadata_work.metadata_rows)).toEqual([3, 1500]);
    expect(reports[0].item_id).toBe(reports[1].item_id);
    await expect(measurePointReadCosts([0])).rejects.toThrow("positive integers");
  });

  it("rejects a real enumeration whose result is discarded before an ordinary point read", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, noExtensions: true });
      const created = await client.create({ title: "Scan-and-discard negative control", type: "Task" });
      const measured = await measureItemMetadataReadWork(async () => {
        await client.listAllComplete();
        return client.get(created.item.id);
      });
      expect(measured.result.children).toBeUndefined();
      expect(() => assertBoundedPointRead(measured)).toThrow("enumerated unrelated item metadata");
    });
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
