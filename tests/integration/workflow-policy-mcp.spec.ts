import { describe, expect, it, vi } from "vitest";
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
      const properties = schema!.inputSchema.properties as Record<string, unknown>;
      const nested = properties.options as { properties: Record<string, unknown> };
      for (const key of ["definition", "policy", "message", "dryRun"]) {
        expect(properties).toHaveProperty(key);
        expect(nested.properties[key]).toEqual(properties[key]);
      }
      expect(properties.name).toMatchObject({ description: expect.stringContaining("advise|refuse") });
      expect(schema!.inputSchema.allOf).toContainEqual({ not: { allOf: [
        { properties: { subcommand: { const: "policy-mode" } }, required: ["subcommand"] },
        { properties: { name: { not: { enum: ["advise", "refuse"] } } }, required: ["name"] },
      ] } });
      expect(properties.definition).toMatchObject({ anyOf: [{ type: "object" }, { type: "string" }] });
      for (const mode of ["advise", "refuse"]) {
        expect(await handleRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {
          name: "pm_schema", arguments: { path: pmPath, subcommand: "policy-mode", name: mode, dryRun: true },
        } })).toMatchObject({ structuredContent: { result: { changed: false, result: { enforcement: mode } } } });
      }
      await expect(handleRequest({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {
        name: "pm_schema", arguments: { path: pmPath, subcommand: "policy-mode", name: "invalid" },
      } })).rejects.toThrow();
      expect(runCli(["schema", "--help"]).stdout).toContain("advise|refuse");
      expect(runCli(["schema", "policy-mode", "invalid"]).code).not.toBe(0);
      const put = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "pm_schema", arguments: { path: pmPath, subcommand: "policy-put", name: "evidence", definition: JSON.stringify({
          id: "evidence", effect: "refuse", subject: { statuses: ["closed"] },
          rule: { kind: "require_fields", fields: ["actual_result"] },
        }) },
      } });
      expect(put).toMatchObject({ structuredContent: { result: { changed: true } } });
      const preview = await handleRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name: "pm_schema", arguments: { path: pmPath, subcommand: "policy-remove", name: "evidence", options: { dryRun: true, message: "Preview removal" } },
      } });
      expect(preview).toMatchObject({ structuredContent: { result: { changed: false } } });
      const profile = runCli(["schema", "policies", "--profile", "--json"]);
      expect(profile.code).toBe(0);
      expect(profile.stderr).toMatch(/profile:command=schema took_ms=\d+/);
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
  it("emits the common schema profile epilogue for policy actions", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const stderr = vi.spyOn(process.stderr, "write");
      try {
        for (const profile of [false, true]) {
          stderr.mockClear();
          const program = new Command().exitOverride().option("--quiet").option("--profile").option("--pm-path <value>");
          registerMutationCommands(program);
          await program.parseAsync(["schema", "policies", "--quiet", "--pm-path", pmPath, ...(profile ? ["--profile"] : [])], { from: "user" });
          expect(stderr.mock.calls.some(([text]) => String(text).includes("profile:command=schema"))).toBe(profile);
        }
      } finally {
        stderr.mockRestore();
      }
    });
  });

});
