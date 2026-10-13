import path from "node:path";
import { expect, it } from "vitest";
import { decodeToon, encodeToon } from "@unbrained/pm-cli/sdk/testing";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

it("renders inline-placeholder extension flags once and dispatches canonical option keys", async () => {
  await withTempPmPath(async (context) => {
    await writeTestExtension({
      root: path.join(context.pmPath, "extensions"), directory: "authoring-probe",
      manifest: { name: "authoring-probe", version: "1.0.0", entry: "index.mjs", capabilities: ["commands", "schema"] },
      entryFilename: "index.mjs",
      entrySource: `export default { activate(api) {
        api.registerCommand({ name: "forge probe", flags: [
          { long: "--repo <project>", type: "string", description: "Repository identity" },
          { long: "--pr=<number>", type: "number", description: "Pull request" },
          { long: "--maybe [label]", description: "Optional label" }
        ], run(context) { return { status: "open", repo: context.options.repo, pr: context.options.pr, maybe: context.options.maybe }; } });
      } };`,
    });
    const help = context.runCli(["forge", "probe", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout.match(/--repo/g)).toHaveLength(1);
    expect(help.stdout).toContain("--repo <project>");
    expect(help.stdout).not.toContain("<project> <value>");
    const result = context.runCli(["forge", "probe", "--repo", "sample/project", "--pr=7", "--maybe", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "open", repo: "sample/project", pr: 7, maybe: true });
    const human = context.runCli(["forge", "probe", "--repo", "sample/project", "--pr=7", "--maybe"]);
    expect(human.status, human.stderr).toBe(0);
    expect(decodeToon(human.stdout)).toMatchObject({ status: "open", repo: "sample/project", pr: 7, maybe: true });
    const structuredHelp = context.runCli(["forge", "probe", "--help", "--json"]);
    expect(structuredHelp.status, structuredHelp.stderr).toBe(0);
    const options = JSON.parse(structuredHelp.stdout).options as Array<Record<string, unknown>>;
    expect(options.filter((option) => option.long === "--repo")).toHaveLength(1);
    expect(options.find((option) => option.long === "--maybe")).toMatchObject({ value_name: "label", takes_value: true, value_required: false });
  });
});

it("round-trips host-pinned public TOON values with native codec options", () => {
  const value = { rows: [{ status: "open", count: 0, text: '[node]: λ,= "quoted"\nline' }, { status: "closed", count: 2, text: "plain" }], enabled: false, missing: null };
  expect(decodeToon(encodeToon(value, { delimiter: "|", indentSize: 4 }), { indentSize: 4 })).toEqual(value);
  expect(() => decodeToon("rows[2]: one")).toThrow();
});
