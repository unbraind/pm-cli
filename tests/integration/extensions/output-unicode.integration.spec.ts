import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const runtimes = process.env.CI || spawnSync("bun", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0
  ? ["node", "bun"] : ["node"];

function assertUnicodeOutcome(completed: SpawnSyncReturns<string>, kind: string, format: string): void {
  expect(completed.error).toBeUndefined();
  if (kind === "valid") {
    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stdout).toContain("😀");
    expect(completed.stdout).toContain("kept");
    if (format === "json") expect(JSON.parse(completed.stdout)).toEqual({ sibling: "kept", nested: ["😀"], count: 3, enabled: true });
    else {
      expect(completed.stdout).toContain("count: 3");
      expect(completed.stdout).toContain("enabled: true");
    }
    return;
  }
  expect(completed.status).toBe(2);
  expect(completed.stdout).toBe("");
  expect(completed.stderr).toContain("unpaired surrogate");
  if (format === "json") expect(JSON.parse(completed.stderr).code).toBe("text_unpaired_surrogate");
  expect(completed.stderr).toContain(kind === "key" ? "nested[0]" : "nested[0].value");
}

describe("extension output Unicode policy (pm-gh1624)", () => {
  it.each(runtimes)("refuses malformed output consistently on %s and preserves valid pairs", async (runtime) => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "unicode-probe",
        name: "unicode-probe",
        manifest: { name: "unicode-probe", version: "1.0.0", entry: "index.mjs", capabilities: ["commands"] },
        entryFilename: "index.mjs",
        entrySource: `export function activate(api) {
          api.registerCommand({ name: "unicode probe", arguments: [{ name: "mode", required: true }], run: ({ args }) => args[0] === "valid"
            ? { sibling: Object("kept"), nested: [Object("😀")], count: Object(3), enabled: Object(true) }
            : args[0] === "key" ? { nested: [{ ["bad\\udc00"]: "kept" }] }
            : args[0] === "serialized-value" ? { nested: [{ toJSON() { return { value: "bad\\ud800" }; } }] }
            : { sibling: "kept", nested: [{ value: "bad\\ud800" }] } });
        }`,
      });
      for (const format of ["json", "toon"]) {
        for (const kind of ["value", "key", "serialized-value", "valid"]) {
          const completed = spawnSync(runtime === "node" ? process.execPath : "bun", [
            path.resolve("dist/cli.js"), "unicode", "probe", kind, "--output-format", format,
          ], { cwd: context.tempRoot, env: context.env, encoding: "utf8" });
          assertUnicodeOutcome(completed, kind, format);
        }
      }
    });
  }, 30_000);
});
