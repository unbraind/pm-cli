import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

interface FinalizeBuildModule {
  main: (repoRoot?: string) => Promise<void>;
}

const harness = createScriptHarness();

describe("finalize-build", () => {
  it("ships a compact manifest without changing the readable source or its JSON meaning", async () => {
    const root = await harness.createTempRoot("pm-manifest-pack-");
    await mkdir(path.join(root, "sdk"));
    await mkdir(path.join(root, "dist", "sdk"), { recursive: true });
    const source = JSON.stringify({ entrypoints: { "./sdk": { symbols: ["historyRepair", "getItemAt"] } } }, null, 2);
    await writeFile(path.join(root, "sdk", "public-surface.json"), source);
    const mod = await harness.importModule<FinalizeBuildModule>("scripts/finalize-build.mjs");
    await mod.main(root);
    const packed = await readFile(path.join(root, "dist", "sdk", "public-surface.json"), "utf8");
    expect(JSON.parse(packed)).toEqual(JSON.parse(source));
    expect(packed.length).toBeLessThan(source.length);
    expect(await readFile(path.join(root, "sdk", "public-surface.json"), "utf8")).toBe(source);
  });

  it("chmods present outputs and skips absent ones", async () => {
    const chmod = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      chmod,
      readFile: vi.fn(async () => "{}"),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async (target: string) => {
        if (String(target).includes("server.js")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return {};
      }),
    }));
    const mod = await harness.importModule<FinalizeBuildModule>("scripts/finalize-build.mjs");
    await mod.main("/repo");
    expect(chmod).toHaveBeenCalledTimes(1);
    expect(chmod.mock.calls[0]?.[0]).toContain(path.join("dist", "cli.js"));
  });

  it("defaults repoRoot to process.cwd() when no argument is given", async () => {
    const chmod = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      chmod,
      readFile: vi.fn(async () => "{}"),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({})),
    }));
    const mod = await harness.importModule<FinalizeBuildModule>("scripts/finalize-build.mjs");
    await mod.main();
    expect(chmod.mock.calls[0]?.[0]).toContain(path.join(process.cwd(), "dist", "cli.js"));
  });

  it("rethrows a non-ENOENT stat error", async () => {
    vi.doMock("node:fs/promises", () => ({
      chmod: vi.fn(async () => {}),
      stat: vi.fn(async () => {
        throw Object.assign(new Error("perm"), { code: "EACCES" });
      }),
    }));
    const mod = await harness.importModule<FinalizeBuildModule>("scripts/finalize-build.mjs");
    await expect(mod.main("/repo")).rejects.toThrow("perm");
  });
});
