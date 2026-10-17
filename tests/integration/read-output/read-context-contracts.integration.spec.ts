import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decode as decodeToon } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { runList } from "../../../src/sdk/query/list.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("SDK read context contracts", () => {
  it("shows normalized sort values in brief rows and preserves explicit projections", async () => {
    await withTempPmPath(async (context) => {
      context.runCli(["create", "Sorted context", "--type", "Task", "--priority", "1"]);
      for (const [sort, field] of [["priority", "priority"], ["updated", "updated_at"], ["created", "created_at"], ["deadline", "deadline"], ["title", "title"], ["parent", "parent"]]) {
        const sdk = await runList(undefined, { brief: true, sort }, { path: context.pmPath });
        expect(sdk.projection?.fields).toContain(field);
        const cli = context.runCli(["list", "--sort", sort, "--json"], { expectJson: true });
        expect(cli.code).toBe(0);
        const result = cli.json as typeof sdk;
        expect(result.projection?.fields).toEqual(sdk.projection?.fields);
        expect(result.items[0]).toHaveProperty(field, sdk.items[0]?.[field]);
      }
      const fields = await runList(undefined, { sort: "priority", fields: "id,title" }, { path: context.pmPath });
      expect(fields.projection?.fields).toEqual(["id", "title"]);
      expect(fields.items[0]).not.toHaveProperty("priority");
      const compact = await runList(undefined, { sort: "deadline", compact: true }, { path: context.pmPath });
      expect(compact.items[0]).not.toHaveProperty("deadline");
    });
  });

  it("preserves timestamp-free legacy rows and diagnoses invalid supplied timestamps without changing the source", async () => {
    await withTempPmPath(async (context) => {
      const file = path.join(context.pmPath, "tasks", "pm-malformed.toon");
      const source = 'id: pm-malformed\ntitle: Imported item\ndescription: Missing dependency timestamps\ntype: Task\nstatus: open\npriority: 2\ntags[0]:\ncreated_at: "2026-10-17T00:00:00.000Z"\nupdated_at: "2026-10-17T00:00:00.000Z"\ndependencies[2]{id,kind}:\n  pm-a,related\n  pm-b,related\nbody: ""\n';
      const legacy = source.replace("pm-a,related\n  pm-b,related", "pm-b,related\n  pm-a,related");
      await writeFile(file, legacy);
      const readable = context.runCli(["get", "pm-malformed", "--full", "--json"], { expectJson: true });
      expect(readable.code).toBe(0);
      expect((readable.json as { item: { dependencies: unknown[] } }).item.dependencies).toEqual([
        { id: "pm-a", kind: "related" }, { id: "pm-b", kind: "related" },
      ]);
      expect(await readFile(file, "utf8")).toBe(legacy);
      const invalid = source.replace("dependencies[2]{id,kind}", "dependencies[2]{id,kind,created_at}").replace("pm-a,related\n  pm-b,related", "pm-a,related,null\n  pm-b,related,null");
      await writeFile(file, invalid);
      const get = context.runCli(["get", "pm-malformed", "--json"], { expectJson: true });
      expect(get.code).not.toBe(0);
      expect(get.stderr + get.stdout).toContain("dependencies.0.created_at");
      expect(get.stderr + get.stdout).not.toContain("localeCompare");
      for (const args of [["validate", "--check-storage-integrity", "--json"], ["health", "--check-only", "--full", "--json"]]) {
        const diagnostic = context.runCli(args, { expectJson: true });
        expect(diagnostic.json).toMatchObject({ ok: false });
        expect(JSON.stringify(diagnostic.json)).toContain("pm-malformed");
      }
      expect(await readFile(file, "utf8")).toBe(invalid);
    });
  });

  it("bounds passing extension health under registry growth and restores structured full evidence", async () => {
    await withTempPmPath(async (context) => {
      const extension = path.join(context.pmPath, "extensions", "pm-ts-starter");
      await mkdir(extension, { recursive: true });
      await writeFile(path.join(extension, "manifest.json"), JSON.stringify({ name: "pm-ts-starter", version: "1.0.0", entry: "./index.mjs", capabilities: ["commands"], pm_min_version: "0.0.0" }));
      const commands = Array.from({ length: 40 }, (_, i) => `api.registerCommand({ name: 'context-probe-${i}', description: '${"Detailed registry evidence ".repeat(30)}', run: () => ({ ok: true }) });`).join("\n");
      await writeFile(path.join(extension, "index.mjs"), `export default { activate(api) { ${commands} } };`);
      expect(context.runCli(["extension", "--adopt", "pm-ts-starter", "--project"]).code).toBe(0);
      const results = [[], ["--brief"], ["--summary"], ["--full"]].map((flags) => {
        const cli = context.runCli(["health", ...flags, "--json", "--output-budget", "unbounded"], { expectJson: true });
        expect(cli.code).toBe(0);
        return cli.json as { ok: boolean; verdict: unknown; failed_because: string[]; checks: Array<{ name: string; status: string; details: Record<string, unknown> }> };
      });
      const [standard, brief, summary, full] = results;
      for (const result of results) {
        expect(result?.ok).toBe(full?.ok);
        expect(result?.verdict).toEqual(full?.verdict);
        expect(result?.failed_because).toEqual(full?.failed_because);
      }
      const extensionDetails = (result: typeof standard) => result?.checks.find((check) => check.name === "extensions")?.details;
      expect(extensionDetails(standard)).toMatchObject({ loaded_count: 1, restore_with: "pm health --full" });
      expect(JSON.stringify(extensionDetails(standard))).not.toContain("Detailed registry evidence");
      expect(JSON.stringify(extensionDetails(full))).toContain("Detailed registry evidence");
      expect(Buffer.byteLength(JSON.stringify(extensionDetails(standard)))).toBeLessThan(256);
      for (const flags of [[], ["--full"]]) {
        const toon = context.runCli(["health", ...flags, "--output-budget", "unbounded"]);
        expect(toon.code).toBe(0);
        const decoded = decodeToon(toon.stdout) as NonNullable<typeof standard>;
        expect(typeof extensionDetails(decoded)).toBe("object");
        expect(toon.stdout).not.toContain("checks_encoding:");
      }
      expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(standard).length);
      for (const check of brief!.checks) {
        const original = standard!.checks.find((entry) => entry.name === check.name)!;
        expect(JSON.stringify(check.details).length).toBeLessThanOrEqual(JSON.stringify(original.details).length);
      }
    });
  });
});
