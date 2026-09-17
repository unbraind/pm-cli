import { EventEmitter } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

interface BuildModule { main(root?: string): Promise<number> }
const harness = createScriptHarness();

describe("complete build pipeline", () => {
  it("reports a producer refusal through the executable entrypoint", async () => {
    process.env.PM_BUILD_CONSUMER_LEASE = "consumer";
    process.argv = [process.execPath, path.resolve("scripts/build.mjs")];
    const reported = new Promise<unknown>((resolve) => {
      vi.spyOn(console, "error").mockImplementation(resolve);
    });
    await harness.importModule<BuildModule>("scripts/build.mjs");
    expect(String(await reported)).toContain("Cannot rebuild dist");
    expect(process.exitCode).toBe(1);
  });

  it("supports imports without an executable argument", async () => {
    process.argv = [process.execPath];
    expect((await harness.importModule<BuildModule>("scripts/build.mjs")).main).toBeTypeOf("function");
  });
  it("runs real stage processes in order and removes the incomplete receipt only after success", async () => {
    delete process.env.PM_BUILD_CONSUMER_LEASE;
    const root = await harness.createTempRoot("pm-build-pipeline-");
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "node_modules/typescript/bin"), { recursive: true });
    const stages = ["scripts/prepare-build-cache.mjs", "node_modules/typescript/bin/tsc", "scripts/bundle-cli.mjs", "scripts/finalize-build.mjs"];
    for (const [index, filename] of stages.entries()) {
      await writeFile(path.join(root, filename), `const fs = require('node:fs'); fs.accessSync('.cache/build-incomplete'); fs.appendFileSync('stages', '${index}');`.replace("const fs = require('node:fs');", filename.endsWith(".mjs") ? "import fs from 'node:fs';" : "const fs = require('node:fs');"));
    }
    const script = path.resolve("scripts/build.mjs");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    process.argv = [process.execPath, script];
    process.exitCode = undefined;
    await harness.importModule<BuildModule>("scripts/build.mjs");
    await harness.waitForCondition(() => expect(process.exitCode).toBe(0));
    expect(await readFile(path.join(root, "stages"), "utf8")).toBe("0123");
    await expect(access(path.join(root, ".cache/build-incomplete"))).rejects.toThrow();
  });

  it.each([[7, null, 7], [null, "SIGTERM", 1], [null, null, 1]] as const)("retains failure evidence for status %s and signal %s", async (code, signal, expected) => {
    delete process.env.PM_BUILD_CONSUMER_LEASE;
    const root = await harness.createTempRoot("pm-build-failure-");
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", code, signal));
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn }));
    const mod = await harness.importModule<BuildModule>("scripts/build.mjs");
    expect(await mod.main(root)).toBe(expected);
    expect(spawn).toHaveBeenCalledTimes(1);
    await access(path.join(root, ".cache/build-incomplete"));
    await expect(access(path.join(root, ".cache/build-lease"))).rejects.toThrow();
  });

  it("rejects a reentrant producer before touching files", async () => {
    process.env.PM_BUILD_CONSUMER_LEASE = "consumer";
    const mod = await harness.importModule<BuildModule>("scripts/build.mjs");
    await expect(mod.main()).rejects.toThrow("Cannot rebuild dist");
  });
});
