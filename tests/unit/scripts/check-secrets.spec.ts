import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

describe("check-secrets", () => {
  it("reports clean when tracked files contain no secrets and skips binary/deleted files", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "README.md\0binary.bin\0deleted.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn((target: string) => {
        if (target === "README.md") {
          return Buffer.from("Docs only; no secrets.");
        }
        if (target === "binary.bin") {
          return Buffer.from([0, 1, 2, 3]);
        }
        if (target === "deleted.txt") {
          throw Object.assign(new Error("removed"), { code: "ENOENT" });
        }
        return Buffer.from("");
      }),
    }));
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.importModule("scripts/check-secrets.mjs");
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("No credential-like secrets detected");
  });

  it("exits non-zero and lists findings when a tracked file contains a secret", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "leak.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => Buffer.from(`token ghp_${"A1b2C3d4".repeat(5)}`)),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    await expect(harness.importModule("scripts/check-secrets.mjs")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("Potential secrets detected:");
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("leak.txt:1 [github-token]"))).toBe(true);
    exitSpy.mockRestore();
  });

  it("fails with a descriptive message when a tracked file read errors with a non-ENOENT code", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "broken.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    await expect(harness.importModule("scripts/check-secrets.mjs")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("Failed to read broken.txt");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("permission denied");
    exitSpy.mockRestore();
  });

  it("skips empty files and stringifies a non-Error read failure", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "empty.txt\0broken.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn((target: string) => {
        if (target === "empty.txt") {
          return Buffer.from("");
        }
         
        throw Object.assign({ code: "EACCES" }, { toString: () => "raw failure" });
      }),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    await expect(harness.importModule("scripts/check-secrets.mjs")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("Failed to read broken.txt");
    exitSpy.mockRestore();
  });
});
