import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { appendCommanderExtensionFailures, formatCommanderUsageJson } from "../../../src/cli/commander-usage.js";
import { maybeRenderBootstrapJsonHelp } from "../../../src/cli/help-json-payload.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("unknown command help routing", () => {
  it("accounts after lean projection, extension enrichment and bootstrap help refusal", async () => {
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const root = new Command("pm");
    root.command("search");
    try {
      process.argv = [process.execPath, "pm", "search", "--unsupported", "--json", "--token-accounting"];
      const rendered = await formatCommanderUsageJson(new Error("unknown option '--unsupported'"), root, new Map(), true);
      const enriched = appendCommanderExtensionFailures(rendered, true, [{
        name: "test-extension", layer: "project", error: "entrypoint missing",
        declared_command_match: true, recovery_commands: ["pm package doctor"],
      }]);
      for (const output of [rendered, enriched]) {
        const { token_accounting: receipt, ...payload } = JSON.parse(output);
        expect(receipt.total_bytes).toBe(Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`));
        expect(receipt.total_bytes + receipt.accounting_receipt_bytes).toBe(Buffer.byteLength(`${output}\n`));
      }
      let stderr = "";
      const capture = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      try {
        expect(await maybeRenderBootstrapJsonHelp(root, ["missing", "--help", "--json", "--token-accounting"], new Map())).toBe(true);
      } finally { capture.mockRestore(); }
      const { token_accounting: receipt, ...payload } = JSON.parse(stderr);
      expect(payload.code).toBe("unknown_command");
      expect(receipt.total_bytes + receipt.accounting_receipt_bytes).toBe(Buffer.byteLength(stderr));
    } finally {
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
    }
  });

  it("returns usage failures for arbitrary and plausible unknown help paths", async () => {
    await withTempPmPath(async (context) => {
      for (const command of ["definitely-not-a-command", "link", "learn"]) {
        const result = context.runCli([command, "--help"]);
        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.stdout).not.toContain("Usage: pm [options] [command]");
        expect(result.stderr).toContain(`Unknown command ${command}`);
      }
    });
  });

  it("accepts plural test collection help and routes unknown commands to complete discovery", async () => {
    await withTempPmPath(async (context) => {
      for (const command of ["test", "tests", "files"]) {
        const result = context.runCli([command, "pm-example", "--help"]);
        expect(result.code, `${command}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("--help");
        const structured = context.runCli([command, "pm-example", "--help", "--json"], { expectJson: true });
        expect(structured.code).toBe(0);
        expect(structured.json).toMatchObject({ resolved_path: command === "tests" ? "test" : command });
      }
      const unknown = context.runCli(["tesst"]);
      expect(unknown.code).toBe(EXIT_CODE.USAGE);
      expect(unknown.stderr).toContain("pm --help --all");
      expect(unknown.stderr).not.toContain('Run "pm --help"');
    });
  });

  it("accounts for the exact final JSON refusal bytes in either option order", async () => {
    await withTempPmPath(async (context) => {
      for (const args of [
        ["--json", "--token-accounting", "search", "query", "--unrecognized-flag"],
        ["search", "query", "--unrecognized-flag", "--json", "--token_accounting"],
        ["missing-command", "--help", "--json", "--token-accounting"],
      ]) {
        const result = context.runCli(args, { expectJson: true });
        expect(result.code).toBe(EXIT_CODE.USAGE);
        const { token_accounting: receipt, ...payload } = JSON.parse(result.stderr);
        expect(receipt).toMatchObject({
          measurement_scope: "output_before_token_accounting",
          total_bytes: Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`),
        });
        expect(receipt.total_bytes + receipt.accounting_receipt_bytes).toBe(Buffer.byteLength(result.stderr));
      }
    });
  });
});
