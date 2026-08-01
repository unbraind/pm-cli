import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../src/mcp/server.js";
import { readHistoryEntries } from "../../../src/sdk/history-read.js";
import { getHistoryPath } from "../../../src/sdk/runtime-primitives.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

/** Verifies that the unavoidable MCP tool result uses the same lean mutation contract as the CLI default. */
describe("MCP mutation envelope parity", () => {
  it("returns the CLI default create shape without an opt-in flag", async () => {
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

      const response = (await handleRequest({
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
    await withTempPmPath(async (context) => {
      const response = (await handleRequest({
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

  it("honors idOnly for append through the aggregated pm_run surface", async () => {
    await withTempPmPath(async (context) => {
      const created = (await handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "pm_create",
          arguments: {
            path: context.pmPath,
            title: "Append id-only parity",
            type: "Task",
            status: "open",
          },
        },
      })) as { structuredContent: { result: { id: string } } };
      const response = (await handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            action: "append",
            path: context.pmPath,
            id: created.structuredContent.result.id,
            body: "Appended through pm_run.",
            idOnly: true,
          },
        },
      })) as { structuredContent: { result: Record<string, unknown> } };

      expect(response.structuredContent.result).toEqual({
        id: created.structuredContent.result.id,
        status: "open",
      });
    });
  });

  it("records field-identical CLI and MCP provenance and resolves mutable signals per mutation", async () => {
    const priorSignals = {
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      PM_AGENT_EFFORT: process.env.PM_AGENT_EFFORT,
      PM_AGENT_MODEL: process.env.PM_AGENT_MODEL,
      PM_AGENT_ROLE: process.env.PM_AGENT_ROLE,
    };
    Object.assign(process.env, {
      CODEX_HOME: "/tmp/pm-provenance-test",
      CODEX_THREAD_ID: "paired-cli-mcp-session",
      PM_AGENT_EFFORT: "high",
      PM_AGENT_MODEL: "paired-model",
      PM_AGENT_ROLE: "implementation",
    });
    try {
      await withTempPmPath(async (context) => {
        const cli = context.runCli(
          [
            "create",
            "--json",
            "--title",
            "CLI provenance parity",
            "--type",
            "Task",
            "--status",
            "open",
          ],
          { expectJson: true, preserveDefaultMutationOutput: true },
        );
        expect(cli.code).toBe(0);
        const cliId = (cli.json as { id: string }).id;

        await handleRequest({
          jsonrpc: "2.0",
          id: 20,
          method: "initialize",
          params: {
            clientInfo: {
              name: "Codex",
              version: "test",
              session: "paired-cli-mcp-session",
              provenance: {
                effort: "high",
                model: "paired-model",
                role: "implementation",
              },
            },
          },
        });
        const mcp = (await handleRequest({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "pm_create",
            arguments: {
              path: context.pmPath,
              title: "MCP provenance parity",
              type: "Task",
              status: "open",
            },
          },
        })) as { structuredContent: { result: { id: string } } };
        const mcpId = mcp.structuredContent.result.id;
        const [cliEntry] = await readHistoryEntries(
          getHistoryPath(context.pmPath, cliId),
          cliId,
        );
        const [mcpEntry] = await readHistoryEntries(
          getHistoryPath(context.pmPath, mcpId),
          mcpId,
        );
        expect({
          author: mcpEntry?.author,
          author_source: mcpEntry?.author_source,
          agent_harness: mcpEntry?.agent_harness,
          agent_instance: mcpEntry?.agent_instance,
          agent_provenance: mcpEntry?.agent_provenance,
        }).toEqual({
          author: cliEntry?.author,
          author_source: cliEntry?.author_source,
          agent_harness: cliEntry?.agent_harness,
          agent_instance: cliEntry?.agent_instance,
          agent_provenance: cliEntry?.agent_provenance,
        });

        process.env.PM_AGENT_EFFORT = "xhigh";
        const later = (await handleRequest({
          jsonrpc: "2.0",
          id: 22,
          method: "tools/call",
          params: {
            name: "pm_create",
            arguments: {
              path: context.pmPath,
              title: "MCP mutation-time provenance",
              type: "Task",
              status: "open",
            },
          },
        })) as { structuredContent: { result: { id: string } } };
        const [laterEntry] = await readHistoryEntries(
          getHistoryPath(context.pmPath, later.structuredContent.result.id),
          later.structuredContent.result.id,
        );
        expect(laterEntry?.agent_provenance?.effort).toEqual({
          source: "override",
          value: "xhigh",
        });
      });
    } finally {
      for (const [key, value] of Object.entries(priorSignals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
