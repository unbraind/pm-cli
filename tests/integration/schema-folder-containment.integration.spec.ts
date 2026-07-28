import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("schema item-type folder containment", () => {
  it("rejects author-time escapes and canonicalizes safe nested folders", async () => {
    await withTempPmPath(async (context) => {
      const rejected = await context.runCliInProcess([
        "schema",
        "add-type",
        "Escaped",
        "--folder",
        "../../escaped-items",
        "--json",
      ]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("must stay inside the pm tracker root");

      const added = await context.runCliInProcess(
        [
          "schema",
          "add-type",
          "Nested",
          "--folder",
          "/custom/../nested-items",
          "--json",
        ],
        { expectJson: true },
      );
      expect(added.code).toBe(0);
      expect((added.json as { type: { folder: string } }).type.folder).toBe(
        "nested-items",
      );

      const created = await context.runCliInProcess(
        ["create", "Nested", "Confined custom item", "--json"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const createdId = (created.json as { item: { id: string } }).item.id;
      await expect(
        access(path.join(context.pmPath, "nested-items", `${createdId}.toon`)),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects a legacy escaping definition before item or history writes", async () => {
    await withTempPmPath(async (context) => {
      const added = await context.runCliInProcess(
        ["schema", "add-type", "Legacy", "--json"],
        { expectJson: true },
      );
      expect(added.code).toBe(0);

      const typesPath = path.join(context.pmPath, "schema", "types.json");
      const types = JSON.parse(await readFile(typesPath, "utf8")) as {
        definitions: Array<{ name: string; folder?: string }>;
      };
      const escapeTarget = path.join(context.tempRoot, "escaped-items");
      const legacy = types.definitions.find(
        (definition) => definition.name === "Legacy",
      );
      expect(legacy).toBeDefined();
      legacy!.folder = path
        .relative(context.pmPath, escapeTarget)
        .split(path.sep)
        .join("/");
      await writeFile(typesPath, `${JSON.stringify(types, null, 2)}\n`, "utf8");
      const historyBefore = await readdir(path.join(context.pmPath, "history"));

      const rejected = await context.runCliInProcess([
        "create",
        "Legacy",
        "Legacy escape attempt",
        "--json",
      ]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("must stay inside the pm tracker root");
      await expect(access(escapeTarget)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readdir(path.join(context.pmPath, "history")),
      ).resolves.toEqual(historyBefore);
    });
  });
});
