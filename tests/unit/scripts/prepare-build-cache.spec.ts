import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

interface PrepareBuildCacheModule {
  main: (repoRoot?: string) => Promise<void>;
}

const harness = createScriptHarness();

describe("prepare-build-cache", () => {
  it("removes the stale build cache when a required output is missing", async () => {
    const rmMock = vi.fn(async () => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("node:fs/promises", () => ({
      rm: rmMock,
      stat: vi.fn(async (target: string) => {
        if (String(target).includes("cli.js")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return {};
      }),
    }));
    const mod = await harness.importModule<PrepareBuildCacheModule>("scripts/prepare-build-cache.mjs");
    await mod.main("/repo");
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("Removed stale"))).toBe(true);
  });

  it("is a no-op when all required outputs are present", async () => {
    const rmMock = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      rm: rmMock,
      stat: vi.fn(async () => ({})),
    }));
    const mod = await harness.importModule<PrepareBuildCacheModule>("scripts/prepare-build-cache.mjs");
    await mod.main("/repo");
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("does not remove the cache when output is missing but the cache file is absent too", async () => {
    const rmMock = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      rm: rmMock,
      stat: vi.fn(async () => {
        // Everything missing -> missingOutput non-empty but buildInfo also absent.
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    }));
    const mod = await harness.importModule<PrepareBuildCacheModule>("scripts/prepare-build-cache.mjs");
    await mod.main("/repo");
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("defaults repoRoot to process.cwd() when no argument is given", async () => {
    const rmMock = vi.fn(async () => {});
    vi.doMock("node:fs/promises", () => ({
      rm: rmMock,
      stat: vi.fn(async () => ({})),
    }));
    const mod = await harness.importModule<PrepareBuildCacheModule>("scripts/prepare-build-cache.mjs");
    await mod.main();
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("rethrows a non-ENOENT stat error", async () => {
    vi.doMock("node:fs/promises", () => ({
      rm: vi.fn(async () => {}),
      stat: vi.fn(async () => {
        throw Object.assign(new Error("io"), { code: "EIO" });
      }),
    }));
    const mod = await harness.importModule<PrepareBuildCacheModule>("scripts/prepare-build-cache.mjs");
    await expect(mod.main("/repo")).rejects.toThrow("io");
  });
});
