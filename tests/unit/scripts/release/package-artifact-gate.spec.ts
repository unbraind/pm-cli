import path from "node:path";
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
  profileArguments: string[] = [],
) {
  const execFileSync = vi.fn(() => JSON.stringify(report));
  const readFileSync = vi.fn(() =>
    typeof configuredBudget === "string"
      ? configuredBudget
      : JSON.stringify(configuredBudget),
  );
  vi.doMock("node:child_process", () => ({ execFileSync }));
  vi.doMock("node:fs", () => ({ readFileSync }));
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const originalArgv = process.argv;
  process.argv = [...originalArgv, ...profileArguments];
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
  it.each(["package-keyed", "single-artifact"] as const)(
    "accepts the %s projection from npm or the distribution stager",
    async (shape) => {
      const artifact = {
        name: "@unbrained/pm-cli",
        version: "2026.9.16",
        unpackedSize: 90,
        files: [{ path: "dist/cli.js" }, { path: "package.json" }],
      };
      const result = await run(
        shape === "single-artifact"
          ? artifact
          : { [artifact.name]: artifact },
      );
      expect(result.failure).toBeNull();
      expect(JSON.parse(String(result.log.mock.calls[0]?.[0]))).toMatchObject({
        ok: true,
        package: artifact.name,
        distribution_size: 90,
        distribution_file_count: 2,
      });
    },
  );

  it.each([
    null,
    "archive.tgz",
    {},
    { first: {}, second: {} },
    { wrong: { name: "other", unpackedSize: 1, files: [] } },
  ])("rejects malformed or ambiguous keyed inventories %#", async (report) => {
    const result = await run(report);
    expect(String(result.failure)).toMatch(/exactly one|identity/);
  });
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
      process.execPath,
      [path.join(process.cwd(), "scripts/release/package-distribution.mjs")],
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
      ["--profile=sentry-injected"],
    );

    expect(result.failure).toBeNull();
    expect(result.log.mock.calls.flat().join(" ")).toContain(
      '"profile": "sentry-injected"',
    );
    expect(result.log.mock.calls.flat().join(" ")).toContain(
      '"max_unpacked_size": 110',
    );
  });

  it.each([
    [90, 20, true],
    [101, 20, false],
    [90, 31, false],
  ])(
    "enforces independent application and bundled-runtime ceilings (%i + %i)",
    async (applicationBytes, runtimeBytes, accepted) => {
      const result = await run(
        [
          {
            name: "fixture",
            unpackedSize: applicationBytes + runtimeBytes,
            files: [
              { path: "dist/cli.js" },
              { path: "package.json" },
              { path: "node_modules/runtime/index.js", size: runtimeBytes },
            ],
          },
        ],
        {
          ...budget,
          runtime_bundle: { max_unpacked_bytes: 30, max_file_count: 1 },
        },
      );
      if (accepted) expect(result.failure).toBeNull();
      else
        expect(String(result.failure)).toMatch(
          /unpacked_size|runtime_bundle_budget/u,
        );
    },
  );

  it("rejects unknown artifact profiles", async () => {
    const result = await run(
      [
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      budget,
      ["--profile=unbounded"],
    );

    expect(String(result.failure)).toContain(
      "Unknown package artifact profile: unbounded",
    );
  });

  it.each([
    undefined,
    null,
    {},
    { max_unpacked_bytes: 30 },
    { max_file_count: 1 },
    { max_unpacked_bytes: null, max_file_count: 1 },
    { max_unpacked_bytes: "30", max_file_count: 1 },
    { max_unpacked_bytes: -1, max_file_count: 1 },
    { max_unpacked_bytes: 1.5, max_file_count: 1 },
    { max_unpacked_bytes: Number.MAX_SAFE_INTEGER + 1, max_file_count: 1 },
    { max_unpacked_bytes: 30, max_file_count: null },
    { max_unpacked_bytes: 30, max_file_count: "1" },
    { max_unpacked_bytes: 30, max_file_count: -1 },
    { max_unpacked_bytes: 30, max_file_count: 1.5 },
  ])("rejects an invalid runtime ceiling %#", async (runtimeBundle) => {
    const result = await run(
      {
        name: "fixture",
        unpackedSize: 2,
        files: [
          { path: "dist/cli.js" },
          { path: "package.json" },
          { path: "node_modules/runtime/index.js", size: 1 },
        ],
      },
      { ...budget, runtime_bundle: runtimeBundle },
    );
    expect(result.failure).toBeInstanceOf(TypeError);
    expect(String(result.failure)).toContain("Runtime bundle budget");
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
    [
      JSON.stringify(budget).replace('"base":100', '"base":1e309'),
      "not finite",
    ],
  ])(
    "rejects malformed profile budget %#",
    async (configuredBudget, message) => {
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
    },
  );

  it("rejects repeated profile selectors", async () => {
    const result = await run(
      [
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      budget,
      ["--profile=base", "--profile=sentry-injected"],
    );

    expect(String(result.failure)).toContain("accepts at most one --profile");
  });

  it.each([["--profile="], ["--profile", "sentry-injected"]])(
    "rejects malformed profile arguments %#",
    async (...profileArguments) => {
      const result = await run(
        [
          {
            unpackedSize: 2,
            files: [{ path: "dist/cli.js" }, { path: "package.json" }],
          },
        ],
        budget,
        profileArguments,
      );

      expect(String(result.failure)).toContain("requires --profile=<name>");
    },
  );

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
    expect(String(result.failure)).toContain(
      "required_path_missing:dist/cli.js",
    );
    expect(String(result.failure)).toContain(
      "required_path_missing:package.json",
    );
  });

  it("invokes the platform native Node executable on Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
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
      expect(result.execFileSync.mock.calls[0]?.[0]).toBe(process.execPath);
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
  ])("rejects malformed npm pack report %#", async (report) => {
    const result = await run(report);
    expect(String(result.failure)).toMatch(/exactly one|missing files/);
  });
});
