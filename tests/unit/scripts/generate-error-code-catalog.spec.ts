import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../scripts/generate-error-code-catalog.mjs";
import { createScriptHarness } from "../../helpers/scriptModule.js";

const harness = createScriptHarness();

describe("generate error code catalog", () => {
  it("discovers, classifies, sorts, writes, and verifies literal codes", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-");
    await mkdir(path.join(root, "src", "cli", "nested"), { recursive: true });
    await writeFile(
      path.join(root, "src", "cli", "errors.ts"),
      [
        'const a = { code: "item_not_found" };',
        'const b = { code: "lock_conflict" };',
        'const c = { code: "dependency_failed_child" };',
        'const d = { code: "unknown_flag" };',
        'const e = { code: "runtime_failure" };',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "cli", "nested", "more.ts"),
      'const duplicate = { code: "item_not_found" };',
      "utf8",
    );
    await main(root, []);
    const output = await readFile(
      path.join(root, "src", "sdk", "generated-error-code-catalog.ts"),
      "utf8",
    );
    expect(output).toContain('code: "item_not_found"');
    expect(output).toContain("exit_code: 3");
    expect(output).toContain("exit_code: 4");
    expect(output).toContain("exit_code: 5");
    expect(output).toContain("exit_code: 2");
    expect(output).toContain("exit_code: 1");
    expect(output.match(/code: "item_not_found"/g)).toHaveLength(1);
    await expect(main(root, ["--check"])).resolves.toBeUndefined();
  });

  it("fails closed for missing and stale generated output", async () => {
    const root = await harness.createTempRoot("pm-error-catalog-stale-");
    await mkdir(path.join(root, "src", "sdk"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sdk", "source.ts"),
      'const failure = { code: "invalid_fixture" };',
      "utf8",
    );
    await expect(main(root, ["--check"])).rejects.toThrow(
      "error-code catalog is stale",
    );
    await main(root, []);
    await writeFile(
      path.join(root, "src", "sdk", "generated-error-code-catalog.ts"),
      "stale\n",
      "utf8",
    );
    await expect(main(root, ["--check"])).rejects.toThrow(
      "error-code catalog is stale",
    );
  });
});
