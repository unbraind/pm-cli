import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../src/sdk/runtime.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const values = {
  probe_score: 0,
  probe_ready: false,
  probe_label: "",
  probe_tags: ["one", "two"],
  probe_array: [1, false, { nested: "value" }],
  probe_object: { nested: { count: 3 }, empty: [] },
};

describe("SDK read context for customizable trackers", () => {
  it("projects active package metadata through SDK, CLI and native action dispatch without leaking registrations", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath, placement: "projectRoot", directory: "projection-fields",
        manifestOverrides: { capabilities: ["schema"] },
        entrySource: `export function activate(api) { api.registerItemFields(${JSON.stringify([
          { name: "probe_score", type: "number" },
          { name: "probe_ready", type: "boolean" },
          { name: "probe_label", type: "string" },
          { name: "probe_tags", type: "string_array" },
          { name: "probe_array", type: "array" },
          { name: "probe_object", type: "object" },
          { name: "probe_optional", type: "number", optional: true },
        ])}); }`,
      });
      const client = new PmClient({ cwd: context.tempRoot, pmRoot: context.pmPath });
      const created = await client.create({ title: "Projection sentinel", type: "Task", createMode: "progressive", field: [
        "probe_score=0", "probe_ready=false", "probe_label=", "probe_tags=one,two",
        `probe_array=${JSON.stringify(values.probe_array)}`, `probe_object=${JSON.stringify(values.probe_object)}`,
      ] });
      const id = created.item.id;
      expect((await client.get(id, { full: true })).item).toMatchObject(values);
      for (const prefix of ["", "item."]) {
        const fields = ["id", ...Object.keys(values).map((key) => `${prefix}${key}`)].join(",");
        const get = await client.get(id, { fields });
        expect(get.item).toEqual({ id, ...values });
        const list = await client.list({ fields });
        expect(list.items).toEqual([{ id, ...values }]);
        const search = await client.search("Projection", { fields, mode: "keyword" });
        expect(search.items).toEqual([{ id, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}${key}`, value])) }]);
        for (const command of [["get", id], ["list"], ["search", "Projection", "--mode", "keyword"]]) {
          const result = context.runCli([...command, "--fields", fields, "--json"], { expectJson: true });
          expect(result.code, result.stderr).toBe(0);
          expect(result.json).toMatchObject(command[0] === "get" ? { item: { id, ...values } } : { items: command[0] === "search" ? search.items : list.items });
        }
      }
      expect(await client.run("get", { id, options: { fields: "id,probe_score" } })).toMatchObject({ item: { id, probe_score: 0 } });
      expect((await client.get(id, { fields: "id,probe_optional" })).item).toEqual({ id });
      // Unknown selectors must refuse while preserving valid package fields in recovery.
      for (const read of [
        () => client.get(id, { fields: "probe_score,probe_typo" }),
        () => client.list({ fields: "probe_score,probe_typo" }),
        () => client.search("Projection", { fields: "probe_score,probe_typo", mode: "keyword" }),
      ]) await expect(read()).rejects.toMatchObject({ context: {
        code: "unknown_field_projection",
        recovery: { allowed_values: expect.arrayContaining(["probe_score", "item.probe_score"]), suggested_retry_args: expect.arrayContaining(["--fields", "probe_score"]) },
      } });
      const disabled = new PmClient({ cwd: context.tempRoot, pmRoot: context.pmPath, noExtensions: true });
      await expect(disabled.get(id, { fields: "probe_score" })).rejects.toMatchObject({ context: { code: "unknown_field_projection" } });
      expect((await client.get(id, { fields: "probe_score" })).item).toEqual({ id, probe_score: 0 });
      expect((await disabled.get(id, { fields: "id,title" })).item).toEqual({ id, title: "Projection sentinel" });
    });
  });

  it("keeps missing optional schema files absent through SDK and CLI reads and repairs them only during explicit init", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ cwd: context.tempRoot, pmRoot: context.pmPath, noExtensions: true });
      const { item: { id } } = await client.create({ title: "Read purity sentinel", type: "Task", createMode: "progressive" });
      const schemaRoot = path.join(context.pmPath, "schema");
      const workflowPath = path.join(schemaRoot, "workflows.json");
      const files = await readdir(schemaRoot);
      const original = await Promise.all(files.filter((file) => file !== "workflows.json").map(async (file) => [file, await readFile(path.join(schemaRoot, file), "utf8")]));
      await rm(workflowPath);
      const reads = [
        () => client.get(id), () => client.list({ limit: "1" }),
        () => client.context({ limit: "1" }), () => client.search("purity", { mode: "keyword", limit: "1" }),
      ];
      for (const read of reads) {
        await read();
        expect(existsSync(workflowPath)).toBe(false);
      }
      await expect(client.get("pm-missing")).rejects.toThrow();
      expect(existsSync(workflowPath)).toBe(false);
      for (const command of [["get", id], ["list", "--limit", "1"], ["context", "--limit", "1"], ["search", "purity", "--mode", "keyword", "--limit", "1"]]) {
        const result = context.runCli([...command, "--json"]);
        expect(result.code, result.stderr).toBe(0);
        expect(existsSync(workflowPath)).toBe(false);
      }
      expect(context.runCli(["get", "pm-missing", "--json"]).code).not.toBe(0);
      expect(existsSync(workflowPath)).toBe(false);
      expect(await Promise.all(files.filter((file) => file !== "workflows.json").map(async (file) => [file, await readFile(path.join(schemaRoot, file), "utf8")]))).toEqual(original);
      expect(context.runCli(["init", "--defaults", "--json"]).code).toBe(0);
      expect(existsSync(workflowPath)).toBe(true);
      // Missing the entire optional schema directory must also be a pure read.
      await rm(schemaRoot, { recursive: true });
      expect((await client.get(id)).item.id).toBe(id);
      expect(existsSync(schemaRoot)).toBe(false);
    });
  });
});
