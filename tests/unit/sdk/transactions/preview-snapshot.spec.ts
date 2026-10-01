import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewItemMutations } from "../../../../src/sdk/item-transaction.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const copying = vi.hoisted(() => ({ change: "none" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, cp: async (...args: Parameters<typeof actual.cp>) => {
    await actual.cp(...args);
    if (copying.change !== "none") {
      const target = copying.change === "source" ? args[0] : args[1];
      await actual.writeFile(path.join(String(target), "snapshot-probe.txt"), "changed");
    }
  } };
});
afterEach(() => { copying.change = "none"; });

describe("semantic preview snapshot consistency", () => {
  it.each(["source", "staged"])("rejects %s state changes during copying instead of validating a mixed snapshot", async (change) => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "snapshot-probe.txt"), "original");
      copying.change = change;
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "copy-consistency", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-preview", options: { title: "Preview", type: "Task" } }] })).rejects.toMatchObject({ exitCode: 4, context: { code: "transaction_preview_snapshot_changed" } });
    });
  });
});
