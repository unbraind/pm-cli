import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule.js";

const harness = createScriptHarness();

describe("published workspace compatibility acceptance", () => {
  it("can be imported without a command entrypoint or network side effects", async () => {
    process.argv = [process.execPath];
    const output = vi.spyOn(console, "log");
    const module = await harness.importModule<{ main: unknown }>("scripts/release/workspace-compatibility.mjs");
    expect(typeof module.main).toBe("function");
    expect(output).not.toHaveBeenCalled();
  });
  it.runIf(process.platform !== "win32")("executes the declared four-way matrix using real published artifacts and native Git drivers", async () => {
    process.env.GIT_DIR = "/invalid-inherited-git-dir";
    process.env.GIT_WORK_TREE = "/invalid-inherited-worktree";
    const output = vi.spyOn(console, "log");
    process.argv = [process.execPath, path.resolve("scripts/release/workspace-compatibility.mjs"), "--json"];
    await harness.importModule("scripts/release/workspace-compatibility.mjs");
    const receipt = output.mock.calls.map(([value]) => JSON.parse(String(value)) as { ok: boolean; matrix: Array<Record<string, unknown>> }).find((value) => Array.isArray(value.matrix));
    expect(receipt).toMatchObject({ ok: true });
    expect(receipt?.matrix).toHaveLength(4);
    expect(receipt?.matrix.every((row) => row.unknown_fields && row.restore && row.git_merge && row.history && row.sdk && row.cli)).toBe(true);
  }, 180_000);
});
