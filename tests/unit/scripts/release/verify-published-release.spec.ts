import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const UTILS_SPECIFIER = "../../../../scripts/release/utils.mjs";

const harness = createScriptHarness([UTILS_SPECIFIER]);

type RunCommandResult = { status: number; stdout: string; stderr: string };

interface ScenarioOptions {
  argv: string[];
  runCommand?: (command: string, args: string[], call: number) => RunCommandResult;
  sleepMs?: string;
}

async function runVerify(options: ScenarioOptions) {
  process.env.PM_VERIFY_SLEEP_MS = options.sleepMs ?? "0";

  const mkdtempSync = vi.fn(() => "/tmp/pm-cli-published-verify-test");
  const rmSync = vi.fn();
  vi.doMock("node:fs", () => ({ mkdtempSync, rmSync }));

  let callIndex = 0;
  const runCommand = vi.fn((command: string, args: string[]) => {
    const result = (options.runCommand ?? (() => ({ status: 0, stdout: "", stderr: "" })))(command, args, callIndex);
    callIndex += 1;
    return result;
  });
  vi.doMock(UTILS_SPECIFIER, async () => {
    const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(UTILS_SPECIFIER);
    return {
      ...actual,
      runCommand,
      commandFor(binary: string) {
        return binary;
      },
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });

  process.argv = ["node", "scripts/release/verify-published-release.mjs", ...options.argv];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    errors.push(String(value ?? ""));
  });

  let failure: unknown = null;
  try {
    await harness.importModuleStable("scripts/release/verify-published-release.mjs");
  } catch (error) {
    failure = error;
  }

  const json = (() => {
    const raw = String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "");
    return raw.trim().startsWith("{") ? JSON.parse(raw) : null;
  })();

  return { failure, stdoutSpy, logs, errors, runCommand, mkdtempSync, rmSync, json };
}

function npmViewResult(version: string): RunCommandResult {
  return {
    status: 0,
    stdout: JSON.stringify({ version, dist: { integrity: "sha512-test", unpackedSize: 12345 } }),
    stderr: "",
  };
}

describe("scripts/release/verify-published-release: usage and validation", () => {
  it("prints usage for --help and runs nothing", async () => {
    const { logs, runCommand } = await runVerify({ argv: ["--help"] });
    expect(logs.join("\n")).toContain("scripts/release/verify-published-release.mjs");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails when neither --version nor --tag is supplied", async () => {
    const { failure } = await runVerify({ argv: ["--json"] });
    expect(String(failure ?? "")).toContain("Missing --version");
  });

  it("derives the version from --tag by stripping the leading v", async () => {
    const { json } = await runVerify({
      argv: ["--tag", "v2026.6.14", "--json", "--skip-package", "--skip-github-release"],
    });
    expect(json.version).toBe("2026.6.14");
    expect(json.package).toEqual({ skipped: true });
    expect(json.github_release).toEqual({ skipped: true });
  });

  it("fails on an invalid version format", async () => {
    const { failure } = await runVerify({ argv: ["--version", "not-a-version"] });
    expect(String(failure ?? "")).toContain('Invalid release version "not-a-version"');
  });

  it("fails on a non-positive --npm-attempts value", async () => {
    const { failure } = await runVerify({ argv: ["--version", "2026.6.14", "--npm-attempts", "0"] });
    expect(String(failure ?? "")).toContain('Invalid --npm-attempts value "0"');
  });

  it("fails on a non-integer --executor-attempts value", async () => {
    const { failure } = await runVerify({ argv: ["--version", "2026.6.14", "--executor-attempts", "1.5"] });
    expect(String(failure ?? "")).toContain('Invalid --executor-attempts value "1.5"');
  });
});

