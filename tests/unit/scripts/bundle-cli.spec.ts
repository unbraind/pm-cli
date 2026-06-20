import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["esbuild"]);

const SCRIPT = "scripts/bundle-cli.mjs";

type BundleModule = {
  sleep: (ms: number) => Promise<void>;
  acquireBundleBuildLock: () => Promise<() => Promise<void>>;
  collectFiles: (directory: string) => Promise<string[]>;
  removeStaleBundleFiles: (outputs: Record<string, unknown>) => Promise<void>;
  main: () => Promise<void>;
};

function mockBundleFs(impl: Record<string, unknown>) {
  vi.doMock("node:fs/promises", () => ({
    lstat: vi.fn(),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
    rename: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
    unlink: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    ...impl,
  }));
  vi.doMock("esbuild", () => ({ build: vi.fn(async () => ({ metafile: { outputs: {} } })) }));
}

interface MainMocks {
  mkdir?: (target: string) => Promise<void>;
  stat?: (target: string) => Promise<{ mtimeMs: number }>;
  rename?: (source: string, destination: string) => Promise<void>;
  rm?: (target: string) => Promise<void>;
  readdir?: (target: string) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>>;
  lstat?: (target: string) => Promise<{ mtimeMs: number } | null>;
  unlink?: (target: string) => Promise<void>;
  readFile?: (target: string, encoding: string) => Promise<string>;
  writeFile?: (target: string, content: string, encoding: string) => Promise<void>;
  build?: () => Promise<{ metafile: { outputs: Record<string, Record<string, unknown>> } }>;
}

async function runMainScenario(mocks: MainMocks = {}) {
  const mkdir = vi.fn(async (target: string) => {
    if (mocks.mkdir) await mocks.mkdir(target);
  });
  const stat = vi.fn(async (target: string) => (mocks.stat ? mocks.stat(target) : { mtimeMs: Date.now() }));
  const rename = vi.fn(async (source: string, destination: string) => {
    if (mocks.rename) await mocks.rename(source, destination);
  });
  const rm = vi.fn(async (target: string) => {
    if (mocks.rm) await mocks.rm(target);
  });
  const readdir = vi.fn(async (target: string) => (mocks.readdir ? mocks.readdir(target) : []));
  const lstat = vi.fn(async (target: string) =>
    mocks.lstat ? mocks.lstat(target) : { mtimeMs: Date.now() - 20 * 60_000 },
  );
  const unlink = vi.fn(async (target: string) => {
    if (mocks.unlink) await mocks.unlink(target);
  });
  const readFile = vi.fn(async (target: string, encoding: string) =>
    mocks.readFile ? mocks.readFile(target, encoding) : '#!/usr/bin/env node\nawait import("./cli/main.js")\n',
  );
  const writeFile = vi.fn(async (target: string, content: string, encoding: string) => {
    if (mocks.writeFile) await mocks.writeFile(target, content, encoding);
  });
  vi.doMock("node:fs/promises", () => ({ lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile }));

  const build = vi.fn(async () =>
    mocks.build ? mocks.build() : { metafile: { outputs: { "dist/cli-bundle/main.js": {} } } },
  );
  vi.doMock("esbuild", () => ({ build }));

  const exitSpy = harness.mockProcessExit();
  let failure: unknown = null;
  try {
    const mod = await harness.importModule<BundleModule>(SCRIPT);
    await mod.main();
  } catch (error) {
    failure = error;
  }
  exitSpy.mockRestore();
  return { failure, mkdir, stat, rename, rm, readdir, lstat, unlink, readFile, writeFile, build };
}

