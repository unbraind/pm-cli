import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/** Verifies that the unavoidable MCP tool result uses the same lean mutation contract as the CLI default. */
describe("MCP mutation envelope parity", () => {
  it("returns the CLI default create shape without an opt-in flag", async () => {
    const server = await import("../../../src/mcp/server.js");
    await withTempPmPath(async (context) => {
      const cli = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "CLI parity",
          "--type",
          "Task",
          "--status",
          "open",
        ],
        { expectJson: true, preserveDefaultMutationOutput: true },
      );
      expect(cli.code).toBe(0);
      const cliResult = cli.json as Record<string, unknown>;

      const response = (await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_create",
          arguments: {
            path: context.pmPath,
            title: "MCP parity",
            type: "Task",
            status: "open",
          },
        },
      })) as {
        structuredContent: { result: Record<string, unknown> };
      };
      const mcpResult = response.structuredContent.result;

      expect(Object.keys(mcpResult).sort()).toEqual(
        Object.keys(cliResult).sort(),
      );
      expect(mcpResult).toMatchObject({
        id: expect.stringMatching(/^pm-/),
        status: "open",
        changed_field_count: 10,
      });
      expect(mcpResult).not.toHaveProperty("item");
      expect(Buffer.byteLength(JSON.stringify(mcpResult))).toBeLessThanOrEqual(
        Buffer.byteLength(JSON.stringify(cliResult)),
      );
    });
  });

  it("preserves the full mutation envelope only when explicitly requested", async () => {
    const server = await import("../../../src/mcp/server.js");
    await withTempPmPath(async (context) => {
      const response = (await server.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_create",
          arguments: {
            path: context.pmPath,
            title: "Full MCP mutation",
            type: "Task",
            status: "open",
            fullChangedFields: true,
          },
        },
      })) as {
        structuredContent: { result: Record<string, unknown> };
      };
      expect(response.structuredContent.result).toMatchObject({
        item: { title: "Full MCP mutation", status: "open" },
        changed_fields: expect.any(Array),
      });
      expect(response.structuredContent.result).not.toHaveProperty(
        "changed_field_count",
      );
    });
  });
});
