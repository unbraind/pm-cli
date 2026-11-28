/**
 * pm-f0s4g8: the SDK transport read a whitespace-only `cliFlag` and an empty
 * alias as omitted, so `PmClient.schemaAddField` registered the default flag
 * where `pm schema add-field --cli-flag ' '` refuses. Add-field judges every
 * supplied spelling, so the transport now passes blank ones through.
 */
import { describe, expect, it } from "vitest";
import { PmClient } from "../../../../src/sdk/index.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

/** The refusal code of a promise, or "registered" when it resolves. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "registered";
  } catch (error) {
    return String((error as { code?: unknown; context?: { code?: unknown } }).code ?? (error as { context?: { code?: unknown } }).context?.code);
  }
}

describe("add-field blank spellings: the SDK refuses what the CLI refuses", () => {
  it.each([
    ["a whitespace-only flag", { cliFlag: " " }, ["--cli-flag", " "]],
    ["an empty flag", { cliFlag: "" }, ["--cli-flag", ""]],
    ["a dashes-only flag", { cliFlag: "--" }, ["--cli-flag=--"]],
    ["an empty alias", { alias: [""] }, ["--alias", ""]],
    ["a whitespace-only alias", { alias: ["ok", "  "] }, ["--alias", "ok", "--alias", "  "]],
  ])("%s", async (_label, sdkOptions, argv) => {
    await withTempPmPath(async ({ pmPath, runCli }) => {
      const cli = runCli(["schema", "add-field", "review_owner", "--type", "string", "--commands", "list", ...argv, "--json"]);
      expect(cli.code).toBe(2);
      expect(`${cli.stdout}${cli.stderr}`).toContain("schema_field_flag_invalid");
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await expect(outcome(client.schemaAddField("review_owner", { type: "string", commands: ["list"], ...sdkOptions }))).resolves.toBe("schema_field_flag_invalid");
    });
  });

  it("keeps an omitted flag on its default, reads the options record, and lets a non-list alias fall back", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, noExtensions: true });
      await expect(client.schemaAddField("review_owner", { type: "string", commands: ["list"] })).resolves.toMatchObject({ field: { key: "review_owner" } });
      // A blank spelling in the options record is judged like a top-level one, and a top-level spelling wins.
      await expect(outcome(client.run("schema", { name: "lead", options: { subcommand: "add-field", fieldType: "string", commands: ["list"], cliFlag: " " } }))).resolves.toBe("schema_field_flag_invalid");
      await expect(client.run("schema", { name: "lead", cliFlag: "team-lead", options: { subcommand: "add-field", fieldType: "string", commands: ["list"], cliFlag: " " } })).resolves.toMatchObject({ field: { cli_flag: "team-lead" } });
      await expect(client.run("schema", { name: "owner_two", options: { subcommand: "add-field", fieldType: "string", commands: ["list"], alias: "solo" } })).resolves.toMatchObject({ field: { key: "owner_two" } });
      // A top-level value that is not a string falls back to the options record (Codex review).
      await expect(client.run("schema", { name: "owner_three", cliFlag: null, options: { subcommand: "add-field", fieldType: "string", commands: ["list"], cliFlag: "team-three" } })).resolves.toMatchObject({ field: { cli_flag: "team-three" } });
    });
  });
});
