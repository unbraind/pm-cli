import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();
const budget = {
  version: 1,
  max_unpacked_bytes: 100,
  max_file_count: 4,
  forbidden_suffixes: [".map"],
  required_paths: ["dist/cli.js", "package.json"],
};

async function run(report: unknown, configuredBudget: unknown = budget) {
  const execFileSync = vi.fn(() => JSON.stringify(report));
  const readFileSync = vi.fn(() => JSON.stringify(configuredBudget));
  vi.doMock("node:child_process", () => ({ execFileSync }));
  vi.doMock("node:fs", () => ({ readFileSync }));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let failure: unknown = null;
  try {
    await harness.importModule(
      "scripts/release/package-artifact-gate.mjs",
      "packageArtifactGate",
    );
  } catch (error) {
    failure = error;
  }
  return { execFileSync, failure, log, readFileSync };
}

describe("package artifact gate", () => {
  it("accepts the exact npm pack projection and prints a bounded receipt", async () => {
    const result = await run([
      {
        name: "@unbrained/pm-cli",
        version: "2026.8.3",
        unpackedSize: 90,
        files: [
          { path: "dist/cli.js" },
          { path: "package.json" },
          { path: "README.md" },
          null,
        ],
      },
    ]);
    expect(result.failure).toBeNull();
    expect(result.execFileSync).toHaveBeenCalledWith(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(result.log.mock.calls.flat().join(" ")).toContain('"ok": true');
    expect(result.readFileSync).toHaveBeenCalled();
  });

  it("reports every composition and budget violation together", async () => {
    const result = await run([
      {
        unpackedSize: 101,
        files: [
          { path: "dist/cli.js.map" },
          { path: "a" },
          { path: "b" },
          { path: "c" },
          { path: "d" },
        ],
      },
    ]);
    expect(String(result.failure)).toContain("unpacked_size:101>100");
    expect(String(result.failure)).toContain("file_count:5>4");
    expect(String(result.failure)).toContain("forbidden_suffix:.map:1");
    expect(String(result.failure)).toContain("required_path_missing:dist/cli.js");
    expect(String(result.failure)).toContain("required_path_missing:package.json");
  });

  it("uses the npm command shim on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      const result = await run([
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ]);
      expect(result.failure).toBeNull();
      expect(result.execFileSync.mock.calls[0]?.[0]).toBe("npm.cmd");
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it.each([
    [[]],
    [[{ unpackedSize: 1 }]],
    [[null]],
    [[{ unpackedSize: "1", files: [] }]],
  ])(
    "rejects malformed npm pack report %#",
    async (report) => {
      const result = await run(report);
      expect(String(result.failure)).toMatch(/exactly one|missing files/);
    },
  );
});
