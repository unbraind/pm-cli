import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();
const budget = {
  version: 4,
  max_unpacked_bytes_by_profile: {
    base: 100,
  },
  injection_profiles: {
    "sentry-injected": {
      base_profile: "base",
      injected_prefix: "dist/",
      injected_suffix: ".js",
      max_bytes_per_injected_file: 5,
    },
  },
  max_file_count: 4,
  forbidden_suffixes: [".map"],
  required_paths: ["dist/cli.js", "package.json"],
};

interface InjectionFixture {
  /** Bytes the simulated injector adds to each file under the copied prefix. */
  added: Record<string, number>;
  /** Original checkout sizes keyed by packed path. */
  sizes: Record<string, number>;
}

async function run(
  report: unknown,
  configuredBudget: unknown = budget,
  profileArguments: string[] = [],
  injection?: InjectionFixture,
) {
  const execFileSync = vi.fn((command: string) =>
    command === "/bin/sentry-cli" ? "" : JSON.stringify(report),
  );
  const readFileSync = vi.fn(() =>
    typeof configuredBudget === "string"
      ? configuredBudget
      : JSON.stringify(configuredBudget),
  );
  const scratch = path.join("/scratch", "pm-artifact-injection-x");
  const cpSync = vi.fn();
  const mkdtempSync = vi.fn(() => scratch);
  const rmSync = vi.fn();
  const statSync = vi.fn((file: string) => {
    const relative = path
      .relative(file.startsWith(scratch) ? scratch : process.cwd(), file)
      .split(path.sep)
      .join("/");
    const original = injection?.sizes[relative] ?? 0;
    return {
      size: file.startsWith(scratch)
        ? original + (injection?.added[relative] ?? 0)
        : original,
    };
  });
  const getPath = vi.fn(() => "/bin/sentry-cli");
  vi.doMock("node:child_process", () => ({ execFileSync }));
  vi.doMock("node:fs", () => ({
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
  }));
  vi.doMock("node:module", () => ({
    createRequire: () => () => ({ SentryCli: { getPath } }),
  }));
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
  return {
    cpSync,
    execFileSync,
    failure,
    log,
    mkdtempSync,
    readFileSync,
    rmSync,
    scratch,
  };
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

  it.each([
    [109, true],
    [111, false],
  ])(
    "derives the Sentry-injected ceiling from the base ceiling and the injected file count (%i bytes)",
    async (unpackedSize, accepted) => {
      const result = await run(
        [
          {
            name: "@unbrained/pm-cli",
            version: "2026.11.5",
            unpackedSize,
            files: [
              { path: "dist/cli.js" },
              { path: "dist/sdk/index.js" },
              { path: "dist/sdk/index.d.ts" },
              { path: "package.json" },
            ],
          },
        ],
        { ...budget, max_file_count: 10 },
        ["--profile=sentry-injected"],
      );

      if (!accepted) {
        expect(String(result.failure)).toContain("unpacked_size:111>110");
        return;
      }
      expect(result.failure).toBeNull();
      expect(JSON.parse(String(result.log.mock.calls[0]?.[0]))).toMatchObject({
        profile: "sentry-injected",
        max_unpacked_size: 110,
        injection: {
          base_profile: "base",
          injected_file_count: 2,
          max_bytes_per_injected_file: 5,
          injection_allowance: 10,
        },
      });
    },
  );

  it("keeps fixed profiles free of an injection receipt", async () => {
    const result = await run(
      [
        {
          unpackedSize: 120,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      {
        ...budget,
        max_unpacked_bytes_by_profile: { base: 100, preview: 120 },
      },
      ["--profile=preview"],
    );

    expect(result.failure).toBeNull();
    const receipt = JSON.parse(String(result.log.mock.calls[0]?.[0]));
    expect(receipt).toMatchObject({ profile: "preview", max_unpacked_size: 120 });
    expect(receipt).not.toHaveProperty("injection");
  });

  it.each([
    [{ base_profile: "missing" }, "must name a fixed base profile"],
    [{ base_profile: 1 }, "must name a fixed base profile"],
    [{ injected_prefix: "" }, "non-empty injected_prefix"],
    [{ injected_suffix: 1 }, "non-empty injected_suffix"],
    [{ max_bytes_per_injected_file: 0 }, "positive safe integer"],
    [{ max_bytes_per_injected_file: 1.5 }, "positive safe integer"],
    [{ max_bytes_per_injected_file: "5" }, "positive safe integer"],
  ])(
    "rejects a malformed injection profile %#",
    async (override, message) => {
      const result = await run(
        [
          {
            unpackedSize: 2,
            files: [{ path: "dist/cli.js" }, { path: "package.json" }],
          },
        ],
        {
          ...budget,
          injection_profiles: {
            "sentry-injected": {
              ...budget.injection_profiles["sentry-injected"],
              ...override,
            },
          },
        },
        ["--profile=sentry-injected"],
      );

      expect(result.failure).toBeInstanceOf(TypeError);
      expect(String(result.failure)).toContain(message);
    },
  );

  it("measures the injected profile on a disposable copy without touching the checkout", async () => {
    const result = await run(
      [
        {
          name: "@unbrained/pm-cli",
          version: "2026.11.5",
          unpackedSize: 100,
          files: [
            { path: "dist/cli.js", size: 40 },
            { path: "dist/sdk/index.js", size: 40 },
            // A module without a source map is left unchanged by the injector.
            { path: "dist/vendor.js", size: 0 },
            { path: "dist/sdk/index.d.ts", size: 10 },
            { path: "package.json", size: 10 },
          ],
        },
      ],
      { ...budget, max_file_count: 10 },
      ["--profile=sentry-injected", "--simulate-injection"],
      {
        sizes: { "dist/cli.js": 40, "dist/sdk/index.js": 40 },
        added: { "dist/cli.js": 4, "dist/sdk/index.js": 5 },
      },
    );

    expect(result.failure).toBeNull();
    expect(result.cpSync).toHaveBeenCalledWith(
      path.join(process.cwd(), "dist/"),
      path.join(result.scratch, "dist/"),
      { recursive: true },
    );
    expect(result.execFileSync).toHaveBeenCalledWith(
      "/bin/sentry-cli",
      ["sourcemaps", "inject", path.join(result.scratch, "dist/")],
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(result.rmSync).toHaveBeenCalledWith(result.scratch, {
      recursive: true,
      force: true,
    });
    expect(JSON.parse(String(result.log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      profile: "sentry-injected",
      distribution_size: 109,
      max_unpacked_size: 115,
      simulation: {
        source: "disposable_copy",
        injected_file_count: 2,
        added_bytes: 9,
      },
    });
  });

  it("fails the simulated profile when real injection outgrows the derived ceiling", async () => {
    const result = await run(
      [
        {
          unpackedSize: 100,
          files: [
            { path: "dist/cli.js", size: 50 },
            { path: "package.json", size: 50 },
            null,
          ],
        },
      ],
      budget,
      ["--profile=sentry-injected", "--simulate-injection"],
      { sizes: { "dist/cli.js": 50 }, added: { "dist/cli.js": 6 } },
    );

    expect(String(result.failure)).toContain("unpacked_size:106>105");
    expect(result.rmSync).toHaveBeenCalled();
  });

  it.each([[[]], [["--profile=base"]]])(
    "refuses to simulate injection for a fixed profile %#",
    async (profileArguments) => {
      const result = await run(
        [
          {
            unpackedSize: 2,
            files: [{ path: "dist/cli.js" }, { path: "package.json" }],
          },
        ],
        budget,
        [...profileArguments, "--simulate-injection"],
      );

      expect(result.failure).toBeInstanceOf(RangeError);
      expect(String(result.failure)).toContain(
        "--simulate-injection requires an injection profile",
      );
      expect(result.mkdtempSync).not.toHaveBeenCalled();
    },
  );

  it("refuses to simulate injection when no injection profiles are declared", async () => {
    const result = await run(
      [
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      { ...budget, injection_profiles: null },
      ["--profile=sentry-injected", "--simulate-injection"],
    );

    expect(String(result.failure)).toContain(
      "--simulate-injection requires an injection profile",
    );
  });

  it("rejects a null injection profile declaration", async () => {
    const result = await run(
      [
        {
          unpackedSize: 2,
          files: [{ path: "dist/cli.js" }, { path: "package.json" }],
        },
      ],
      { ...budget, injection_profiles: { "sentry-injected": null } },
      ["--profile=sentry-injected"],
    );

    expect(result.failure).toBeInstanceOf(TypeError);
    expect(String(result.failure)).toContain("must name a fixed base profile");
  });

  it.each([undefined, null])(
    "treats a profile as unknown when no injection profiles are declared (%s)",
    async (injectionProfiles) => {
      const result = await run(
        [
          {
            unpackedSize: 2,
            files: [{ path: "dist/cli.js" }, { path: "package.json" }],
          },
        ],
        { ...budget, injection_profiles: injectionProfiles },
        ["--profile=sentry-injected"],
      );

      expect(String(result.failure)).toContain(
        "Unknown package artifact profile: sentry-injected",
      );
    },
  );

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
