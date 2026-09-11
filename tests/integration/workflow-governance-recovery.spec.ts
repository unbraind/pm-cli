import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { TOOLS } from "../../src/mcp/tool-definitions.js";
import { PmClient } from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("governance recovery across real transports", () => {
  it("accepts either policy id source through CLI and MCP discovery and dispatch", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const definition = { rule: { kind: "require_fields", fields: ["body"] } };
      for (const operand of [[], ["cli-policy"]]) {
        const payload = operand.length ? definition : { ...definition, id: "cli-policy" };
        const result = runCli(["schema", "policy-put", ...operand, "--definition", JSON.stringify(payload), "--json"]);
        expect(result.status, result.stderr).toBe(0);
      }
      const schema = TOOLS.find((tool) => tool.name === "pm_schema")!.inputSchema;
      expect(JSON.stringify(schema.allOf)).not.toContain('"required":["name","definition"]');
      for (const named of [false, true]) {
        const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "pm_schema", arguments: { path: pmPath, subcommand: "policy-put",
            ...(named ? { name: "mcp-policy" } : {}),
            definition: named ? definition : { ...definition, id: "mcp-policy" },
          },
        } });
        expect(response).toMatchObject({ structuredContent: { result: { changed: !named } } });
      }
      const historyPath = path.join(pmPath, "history", "_workspace.jsonl");
      const history = await readFile(historyPath, "utf8");
      const refusal = runCli(["schema", "policy-put", "wrong", "--definition", JSON.stringify({ ...definition, id: "cli-policy" }), "--json"]);
      expect(refusal.status).toBe(2);
      expect((refusal.stdout + refusal.stderr)).toContain("definition.id");
      expect(await readFile(historyPath, "utf8")).toBe(history);
    });
  });

  it("gates applicable contract presence through the existing assurance primitives", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const { item } = await client.create({ title: "Contract gate owner", body: "Evidence" });
      await client.assurance({ action: "put", kind: "measurement", id: "requirements", definition: {
        id: "requirements", source: { kind: "validate", check: "completeness", field: "applicable_requirement_count" },
      } });
      await client.assurance({ action: "put", kind: "assertion", id: "required-contract", definition: {
        id: "required-contract", measurement_id: "requirements", owner_item_id: item.id,
        scope: { kind: "all" }, floor: 1, lifetime: "hold", enforcement: "block",
        negative_control: { cases: [{ observed: 0, expected: "fail" }, { observed: 1, expected: "pass" }] },
      } });
      await client.assurance({ action: "put", kind: "gate", id: "contract", definition: {
        id: "contract", assertion_ids: ["required-contract"], triggers: ["ci"],
      } });
      const args = ["assurance", "run", "contract", "--trigger", "ci", "--dry-run", "--json"];
      expect(runCli(args).status).toBe(1);
      await client.workflowPolicy("policy-put", "evidence", { definition: { rule: { kind: "require_fields", fields: ["body"] } } });
      expect(runCli(args).status).toBe(0);
      const report = await client.validate({ checkCompleteness: true, counts: true });
      expect(report.checks[0].details).toMatchObject({ applicable_requirement_count: 1, governed_items: 1, contract_status: "covered" });
      const mcp = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "pm_validate", arguments: { path: pmPath, checkCompleteness: true, counts: true },
      } });
      expect(JSON.stringify(mcp)).toContain('"applicable_requirement_count":1');
      await client.workflowPolicy("policy-remove", "evidence");
      expect(runCli(args).status).toBe(1);
    });
  });

  it("names an installable narrow annotation bypass and keeps strict edits protected", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const { item } = await client.create({ title: "Held work", author: "writer" });
      await client.claim(item.id, { author: "writer" });
      expect(runCli(["config", "project", "set", "governance_ownership_enforcement", "strict"]).status).toBe(0);
      const historyPath = path.join(pmPath, "history", `${item.id}.jsonl`);
      const history = await readFile(historyPath, "utf8");
      for (const command of ["notes", "comments", "learnings"] as const) {
        await expect(client[command](item.id, { add: "Observation", author: "reader" })).rejects.toMatchObject({
          context: { nextSteps: expect.arrayContaining([expect.stringContaining("pm package install governance-audit --project")]) },
        });
        await expect(handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
          name: `pm_${command}`, arguments: { path: pmPath, id: item.id, options: { add: "Observation", author: "reader" } },
        } })).rejects.toMatchObject({ code: "ownership_conflict" });
        const refusal = runCli([command, item.id, "Observation", "--author", "reader", "--json"]);
        expect(refusal.status).toBe(4);
        expect((refusal.stdout + refusal.stderr)).toContain("pm claim <id>");
      }
      expect(await readFile(historyPath, "utf8")).toBe(history);
      const install = runCli(["package", "install", "governance-audit", "--project"]);
      expect(install.status, install.stderr).toBe(0);
      for (const command of ["notes", "comments", "learnings"]) {
        const appended = runCli([command, item.id, "Observation", "--author", "reader", "--allow-audit-comment", "--json"]);
        expect(appended.status, appended.stderr).toBe(0);
        const edit = runCli([command, item.id, "Changed", "--edit", "1", "--author", "reader", "--allow-audit-comment", "--json"]);
        expect(edit.status).toBe(4);
        const deletion = runCli([command, item.id, "--delete", "1", "--author", "reader", "--allow-audit-comment", "--json"]);
        expect(deletion.status).toBe(4);
      }
      expect((await client.get(item.id, { full: true })).item.assignee).toBe("writer");
      expect(runCli(["claim", item.id, "--author", "reader"]).status).toBe(4);
      expect(runCli(["release", item.id, "--author", "writer"]).status).toBe(0);
      expect(runCli(["claim", item.id, "--author", "reader"]).status).toBe(0);
      for (const command of ["notes", "comments", "learnings"]) {
        expect(runCli([command, item.id, "After handoff", "--author", "reader"]).status).toBe(0);
      }
      expect(runCli(["history", item.id, "--verify", "--strict-exit"]).status).toBe(0);
    });
  });
});
