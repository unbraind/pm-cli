import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();
const budget = {
  version: 2,
  max_unpacked_bytes_by_profile: {
    base: 100,
    "sentry-injected": 110,
  },
  max_file_count: 4,
  forbidden_suffixes: [".map"],
  required_paths: ["dist/cli.js", "package.json"],
};

async function run(
  report: unknown,
  configuredBudget: unknown = budget,
  profiles: string[] = [],
) {
  const execFileSync = vi.fn(() => JSON.stringify(report));
  const readFileSync = vi.fn(() => JSON.stringify(configuredBudget));
  vi.doMock("node:child_process", () => ({ execFileSync }));
  vi.doMock("node:fs", () => ({ readFileSync }));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const originalArgv = process.argv;
  process.argv = [
    ...originalArgv,
    ...profiles.map((profile) => `--profile=${profile}`),
  ];
  let failure: unknown = null;
  try {
    await harness.importModule(
      "scripts/release/package-artifact-gate.mjs",
      "packageArtifactGate",
    );
  } catch (error) {
    failure = error;
  } finally {
    process.argv = originalArgv;
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
    expect(result.log.mock.calls.flat().join(" ")).toContain(
      '"profile": "base"',
    );
    expect(result.readFileSync).toHaveBeenCalled();
  });

  it("uses the explicit Sentry-injected budget for the publishable artifact", async () => {
    const result = await run(
      [
        {
          name: "@unbrained/pm-cli",
          version: "2026.9.4",
          unpackedSize: 105,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      budget,
      ["sentry-injected"],
    );

    expect(result.failure).toBeNull();
    expect(result.log.mock.calls.flat().join(" ")).toContain(
      '"profile": "sentry-injected"',
    );
    expect(result.log.mock.calls.flat().join(" ")).toContain(
      '"max_unpacked_size": 110',
    );
  });

  it("rejects unknown artifact profiles", async () => {
    const result = await run(
      [
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      budget,
      ["unbounded"],
    );

    expect(String(result.failure)).toContain(
      "Unknown package artifact profile: unbounded",
    );
  });

  it.each([
    [{ ...budget, max_unpacked_bytes_by_profile: undefined }, "missing"],
    [
      {
        ...budget,
        max_unpacked_bytes_by_profile: {
          ...budget.max_unpacked_bytes_by_profile,
          base: "100",
        },
      },
      "not numeric",
    ],
  ])("rejects malformed profile budget %#", async (configuredBudget, message) => {
    const result = await run(
      [
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      configuredBudget,
    );

    expect(String(result.failure)).toContain(message);
  });

  it("rejects repeated profile selectors", async () => {
    const result = await run(
      [
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      budget,
      ["base", "sentry-injected"],
    );

    expect(String(result.failure)).toContain(
      "accepts at most one --profile",
    );
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