describe("bundle-cli main()", () => {
  it("recovers a stale lock, prunes stale bundle files, and rewrites the cli entrypoint", async () => {
    let lockAttempts = 0;
    const scenario = await runMainScenario({
      mkdir: async (target) => {
        if (target.endsWith(".cli-bundle-build.lock")) {
          lockAttempts += 1;
          if (lockAttempts === 1) {
            throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
          }
        }
      },
      stat: async () => ({ mtimeMs: Date.now() - 11 * 60_000 }),
      readdir: async () => [
        { name: "main.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        { name: "obsolete.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      ],
      lstat: async (target) => ({ mtimeMs: target.endsWith("obsolete.js") ? Date.now() - 11 * 60_000 : Date.now() }),
      build: async () => ({ metafile: { outputs: { "dist/cli-bundle/main.js": {} } } }),
      readFile: async () => '#!/usr/bin/env node\nawait import("./cli/main.js")\n',
    });

    expect(scenario.failure).toBeNull();
    expect(scenario.rename).toHaveBeenCalled();
    expect(scenario.unlink).toHaveBeenCalledWith(expect.stringContaining("obsolete.js"));
    expect(scenario.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(path.join("dist", "cli.js")),
      expect.stringContaining('await import("./cli-bundle/main.js")'),
      "utf8",
    );
    expect(scenario.rm.mock.calls.some((call) => String(call[0]).includes(".cli-bundle-build.lock"))).toBe(true);
  });

  it("exits early when the cli is already bundled and never rewrites", async () => {
    const alreadyBundled = await runMainScenario({
      readFile: async () => '#!/usr/bin/env node\nawait import("./cli-bundle/main.js")\n',
    });
    expect(String(alreadyBundled.failure ?? "")).toContain("EXIT:0");
    expect(alreadyBundled.writeFile).not.toHaveBeenCalled();
  });

  it("throws when the rewrite marker is missing from the cli source", async () => {
    const missingMarker = await runMainScenario({
      readFile: async () => '#!/usr/bin/env node\nconsole.log("missing marker")\n',
    });
    expect(String(missingMarker.failure ?? "")).toContain("Unable to rewrite dist/cli.js");
  });
});

describe("bundle-cli helpers", () => {
  it("sleep resolves after the given delay (fake timers)", async () => {
    mockBundleFs({});
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    vi.useFakeTimers();
    let done = false;
    const p = mod.sleep(100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it("acquireBundleBuildLock acquires immediately and releases", async () => {
    mockBundleFs({ mkdir: vi.fn(async () => {}) });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    const release = await mod.acquireBundleBuildLock();
    expect(typeof release).toBe("function");
    await release();
  });

  it("acquireBundleBuildLock rethrows a non-EEXIST mkdir error", async () => {
    let firstDir = true;
    mockBundleFs({
      mkdir: vi.fn(async (target: string) => {
        if (String(target).endsWith(".cli-bundle-build.lock") && firstDir) {
          firstDir = false;
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
      }),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    await expect(mod.acquireBundleBuildLock()).rejects.toThrow("disk full");
  });

  it("acquireBundleBuildLock continues when the lock vanished (stat ENOENT) then acquires", async () => {
    let attempts = 0;
    mockBundleFs({
      mkdir: vi.fn(async (target: string) => {
        if (String(target).endsWith(".cli-bundle-build.lock")) {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
      }),
      stat: vi.fn(async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    const release = await mod.acquireBundleBuildLock();
    await release();
    expect(attempts).toBe(2);
  });

  it("acquireBundleBuildLock rethrows a non-ENOENT stat error", async () => {
    mockBundleFs({
      mkdir: vi.fn(async (target: string) => {
        if (String(target).endsWith(".cli-bundle-build.lock")) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
      }),
      stat: vi.fn(async () => {
        throw Object.assign(new Error("perm"), { code: "EACCES" });
      }),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    await expect(mod.acquireBundleBuildLock()).rejects.toThrow("perm");
  });

  it("acquireBundleBuildLock reclaims a stale lock via rename + rm then acquires", async () => {
    let attempts = 0;
    const rename = vi.fn(async () => {});
    mockBundleFs({
      mkdir: vi.fn(async (target: string) => {
        if (String(target).endsWith(".cli-bundle-build.lock")) {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
      }),
      stat: vi.fn(async () => ({ mtimeMs: Date.now() - 11 * 60_000 })),
      rename,
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    const release = await mod.acquireBundleBuildLock();
    await release();
    expect(rename).toHaveBeenCalled();
  });

  it("acquireBundleBuildLock swallows a benign stale-rename error then acquires", async () => {
    let attempts = 0;
    mockBundleFs({
      mkdir: vi.fn(async (target: string) => {
        if (String(target).endsWith(".cli-bundle-build.lock")) {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
      }),
      stat: vi.fn(async () => ({ mtimeMs: Date.now() - 11 * 60_000 })),
      rename: vi.fn(async () => {
        throw Object.assign(new Error("race"), { code: "ENOENT" });
      }),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    const release = await mod.acquireBundleBuildLock();
    await release();
    expect(attempts).toBe(2);
  });

  it("acquireBundleBuildLock rethrows a fatal stale-rename error", async () => {
    mockBundleFs({
      mkdir: vi.fn(async (target: string) => {
        if (String(target).endsWith(".cli-bundle-build.lock")) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
      }),
      stat: vi.fn(async () => ({ mtimeMs: Date.now() - 11 * 60_000 })),
      rename: vi.fn(async () => {
        throw Object.assign(new Error("perm"), { code: "EACCES" });
      }),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    await expect(mod.acquireBundleBuildLock()).rejects.toThrow("perm");
  });

  it("acquireBundleBuildLock times out waiting for a fresh lock", async () => {
    let virtual = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      virtual += 50_000;
      return virtual;
    });
    mockBundleFs({
      mkdir: vi.fn(async (target: string) => {
        if (String(target).endsWith(".cli-bundle-build.lock")) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
      }),
      stat: vi.fn(async () => ({ mtimeMs: virtual })),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    await expect(mod.acquireBundleBuildLock()).rejects.toThrow(/Timed out waiting for bundle build lock/);
    dateSpy.mockRestore();
  });

  it("collectFiles returns [] on ENOENT, recurses, and filters non-file entries", async () => {
    mockBundleFs({
      readdir: vi.fn(async (dir: string) => {
        const s = String(dir);
        if (s.endsWith("missing")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        if (s.endsWith("root")) {
          return [
            { name: "sub", isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
            { name: "a.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
            { name: "link.js", isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true },
            { name: "weird", isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false },
          ];
        }
        if (s.endsWith("sub")) {
          return [{ name: "b.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }];
        }
        return [];
      }),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    expect(await mod.collectFiles("/x/missing")).toEqual([]);
    const files = await mod.collectFiles("/x/root");
    expect(files.some((f) => f.endsWith("a.js"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.js"))).toBe(true);
    expect(files.some((f) => f.endsWith("link.js"))).toBe(true);
    expect(files.some((f) => f.endsWith("weird"))).toBe(false);
  });

  it("collectFiles rethrows a non-ENOENT readdir error", async () => {
    mockBundleFs({
      readdir: vi.fn(async () => {
        throw Object.assign(new Error("perm"), { code: "EACCES" });
      }),
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    await expect(mod.collectFiles("/x")).rejects.toThrow("perm");
  });

  it("removeStaleBundleFiles keeps expected + recent files and unlinks old extras (swallows unlink error)", async () => {
    const unlink = vi.fn(async () => {
      throw new Error("unlink failed");
    });
    mockBundleFs({
      readdir: vi.fn(async () => [
        { name: "main.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        { name: "old.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        { name: "recent.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
        { name: "nostat.js", isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      ]),
      lstat: vi.fn(async (p: string) => {
        const s = String(p);
        if (s.endsWith("nostat.js")) throw new Error("no stat");
        if (s.endsWith("old.js")) return { mtimeMs: Date.now() - 11 * 60_000 };
        return { mtimeMs: Date.now() };
      }),
      unlink,
    });
    const mod = await harness.importModuleStable<BundleModule>(SCRIPT);
    await mod.removeStaleBundleFiles({ "dist/cli-bundle/main.js": {} });
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(String(unlink.mock.calls[0][0])).toContain("old.js");
  });
});
