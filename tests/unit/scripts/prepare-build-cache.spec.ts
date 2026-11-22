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
  it("drops the cache and the ledger when a compacted output changed after its digest was recorded", async () => {
    vi.doUnmock("node:fs/promises");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createHash } = await import("node:crypto");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = await harness.createTempRoot("pm-build-cache-");
    const buildInfo = path.join(root, ".cache", "tsbuildinfo", "pm-cli.tsbuildinfo");
    const ledger = path.join(root, "dist", ".runtime-compaction.json");
    const seed = async (files: unknown) => {
      await fs.mkdir(path.join(root, "dist", "sdk"), { recursive: true });
      await fs.mkdir(path.dirname(buildInfo), { recursive: true });
      await fs.writeFile(path.join(root, "dist", "cli.js"), "compacted");
      await fs.writeFile(path.join(root, "dist", "sdk", "index.js"), "compacted too");
      await fs.writeFile(buildInfo, "{}");
      await fs.writeFile(ledger, JSON.stringify({ files }));
    };
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const present = (file: string) => fs.stat(file).then(() => true, () => false);
    const mod = await harness.importModule<PrepareBuildCacheModule>("scripts/prepare-build-cache.mjs");
    // Matching digests, and a ledger that records nothing, keep the incremental cache.
    for (const files of [{ "cli.js": digest("compacted"), "sdk/index.js": digest("compacted too") }, null]) {
      await seed(files);
      await mod.main(root);
      expect([await present(buildInfo), await present(ledger)]).toEqual([true, true]);
    }
    // An injected or half-written output, and a recorded output that is gone, force raw compiler output.
    for (const files of [{ "cli.js": digest("before injection") }, { "cli.js": digest("compacted"), "removed.js": digest("x") }]) {
      await seed(files);
      await mod.main(root);
      expect([await present(buildInfo), await present(ledger)]).toEqual([false, false]);
    }
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("an output changed after compaction"))).toBe(true);
  });
});
