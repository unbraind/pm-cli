import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerMutationCommands } from "../../src/cli/register-mutation.js";
import { handleRequest } from "../../src/mcp/server.js";
import { TOOLS } from "../../src/mcp/tool-definitions.js";
import { PmClient } from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("declarative policy MCP parity", () => {
  it("discovers policy verbs and enforces the same requirement through MCP, CLI, and SDK", async () => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      const { item } = await client.create({ title: "Transport parity" });
      const schema = TOOLS.find((tool) => tool.name === "pm_schema");
      expect(JSON.stringify(schema?.inputSchema)).toContain("policy-put");
      const put = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "pm_schema", arguments: { path: pmPath, subcommand: "policy-put", name: "evidence", definition: {
          id: "evidence", effect: "refuse", subject: { statuses: ["closed"] },
          rule: { kind: "require_fields", fields: ["actual_result"] },
        } },
      } });
      expect(put).toMatchObject({ structuredContent: { result: { changed: true } } });
      const program = new Command().exitOverride().option("--quiet").option("--pm-path <value>");
      registerMutationCommands(program);
      await program.parseAsync(["schema", "policy-mode", "refuse", "--quiet", "--pm-path", pmPath], { from: "user" });
      expect(await client.workflowPolicy("policies")).toMatchObject({ policy_result: true, result: { enforcement: "refuse" } });
      await expect(handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "pm_close", arguments: { path: pmPath, id: item.id, reason: "Completed" },
      } })).rejects.toMatchObject({ code: "workflow_policy_refused" });
      await expect(client.close(item.id, "Completed")).rejects.toMatchObject({ code: "workflow_policy_refused" });
      expect(runCli(["close", item.id, "Completed"]).status).not.toBe(0);
      const accepted = await handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "pm_close", arguments: { path: pmPath, id: item.id, reason: "Completed", options: { actualResult: "Verified on every transport" } },
      } });
      expect(accepted).not.toHaveProperty("isError", true);
      expect(JSON.stringify(accepted)).toContain('"closed"');
    });
  });
});
