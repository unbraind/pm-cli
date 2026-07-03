import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const SCRIPT = "scripts/smoke-cleanup.mjs";

type CleanupModule = { cleanupTempRoot: (root: string) => void };

describe("smoke-cleanup", () => {
  it("returns immediately when removal succeeds and root no longer exists", async () => {
    const rmSync = vi.fn();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      rmSync,
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
    expect(rmSync).toHaveBeenCalledTimes(1);
  });

  it("breaks on a non-retryable error and rethrows the captured error", async () => {
    const fatal = Object.assign(new Error("boom"), { code: "EINVAL" });
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw fatal;
      }),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow("boom");
  });

  it("returns cleanly when a non-retryable error breaks the loop but root is already gone", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw Object.assign(new Error("gone"), { code: "EINVAL" });
      }),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
  });

  it("treats a codeless error as non-retryable (readErrorCode false branch)", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
         
        throw "string failure";
      }),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow(/Failed to remove temporary smoke directory/);
  });

  it("returns after the post-success existsSync check when root persists then clears", async () => {
    let existsCall = 0;
    const existsSync = vi.fn(() => {
      existsCall += 1;
      return existsCall === 1;
    });
    vi.doMock("node:fs", () => ({
      existsSync,
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
  });

  it("retries on a retryable error, sweeps entries, and eventually succeeds", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    let phase = 0;
    const existsSync = vi.fn(() => phase < 2);
    const rmSync = vi.fn((target: string) => {
      if (String(target).endsWith("smoke") && phase === 0) {
        phase = 1;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      phase = 2;
    });
    vi.doMock("node:fs", () => ({
      existsSync,
      readdirSync: vi.fn(() => ["child"]),
      rmSync,
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
    expect(rmSync.mock.calls.length).toBeGreaterThan(1);
    atomicsWait.mockRestore();
  });

  it("throws a synthesized error when root persists without a captured error", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => {
        throw new Error("readdir fail");
      }),
      rmSync: vi.fn(),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow(/Failed to remove temporary smoke directory/);
    atomicsWait.mockRestore();
  });

  it("rethrows the captured retryable error when root persists after exhausting retries", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    const busy = Object.assign(new Error("still busy"), { code: "EBUSY" });
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw busy;
      }),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow("still busy");
    atomicsWait.mockRestore();
  });
});
