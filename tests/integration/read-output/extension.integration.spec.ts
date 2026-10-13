import { describe, expect, it } from "vitest";
import type { ContractsResult } from "../../../src/sdk/cli-contracts/runtime-contracts.js";
import { PmClient } from "../../../src/sdk/runtime.js";
import { handleRequest } from "../../../src/mcp/server.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("package read-output transport parity", () => {
  it("uses declared rows in CLI, SDK, MCP and discovery while refusing undeclared writers", async () => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({ root: context.pmPath, placement: "projectRoot", directory: "read-output-probe", entryFilename: "index.mjs", manifest: { name: 'read-output-probe', version: '1.0.0', entry: './index.mjs', capabilities: ['commands', 'schema'] }, entrySource: `export default { activate(api) {
        for (const name of ['probe rows', 'probe alias', 'list-probe']) api.registerCommand({ name, action: name.replaceAll(' ', '-'),
          read_output: { row_keys: ['items'] }, run: () => ({ items: Array.from({length: 8}, (_, i) => ({ id: 'row-' + i, title: 'Title ' + i, detail: 'x'.repeat(1000) })), count: 8, total: 8 }) });
        api.registerCommand({ name: 'probe singleton', read_output: { row_keys: [] }, run: () => ({ ok: true, message: 'single' }) });
        api.registerCommand({ name: 'probe write', run: () => ({ ok: true }) });
        api.registerCommand({ name: 'list-writer', run: () => ({ ok: true }) });
        api.registerFlags('probe rows', [{long:'--output-style', value_type:'string'}]);
        api.registerCommand({ name: 'collision', action: 'other-action', run: () => ({source:'path'}) });
        api.registerCommand({ name: 'different', action: 'collision', read_output:{row_keys:[]}, run: () => ({source:'action'}) });
      } };` });
      for (const path of [["probe", "rows"], ["probe", "alias"], ["list-probe"]]) {
        const cli = context.runCli([...path, "--output-limit", "2", "--output-include", "id,title", "--output-budget", "unbounded", "--json"]);
        expect(cli.code, cli.stderr).toBe(0);
        const output = JSON.parse(cli.stdout);
        expect(output.items).toEqual([{ id: "row-0", title: "Title 0" }, { id: "row-1", title: "Title 1" }]);
        expect(output.read_output.command).toBe(`extension:${path.join(" ")}`);
      }
      const client = new PmClient({ pmRoot: context.pmPath });
      const inProcess = await context.runCliInProcess(["probe", "rows", "--output-limit", "1", "--output-budget", "unbounded", "--json"], { expectJson: true });
      expect(inProcess.code, inProcess.stderr).toBe(0);
      expect((inProcess.json as {items: unknown[]}).items).toHaveLength(1);
      expect(await client.run("probe-singleton", {options:{outputBudget:"unbounded",outputRowContract:true}})).toMatchObject({ok:true,row_contract:{row_kind:"none"}});
      expect(await client.run("collision", {options:{outputBudget:"unbounded",outputRowContract:true}})).toMatchObject({source:"action",row_contract:{command:"extension:different"}});
      const sdk = await client.run("probe-rows", { options: { outputLimit: 2, outputInclude: "id,title", outputBudget: "unbounded" } }) as { items: Array<{ id: string; title: string }> };
      expect(sdk.items).toHaveLength(2);
      const mcp = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pm_run", arguments: { action: "probe-rows", path: context.pmPath, outputLimit: 2, outputInclude: "id,title", outputBudget: "unbounded" } } }) as { isError?: boolean; structuredContent: { result: typeof sdk } };
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent.result.items).toEqual(sdk.items);
      const refusal = context.runCli(["probe", "write", "--output-limit", "2", "--json"]);
      expect(refusal.code).toBe(2);
      await expect(client.run("probe-write", { options: { outputLimit: 2 } })).rejects.toThrow("only to read");
      await expect(client.run("list-writer", { options: { outputLimit: 2 } })).rejects.toThrow("only to read");
      expect(context.runCli(["list-writer", "--output-limit", "1", "--json"]).code).toBe(2);
      const infeasible = context.runCli(["probe", "rows", "--output-budget", "1", "--json"]);
      expect(infeasible.code).toBe(2);
      expect(JSON.parse(infeasible.stdout).output_budget_exceeded.reason).toBe("requested_budget_infeasible");
      expect(context.runCli(["probe", "singleton", "--output-budget", "unbounded", "--json"]).code).toBe(0);
      const discovery = await client.run("contracts", { options: { full: true, command: "probe rows", outputBudget: "unbounded" } }) as ContractsResult;
      expect(discovery.extension_commands![0]!.read_output).toEqual({ row_keys: ["items"] });
      expect(discovery.extension_commands![0]!.flags.map((flag: { flag: string }) => flag.flag)).toContain("--output-budget");
      const schema = discovery.schema as {oneOf: Array<{properties: Record<string, {const?:string;type?:string}>}>};
      expect(schema.oneOf.find((branch) => branch.properties.action.const === "probe-rows")!.properties.outputStyle.type).toBe("string");
    });
  });
});
