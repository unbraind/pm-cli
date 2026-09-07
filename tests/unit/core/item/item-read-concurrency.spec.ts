/** Regression for pm-hrhfgi: complete scans must fit a bounded file-descriptor budget. */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { serializeItemDocument } from "../../../../src/core/item/item-format.js";
import { listAllDocumentCandidatesCached } from "../../../../src/core/store/item-metadata-cache.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

it("reads every item under descriptor pressure and still reports genuinely unreadable files", async () => {
  await withTempPmPath(async ({ pmPath }) => {
    const directory = path.join(pmPath, "tasks");
    await fs.mkdir(directory, { recursive: true });
    for (let index = 0; index < 128; index += 1) {
      const id = `pm-pressure-${index}`;
      await fs.writeFile(path.join(directory, `${id}.toon`), serializeItemDocument({
        metadata: { id, title: id, description: "", type: "Task", status: "open", priority: 1, tags: [], created_at: "2026-09-07T00:00:00.000Z", updated_at: "2026-09-07T00:00:00.000Z" },
        body: "source body",
      }, { format: "toon" }));
    }
    const originalRead = fs.readFile.bind(fs);
    let active = 0;
    let peak = 0;
    let rejectItem = false;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (!String(args[0]).endsWith(".toon")) return originalRead(...args);
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (active > 32) throw Object.assign(new Error("descriptor budget exhausted"), { code: "EMFILE" });
        if (rejectItem && String(args[0]).endsWith("pm-pressure-0.toon")) throw Object.assign(new Error("denied"), { code: "EACCES" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await originalRead(...args);
      } finally {
        active -= 1;
      }
    });
    try {
      const warnings: string[] = [];
      const read = () => listAllDocumentCandidatesCached(pmPath, "toon", { Task: "tasks" }, warnings, undefined, { forceSourceScan: true });
      expect(await read()).toHaveLength(128);
      expect(warnings).toEqual([]);
      expect(peak).toBeLessThanOrEqual(32);
      rejectItem = true;
      expect(await read()).toHaveLength(127);
      expect(warnings).toEqual(["item_list_item_read_failed:tasks/pm-pressure-0.toon"]);
      expect(active).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
