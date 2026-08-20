import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import { PmClient } from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("tracker preflight transport parity", () => {
  it("preserves structured missing-root recovery across SDK, CLI, and MCP", async () => {
    await withTempPmPath(async (context) => {
      const missingRoot = path.join(context.tempRoot, "missing-project");
      const client = new PmClient({ pmRoot: missingRoot });

      await expect(client.list()).rejects.toMatchObject({
        code: "tracker_root_missing",
        exitCode: 3,
        context: {
          recovery: {
            suggested_retry_args: [
              "--pm-path",
              missingRoot,
              "init",
              "--defaults",
              "--agent-guidance",
              "skip",
            ],
          },
        },
      });

      const cli = context.runCli([
        "--pm-path",
        missingRoot,
        "list",
        "--json",
      ]);
      expect(cli.code).toBe(3);
      expect(JSON.parse(cli.stderr)).toMatchObject({
        code: "tracker_root_missing",
        recovery: {
          suggested_retry_args: [
            "--pm-path",
            missingRoot,
            "init",
            "--defaults",
            "--agent-guidance",
            "skip",
          ],
        },
      });

      await expect(
        handleRequest({
          id: 1,
          method: "tools/call",
          params: {
            name: "pm_run",
            arguments: { action: "list", path: missingRoot },
          },
        }),
      ).rejects.toMatchObject({
        code: "tracker_root_missing",
        exitCode: 3,
        context: {
          resolved_path: missingRoot,
          recovery: {
            suggested_retry_args: [
              "--pm-path",
              missingRoot,
              "init",
              "--defaults",
              "--agent-guidance",
              "skip",
            ],
          },
        },
      });
    });
  });
});
