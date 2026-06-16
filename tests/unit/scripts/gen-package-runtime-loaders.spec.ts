import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

interface GeneratorModule {
  main: () => Promise<void>;
}

const harness = createScriptHarness();

describe("gen-package-runtime-loaders", () => {
  it("writes loader files in write mode", async () => {
    const generated = new Map<string, string>();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => generated.get(String(target)) ?? ""),
      writeFile: vi.fn(async (target: string, content: string) => {
        generated.set(String(target), String(content));
      }),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner"];
    const mod = await harness.importModule<GeneratorModule>("scripts/gen-package-runtime-loaders.mjs");
    await mod.main();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Wrote"))).toBe(true);
    // Both packages, each .ts + .js loader.
    expect(generated.size).toBe(4);
  });

  it("reports in-sync when --check finds matching generated content", async () => {
    const generated = new Map<string, string>();
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async (target: string) => generated.get(String(target)) ?? ""),
      writeFile: vi.fn(async (target: string, content: string) => {
        generated.set(String(target), String(content));
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    // First write so the in-memory store mirrors what --check expects.
    process.argv = ["node", "/nonmatching/runner"];
    const writeMod = await harness.importModule<GeneratorModule>("scripts/gen-package-runtime-loaders.mjs");
    await writeMod.main();

    const syncLog = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const checkMod = await harness.importModule<GeneratorModule>("scripts/gen-package-runtime-loaders.mjs");
    await checkMod.main();
    expect(syncLog.mock.calls.some((call) => String(call[0]).includes("in sync"))).toBe(true);
  });

  it("reports drift and exits 1 when --check finds mismatched content", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async () => "stale"),
      writeFile: vi.fn(async () => {}),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = harness.mockProcessExit();
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const mod = await harness.importModule<GeneratorModule>("scripts/gen-package-runtime-loaders.mjs");
    await expect(mod.main()).rejects.toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("Out of sync"))).toBe(true);
    exit.mockRestore();
  });

  it("treats a missing target file (readFile throws) as drift under --check", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
      writeFile: vi.fn(async () => {}),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = harness.mockProcessExit();
    process.argv = ["node", "/nonmatching/runner", "--check"];
    const mod = await harness.importModule<GeneratorModule>("scripts/gen-package-runtime-loaders.mjs");
    await expect(mod.main()).rejects.toThrow("EXIT:1");
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("Out of sync"))).toBe(true);
    exit.mockRestore();
  });
});
