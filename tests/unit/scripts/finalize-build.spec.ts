import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

interface FinalizeBuildModule {
  main: (repoRoot?: string) => Promise<void>;
}

const harness = createScriptHarness();

describe("finalize-build", () => {
  it("chmods present outputs and skips absent ones", async () => {
    const chmod = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      chmod,
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
