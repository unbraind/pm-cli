import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

interface Scenario {
  args: string[];
  packageJson?: Record<string, unknown>;
  execFileSyncImpl?: (command: string, args: string[]) => string;
}

async function runReleaseVersionScenario(options: Scenario) {
  process.argv = ["node", "scripts/release-version.mjs", ...options.args];
  const packageJson = options.packageJson ?? { name: "pm-cli", version: "2026.6.14" };
  const readFileSync = vi.fn(() => JSON.stringify(packageJson));
  const execFileSync = vi.fn(options.execFileSyncImpl ?? (() => "[]"));
  vi.doMock("node:fs", () => ({ readFileSync }));
  vi.doMock("node:child_process", () => ({ execFileSync }));

  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    errors.push(String(value ?? ""));
  });
  const exitSpy = harness.mockProcessExit();

  let failure: unknown = null;
  try {
    await harness.importModule("scripts/release-version.mjs", "releaseVersionScenario");
  } catch (error) {
    failure = error;
  }
  exitSpy.mockRestore();
  return { failure, logs, errors, readFileSync, execFileSync };
}

describe("scripts/release-version: check/next success paths", () => {
  it("passes a check without contacting npm", async () => {
    const result = await runReleaseVersionScenario({
      args: ["check"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain("Version policy check passed (2026.6.14).");
    expect(result.execFileSync).not.toHaveBeenCalled();
  });

  it("computes the next ordinal release for a date with published versions", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
      execFileSyncImpl: () => JSON.stringify(["2026.6.14", "2026.6.14-2", "2026.6.13"]),
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe("2026.6.14-3");
  });

  it("returns the bare date key when npm returns a 404 for the package", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.15"],
      execFileSyncImpl: () => {
        const error = new Error("npm view failed") as Error & { stderr?: string };
        error.stderr = "E404 Not Found";
        throw error;
      },
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe("2026.6.15");
  });

  it("returns the bare date key when no published version matches the date", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.20"],
      execFileSyncImpl: () => JSON.stringify(["2026.6.14", "2026.5.1", "not-a-version"]),
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe("2026.6.20");
  });

  it("uses the current UTC date when --date is omitted (getUtcDateKey)", async () => {
    const now = new Date();
    const dateKey = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
    const result = await runReleaseVersionScenario({
      args: ["next"],
      execFileSyncImpl: () => JSON.stringify([]),
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe(dateKey);
  });

  it("treats a single published string version as a one-element list", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => JSON.stringify("2026.6.14"),
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe("2026.6.14-2");
  });

  it("treats a non-array, non-string npm payload as an empty version list", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => JSON.stringify({ unexpected: true }),
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe("2026.6.14");
  });

  it("treats an empty npm response as no published versions", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => "   ",
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe("2026.6.14");
  });

  it("passes a verify-next check when the package version is the expected next release", async () => {
    const result = await runReleaseVersionScenario({
      args: ["check", "--verify-next", "--date", "2026.6.14", "--tag", "v2026.6.14"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
      execFileSyncImpl: () => JSON.stringify([]),
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain("Version policy check passed");
  });
});

describe("scripts/release-version: failure paths", () => {
  it("fails on a tag/version mismatch", async () => {
    const result = await runReleaseVersionScenario({
      args: ["check", "--tag", "v0.0.1"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Tag/version mismatch");
  });

  it("fails on a verify-next date mismatch", async () => {
    const result = await runReleaseVersionScenario({
      args: ["check", "--verify-next", "--date", "2026.6.15"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Version date mismatch");
  });

  it("fails on a verify-next sequencing mismatch", async () => {
    const result = await runReleaseVersionScenario({
      args: ["check", "--verify-next", "--date", "2026.6.14"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
      execFileSyncImpl: () => JSON.stringify(["2026.6.14"]),
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Version sequencing mismatch");
  });

  it("fails on an unknown flag", async () => {
    const result = await runReleaseVersionScenario({ args: ["check", "--mystery-flag"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain('Unknown flag "--mystery-flag"');
  });

  it("fails on a missing --tag value", async () => {
    const result = await runReleaseVersionScenario({ args: ["check", "--tag"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("--tag requires a value.");
  });

  it("fails on a missing --date value", async () => {
    const result = await runReleaseVersionScenario({ args: ["next", "--date"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("--date requires a value.");
  });

  it("fails on an invalid --date calendar value (rollover)", async () => {
    const result = await runReleaseVersionScenario({ args: ["next", "--date", "2026.2.30"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain('Invalid --date value "2026.2.30"');
  });

  it("fails on an out-of-range --date day value", async () => {
    const result = await runReleaseVersionScenario({ args: ["next", "--date", "2026.2.32"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain('Invalid --date value "2026.2.32"');
  });

  it("fails on an out-of-range --date month value", async () => {
    const result = await runReleaseVersionScenario({ args: ["next", "--date", "2026.13.1"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain('Invalid --date value "2026.13.1"');
  });

  it("fails on an unknown command", async () => {
    const result = await runReleaseVersionScenario({ args: ["ship"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain('Unknown command "ship"');
  });

  it("fails when npm returns malformed JSON", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => "not-json",
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Failed to parse npm versions JSON");
  });

  it("fails when querying the npm registry errors with a non-404 stderr", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => {
        const error = new Error("network down") as Error & { stderr?: string };
        error.stderr = "ETIMEDOUT registry";
        throw error;
      },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Failed to query npm registry for pm-cli");
  });

  it("decodes a Buffer stderr when classifying npm registry failures", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => {
        const error = new Error("boom") as Error & { stderr?: Buffer };
        error.stderr = Buffer.from("E404 Not Found");
        throw error;
      },
    });
    expect(result.failure).toBeNull();
    expect(result.logs.at(-1)).toBe("2026.6.14");
  });

  it("fails on a --date value that does not match the version pattern at all", async () => {
    const result = await runReleaseVersionScenario({ args: ["next", "--date", "not-a-date"] });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain('Invalid --date value "not-a-date"');
  });

  it("defaults to the check command when no command argument is present", async () => {
    const result = await runReleaseVersionScenario({
      args: [],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain("Version policy check passed (2026.6.14).");
  });

  it("uses npm.cmd on win32 when querying the registry", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    let invokedCommand = "";
    try {
      const result = await runReleaseVersionScenario({
        args: ["next", "--date", "2026.6.14"],
        execFileSyncImpl: (command: string) => {
          invokedCommand = command;
          return JSON.stringify([]);
        },
      });
      expect(result.failure).toBeNull();
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
    expect(invokedCommand).toBe("npm.cmd");
  });

  it("treats a registry error without a stderr property as an empty classification", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => {
        // Plain Error with no stderr key -> `"stderr" in error` false -> "" -> non-404 -> fail.
        throw new Error("registry exploded");
      },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Failed to query npm registry for pm-cli");
    expect(result.errors.join("\n")).toContain("registry exploded");
  });

  it("treats a non-string non-Buffer stderr value as empty when classifying failures", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => {
        const error = new Error("weird stderr") as Error & { stderr?: unknown };
        error.stderr = 1234; // neither string nor Buffer -> "" -> non-404 -> fail
        throw error;
      },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("Failed to query npm registry for pm-cli");
  });

  it("stringifies a non-Error registry throwable in the failure message", async () => {
    const result = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => {
        throw "raw-registry-string-failure"; // non-Error -> String(error) branch
      },
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain("raw-registry-string-failure");
  });

  it("prints usage for --help passed as a flag", async () => {
    const result = await runReleaseVersionScenario({ args: ["check", "--help"] });
    expect(String(result.failure ?? "")).toContain("EXIT:0");
    expect(result.logs.join("\n")).toContain("Usage:");
  });

  it("prints usage when --help is the command position", async () => {
    const result = await runReleaseVersionScenario({ args: ["--help"] });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain("Usage:");
  });

  it.each([
    {
      name: "missing package name",
      packageJson: { version: "2026.6.14" },
      expected: 'missing a valid "name"',
    },
    {
      name: "missing package version",
      packageJson: { name: "pm-cli" },
      expected: 'missing a valid "version"',
    },
    {
      name: "non-semver version",
      packageJson: { name: "pm-cli", version: "1.2.3" },
      expected: "Expected YYYY.M.D",
    },
    {
      name: "invalid calendar date",
      packageJson: { name: "pm-cli", version: "2026.2.30" },
      expected: "uses an invalid calendar date",
    },
    {
      name: "forbidden ordinal one suffix",
      packageJson: { name: "pm-cli", version: "2026.6.14-1" },
      expected: "omit suffix for first release",
    },
  ])("fails package.json validation: $name", async ({ packageJson, expected }) => {
    const result = await runReleaseVersionScenario({ args: ["check"], packageJson });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain(expected);
  });
});