describe("scripts/release/verify-published-release: success path", () => {
  it("verifies npm, npx, bunx, and the GitHub release and prints JSON", async () => {
    const { json, rmSync } = await runVerify({
      argv: ["--version", "2026.6.14", "--json", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        if (command === "npx" || command === "bunx") {
          return { status: 0, stdout: "2026.6.14\n", stderr: "" };
        }
        if (command === "gh") {
          return {
            status: 0,
            stdout: JSON.stringify({
              tagName: "v2026.6.14",
              name: "v2026.6.14",
              isDraft: false,
              isPrerelease: false,
              url: "https://example.test/release/v2026.6.14",
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.ok).toBe(true);
    expect(json.package.npm.ok).toBe(true);
    expect(json.package.npx.direct.ok).toBe(true);
    expect(json.package.npx.package.ok).toBe(true);
    expect(json.package.bunx.ok).toBe(true);
    expect(json.github_release.tagName).toBe("v2026.6.14");
    expect(rmSync).toHaveBeenCalled();
  });

  it("prints a text success line when --json is omitted", async () => {
    const { logs } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-package", "--skip-github-release"],
    });
    expect(logs.join("\n")).toContain("Published release 2026.6.14 verified.");
  });
});

describe("scripts/release/verify-published-release: npm metadata retries", () => {
  it("retries npm metadata and succeeds on a later attempt (exercises sleep + waiting log)", async () => {
    const { json, errors } = await runVerify({
      argv: ["--version", "2026.6.14", "--json", "--skip-github-release", "--npm-attempts", "2", "--executor-attempts", "1"],
      sleepMs: "0",
      runCommand: (command, args, call) => {
        if (command === "npm" && args[0] === "view") {
          // First attempt fails, second succeeds.
          return call === 0 ? { status: 1, stdout: "", stderr: "registry timeout" } : npmViewResult("2026.6.14");
        }
        if (command === "npx" || command === "bunx") {
          return { status: 0, stdout: "2026.6.14\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.ok).toBe(true);
    expect(json.package.npm.attempts).toBe(2);
    expect(errors.join("\n")).toContain("Waiting for npm metadata propagation (attempt 1/2)");
  });

  it("fails npm metadata after exhausting attempts", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? { status: 1, stdout: "", stderr: "npm down" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm metadata verification failed: npm down");
  });

  it("fails npm metadata on a version mismatch", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view" ? npmViewResult("2026.6.13") : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_version_mismatch:2026.6.13");
  });

  it("fails npm metadata on malformed JSON", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? { status: 0, stdout: "not-json", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_json_parse_failed");
  });

  it("falls back to npm_view_failed when npm exits non-zero with empty stderr", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? { status: 1, stdout: "", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_view_failed");
  });

  it("reports a missing version when npm metadata omits the version field", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? { status: 0, stdout: JSON.stringify({ dist: { integrity: "sha512-x" } }), stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_version_mismatch:missing");
  });
});

describe("scripts/release/verify-published-release: executor failures", () => {
  it("fails when an executor reports a mismatched version (no_output branch)", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        if (command === "npx") {
          return { status: 0, stdout: "0.0.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(String(failure ?? "")).toContain("npx-direct verification failed");
    expect(String(failure ?? "")).toContain("npx-direct_version_mismatch:0.0.0");
  });

  it("reports the stderr/no_output fallback when an executor exits non-zero with empty stdout", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        if (command === "npx") {
          return { status: 1, stdout: "", stderr: "executor crashed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(String(failure ?? "")).toContain("npx-direct_version_mismatch:executor crashed");
  });

  it("reports no_output when an executor exits non-zero with empty stdout and stderr", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-github-release", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        if (command === "npx") {
          return { status: 1, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(String(failure ?? "")).toContain("npx-direct_version_mismatch:no_output");
  });
});

describe("scripts/release/verify-published-release: github release", () => {
  it("fails when gh release view exits non-zero", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-package", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command) =>
        command === "gh" ? { status: 1, stdout: "", stderr: "no release" } : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("GitHub release verification failed: no release");
  });

  it("falls back to gh_release_view_failed when gh stderr is empty", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-package", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command) =>
        command === "gh" ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("gh_release_view_failed");
  });

  it("fails on a github release tag mismatch", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-package", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command) =>
        command === "gh"
          ? { status: 0, stdout: JSON.stringify({ tagName: "v2026.6.13" }), stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("GitHub release tag mismatch");
  });

  it("reports a missing received tag when gh metadata omits tagName", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-package", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command) =>
        command === "gh"
          ? { status: 0, stdout: JSON.stringify({ name: "v2026.6.14" }), stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("received missing");
  });

  it("fails when the github release is a draft or prerelease", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-package", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command) =>
        command === "gh"
          ? { status: 0, stdout: JSON.stringify({ tagName: "v2026.6.14", isDraft: true }), stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("must not be draft/prerelease");
  });

  it("fails when gh release JSON cannot be parsed", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--skip-package", "--npm-attempts", "1", "--executor-attempts", "1"],
      runCommand: (command) =>
        command === "gh" ? { status: 0, stdout: "not-json{", stderr: "" } : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("GitHub release JSON parse failed");
  });
});
