import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGuardedRuntimeSchema } from "../../../../src/sdk/item-transaction.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const mocks = vi.hoisted(() => ({ realpath: vi.fn<(target: string) => Promise<string>>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  mocks.realpath.mockImplementation(actual.realpath);
  return { ...actual, realpath: (target: string) => mocks.realpath(target) };
});

describe("loadGuardedRuntimeSchema (pm-gh1456)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("loads declared fields from the schema files and reports a tracker that changes underneath as a snapshot change", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["schema", "add-field", "external_id", "--type", "string", "--json"]).code).toBe(0);
      const loaded = await loadGuardedRuntimeSchema(context.pmPath, undefined);
      expect(loaded.schema.fields.map((field) => field.key)).toContain("external_id");

      const vanished = Object.assign(new Error("ENOENT: vanished"), {
        code: "ENOENT",
        path: path.join(context.pmPath, "vanished", "deeper"),
      });
      mocks.realpath.mockRejectedValueOnce(vanished);
      await expect(loadGuardedRuntimeSchema(context.pmPath, undefined)).rejects.toMatchObject({
        context: { code: "transaction_preview_snapshot_changed" },
      });

      const persistent = Object.assign(new Error("EACCES"), { code: "EACCES" });
      mocks.realpath.mockRejectedValueOnce(persistent);
      await expect(loadGuardedRuntimeSchema(context.pmPath, undefined)).rejects.toBe(persistent);
    });
  });
});
