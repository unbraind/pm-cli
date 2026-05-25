import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("CLI in-process runner integration", () => {
  it("keeps subprocess and in-process runner behavior aligned for core flows", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--json", "--title", "In-process parity", "--description", "runner parity", "--type", "Task"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      const subprocessList = context.runCli(["list-open", "--json", "--limit", "10"], { expectJson: true });
      const inProcessList = await context.runCliInProcess(["list-open", "--json", "--limit", "10"], { expectJson: true });
      expect(inProcessList.code).toBe(subprocessList.code);
      const subprocessIds = ((subprocessList.json as { items?: Array<{ id?: string }> }).items ?? [])
        .map((entry) => entry.id)
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));
      const inProcessIds = ((inProcessList.json as { items?: Array<{ id?: string }> }).items ?? [])
        .map((entry) => entry.id)
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right));
      expect(inProcessIds).toEqual(subprocessIds);

      const subprocessUsage = context.runCli(["list-open", "--bogus-flag"]);
      const inProcessUsage = await context.runCliInProcess(["list-open", "--bogus-flag"]);
      expect(inProcessUsage.code).toBe(subprocessUsage.code);
      expect(inProcessUsage.stderr).toContain("--bogus-flag");
    });
  });

  it("keeps concurrent in-process runs isolated and restores globals", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--json", "--title", "In-process globals", "--description", "runner globals", "--type", "Task"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdId = (created.json as { item: { id: string } }).item.id;
      const sentinelEnvKey = "PM_INPROCESS_SENTINEL";
      const cwdBefore = process.cwd();
      const nestedCwd = path.join(context.tempRoot, "nested-cwd");
      await mkdir(nestedCwd, { recursive: true });
      delete process.env[sentinelEnvKey];
      context.env[sentinelEnvKey] = "set-only-during-inprocess-run";

      const [listOpen, fetched] = await Promise.all([
        context.runCliInProcess(["list-open", "--json", "--limit", "20"], {
          expectJson: true,
          cwd: nestedCwd,
        }),
        context.runCliInProcess(["get", createdId, "--json"], { expectJson: true }),
      ]);

      expect(listOpen.code).toBe(0);
      expect(fetched.code).toBe(0);
      const openIds = ((listOpen.json as { items?: Array<{ id?: string }> }).items ?? [])
        .map((entry) => entry.id)
        .filter((value): value is string => typeof value === "string");
      expect(openIds).toContain(createdId);
      expect((fetched.json as { item: { id: string } }).item.id).toBe(createdId);
      expect(process.cwd()).toBe(cwdBefore);
      expect(process.env[sentinelEnvKey]).toBeUndefined();

      delete context.env[sentinelEnvKey];
    });
  });
});
