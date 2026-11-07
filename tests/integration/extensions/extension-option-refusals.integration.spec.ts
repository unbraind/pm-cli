/**
 * pm-4of199 / pm-wlxf8f: the built CLI's unknown-option refusal on an
 * extension command lists only the flags the command accepts, and two
 * spellings of one declared flag with different values are refused, as direct
 * callers are.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

const FLAGS = [
  { long: "--status-filter", short: "-s", value_type: "string", default: "open" },
  { long: "--count", short: "-c", value_type: "number" },
  { long: "--tags", short: "-t", value_type: "string", list: true },
];

const EXTENSION_SOURCE = [
  "export default {",
  "  activate(api) {",
  `    api.registerFlags("demo-flags", ${JSON.stringify(FLAGS)});`,
  "    api.registerCommand({ name: 'demo-flags', run: (context) => ({ options: context.options }) });",
  "    api.registerFlags('demo-read', [{ long: '--window', value_type: 'string' }]);",
  "    api.registerCommand({ name: 'demo-read', read_output: { row_keys: ['rows'] }, run: (context) => ({ rows: [], options: context.options }) });",
  "  },",
  "};",
  "",
].join("\n");

async function installDemoExtension(context: TempPmContext): Promise<void> {
  const extensionDir = path.join(context.pmPath, "extensions", "demo-refusal-ext");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify({ name: "demo-refusal-ext", version: "1.0.0", entry: "./index.mjs", capabilities: ["commands", "schema"] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(extensionDir, "index.mjs"), EXTENSION_SOURCE, "utf8");
}

interface Refusal {
  code: string;
  detail: string;
  flag?: string;
}

function refusal(context: TempPmContext, args: string[]): Refusal {
  const result = context.runCli([...args, "--json"]);
  expect(result.code).toBe(2);
  return JSON.parse(result.stderr) as Refusal;
}

describe("extension option refusals on the built CLI", () => {
  it("pm-4of199: an unknown-option refusal lists the declared flags and the inherited host flags only", async () => {
    await withTempPmPath(async (context) => {
      await installDemoExtension(context);
      const declared = refusal(context, ["demo-flags", "--bogus"]);
      expect(declared).toMatchObject({ code: "unknown_option", flag: "--bogus" });
      const listed = declared.detail.replace(/^.*Expected one of: /u, "").replace(/\.$/u, "").split(", ");
      expect(listed.slice(0, 3)).toEqual(["--status-filter", "--count", "--tags"]);
      expect(listed).toEqual(expect.arrayContaining(["--json", "--pm-path", "--author", "--expect-hash"]));
      for (const excluded of ["--no-extensions", "--output-limit", "--output-include", "--all", "--explain"]) {
        expect(listed).not.toContain(excluded);
      }
      // A command that declares structured read output inherits the read-output controls.
      const read = refusal(context, ["demo-read", "--bogus"]);
      expect(read.detail).toContain("--output-limit");
      expect(read.detail).not.toContain("--no-extensions");
    });
  });

  it("pm-wlxf8f: two spellings of one scalar flag with different values are refused; equal values and list flags pass", async () => {
    await withTempPmPath(async (context) => {
      await installDemoExtension(context);
      const conflict = refusal(context, ["demo-flags", "--status-filter", "open", "-s", "closed"]);
      expect(conflict).toMatchObject({
        code: "extension_option_spelling_conflict",
        detail: "Options '--status-filter' and '-s' both set --status-filter for extension command 'demo-flags' with different values.",
      });
      expect(refusal(context, ["demo-flags", "-c", "1", "--count=2"]).code).toBe("extension_option_spelling_conflict");

      const equal = context.runCli(["demo-flags", "--status-filter", "closed", "-s", "closed", "--count", "1", "-c", "1.0", "--json"], { expectJson: true });
      expect(equal).toMatchObject({ code: 0, json: { options: { statusFilter: "closed", count: 1 } } });
      const list = context.runCli(["demo-flags", "--tags", "a", "-t", "b", "--json"], { expectJson: true });
      expect(list).toMatchObject({ code: 0, json: { options: { tags: ["a", "b"] } } });
      // Repeating one spelling keeps Commander's last-value rule: it is not a spelling conflict.
      const repeated = context.runCli(["demo-flags", "-s", "open", "-s", "closed", "--json"], { expectJson: true });
      expect(repeated).toMatchObject({ code: 0, json: { options: { statusFilter: "closed" } } });
    });
  });
});
