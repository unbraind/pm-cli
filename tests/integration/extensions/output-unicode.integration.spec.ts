import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTestExtension } from "../../helpers/extensions.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function assertUnicodeOutcome(completed: SpawnSyncReturns<string>, kind: string, format: string): void {
  expect(completed.error).toBeUndefined();
  if (kind === "valid") {
    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stdout).toContain("😀");
    expect(completed.stdout).toContain("kept");
    return;
  }
  expect(completed.status).toBe(2);
  expect(completed.stdout).toBe("");
  expect(completed.stderr).toContain("unpaired surrogate");
  if (format === "json") expect(JSON.parse(completed.stderr).code).toBe("text_unpaired_surrogate");
  expect(completed.stderr).toContain(kind === "key" ? "nested[0]" : "nested[0].value");
}

describe("extension output Unicode policy (pm-gh1624)", () => {
  it.each(["node", "bun"])("refuses malformed output consistently on %s and preserves valid pairs", async (runtime) => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: path.join(context.pmPath, "extensions"),
        directory: "unicode-probe",
        name: "unicode-probe",
        manifest: { name: "unicode-probe", version: "1.0.0", entry: "index.mjs", capabilities: ["commands"] },
        entryFilename: "index.mjs",
        entrySource: `export function activate(api) {
          api.registerCommand({ name: "unicode probe", arguments: [{ name: "mode", required: true }], run: ({ args }) => args[0] === "valid"
            ? { sibling: "kept", nested: ["😀"] }
            : args[0] === "key" ? { nested: [{ ["bad\\udc00"]: "kept" }] }
            : { sibling: "kept", nested: [{ value: "bad\\ud800" }] } });
        }`,
      });
      for (const format of ["json", "toon"]) {
        for (const kind of ["value", "key", "valid"]) {
          const completed = spawnSync(runtime === "node" ? process.execPath : "bun", [
            path.resolve("dist/cli.js"), "unicode", "probe", kind, "--output-format", format,
          ], { cwd: context.tempRoot, env: context.env, encoding: "utf8" });
          assertUnicodeOutcome(completed, kind, format);
        }
      }
    });
  }, 30_000);
});
