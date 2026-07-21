import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const SCRIPT = "scripts/smoke-cleanup.mjs";

type CleanupModule = { cleanupTempRoot: (root: string) => void };

describe("smoke-cleanup", () => {
  it("returns immediately when removal succeeds and root no longer exists", async () => {
    const rmSync = vi.fn();
    vi.doMock("node:fs", () => ({
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
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw fatal;
      }),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow("boom");
  });

  it("treats a codeless error as non-retryable (readErrorCode false branch)", async () => {
    vi.doMock("node:fs", () => ({
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(() => {
        throw "string failure";
      }),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow(
      /Failed to remove temporary smoke directory: .*string failure/,
    );
  });

  it("retries on a retryable error, sweeps entries, and eventually succeeds", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    let phase = 0;
    const rmSync = vi.fn((target: string) => {
      if (String(target).endsWith("smoke") && phase === 0) {
        phase = 1;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      phase = 2;
    });
    vi.doMock("node:fs", () => ({
      readdirSync: vi.fn(() => ["child"]),
      rmSync,
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).not.toThrow();
    expect(rmSync.mock.calls.length).toBeGreaterThan(1);
    atomicsWait.mockRestore();
  });

  it("retries when entry sweeping fails and rethrows the captured removal error", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    const busy = Object.assign(new Error("root busy"), { code: "EBUSY" });
    vi.doMock("node:fs", () => ({
      readdirSync: vi.fn(() => {
        throw new Error("readdir fail");
      }),
      rmSync: vi.fn(() => {
        throw busy;
      }),
    }));
    const mod = await harness.importModule<CleanupModule>(SCRIPT);
    expect(() => mod.cleanupTempRoot("/tmp/smoke")).toThrow("root busy");
    atomicsWait.mockRestore();
  });

  it("rethrows the captured retryable error when root persists after exhausting retries", async () => {
    const atomicsWait = vi.spyOn(Atomics, "wait").mockReturnValue("ok" as never);
    const busy = Object.assign(new Error("still busy"), { code: "EBUSY" });
    vi.doMock("node:fs", () => ({
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
