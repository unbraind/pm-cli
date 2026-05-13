import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("MCP dynamic package actions", () => {
  it("invokes installed package actions discovered through runtime contracts", async () => {
    await withTempPmPath(async (context) => {
      const install = context.runCli(["--json", "install", "all", "--project"], { expectJson: true });
      expect(install.code).toBe(0);

      const contracts = await handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_contracts",
          arguments: {
            path: context.pmPath,
            options: {
              runtimeOnly: true,
              availabilityOnly: true,
            },
          },
        },
      });
      const contractResult = (contracts?.structuredContent as { result?: { actions?: string[] } } | undefined)?.result;
      expect(contractResult?.actions).toEqual(expect.arrayContaining(["todos-export"]));

      const exportResult = await handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "todos-export",
            folder: path.join(context.tempRoot, "todos-out"),
          },
        },
      });

      expect(exportResult?.isError).not.toBe(true);
      const result = (exportResult?.structuredContent as { result?: { ok?: boolean; exported?: number } } | undefined)?.result;
      expect(result).toMatchObject({
        ok: true,
        exported: expect.any(Number),
      });
    });
  });
});
