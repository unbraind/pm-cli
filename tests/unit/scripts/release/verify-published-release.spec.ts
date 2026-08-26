import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const UTILS_SPECIFIER = "../../../../scripts/release/utils.mjs";

const harness = createScriptHarness([UTILS_SPECIFIER]);

type RunCommandResult = { status: number; stdout: string; stderr: string };

interface ScenarioOptions {
  argv: string[];
  npmPackage?: string;
  packageManifest?: Record<string, unknown>;
  runCommand?: (
    command: string,
    args: string[],
    call: number,
  ) => RunCommandResult;
  sleepMs?: string;
}

async function runVerify(options: ScenarioOptions) {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doUnmock(UTILS_SPECIFIER);
  process.env.PM_VERIFY_SLEEP_MS = options.sleepMs ?? "0";
  if (options.npmPackage === undefined) {
    delete process.env.NPM_PACKAGE;
  } else {
    process.env.NPM_PACKAGE = options.npmPackage;
  }

  const mkdtempSync = vi.fn(() => "/tmp/pm-cli-published-verify-test");
  const readFileSync = vi.fn(() =>
    JSON.stringify(
      options.packageManifest ?? {
        name: "@unbrained/pm-cli",
        bin: {
          pm: "dist/cli.js",
          "pm-cli": "dist/cli.js",
          "pm-mcp": "dist/mcp/server.js",
          "pm-mcp-http": "dist/mcp/http-server.js",
        },
      },
    ),
  );
  const rmSync = vi.fn();
  const writeFileSync = vi.fn();
  vi.doMock("node:fs", () => ({
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
  }));

  let callIndex = 0;
  const runCommand = vi.fn((command: string, args: string[]) => {
    const result = (
      options.runCommand ?? (() => ({ status: 0, stdout: "", stderr: "" }))
    )(command, args, callIndex);
    callIndex += 1;
    return result;
  });
  vi.doMock(UTILS_SPECIFIER, async () => {
    const actual =
      await vi.importActual<
        typeof import("../../../../scripts/release/utils.mjs")
      >(UTILS_SPECIFIER);
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

  process.argv = [
    "node",
    "scripts/release/verify-published-release.mjs",
    ...options.argv,
  ];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
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
    await harness.importModuleStable(
      "scripts/release/verify-published-release.mjs",
    );
  } catch (error) {
    failure = error;
  }

  const json = (() => {
    const raw = String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "");
    return raw.trim().startsWith("{") ? JSON.parse(raw) : null;
  })();

  return {
    failure,
    stdoutSpy,
    logs,
    errors,
    runCommand,
    mkdtempSync,
    rmSync,
    writeFileSync,
    json,
  };
}

function npmViewResult(version: string): RunCommandResult {
  return {
    status: 0,
    stdout: JSON.stringify({
      version,
      dist: { integrity: "sha512-test", unpackedSize: 12345 },
    }),
    stderr: "",
  };
}

function successfulExecutorResult(args: string[]): RunCommandResult {
  if (args.includes("pm-definitely-missing")) {
    return { status: 127, stdout: "", stderr: "executable not found" };
  }
  if (args.includes("pm-mcp")) {
    return {
      status: 0,
      stdout: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          supportedVersions: ["2026-07-28"],
          resultType: "complete",
          _meta: {
            "io.modelcontextprotocol/serverInfo": { name: "pm-mcp" },
          },
        },
      }),
      stderr: "",
    };
  }
  return {
    status: 0,
    stdout: JSON.stringify({ summary: { command_count: 1 } }),
    stderr: "",
  };
}

function successfulPublishedVerifierResult(
  command: string,
  args: string[],
): RunCommandResult {
  if (command === "node" && args.includes("--eval")) {
    return {
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        http_status: 200,
        server_name: "pm-mcp",
        protocol_version: "2026-07-28",
      }),
      stderr: "",
    };
  }
  return successfulExecutorResult(args);
}

describe("scripts/release/verify-published-release: usage and validation", () => {
  it("prints usage for --help and runs nothing", async () => {
    const { logs, runCommand } = await runVerify({ argv: ["--help"] });
    expect(logs.join("\n")).toContain(
      "scripts/release/verify-published-release.mjs",
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails when neither --version nor --tag is supplied", async () => {
    const { failure } = await runVerify({ argv: ["--json"] });
    expect(String(failure ?? "")).toContain("Missing --version");
  });

  it("derives the version from --tag by stripping the leading v", async () => {
    const { json } = await runVerify({
      argv: [
        "--tag",
        "v2026.6.14",
        "--json",
        "--skip-package",
        "--skip-github-release",
      ],
    });
    expect(json.version).toBe("2026.6.14");
    expect(json.package).toEqual({ skipped: true });
    expect(json.github_release).toEqual({ skipped: true });
  });

  it("fails on an invalid version format", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "not-a-version"],
    });
    expect(String(failure ?? "")).toContain(
      'Invalid release version "not-a-version"',
    );
  });

  it("fails on a non-positive --npm-attempts value", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--npm-attempts", "0"],
    });
    expect(String(failure ?? "")).toContain('Invalid --npm-attempts value "0"');
  });

  it("fails on a non-integer --executor-attempts value", async () => {
    const { failure } = await runVerify({
      argv: ["--version", "2026.6.14", "--executor-attempts", "1.5"],
    });
    expect(String(failure ?? "")).toContain(
      'Invalid --executor-attempts value "1.5"',
    );
  });
});

describe("scripts/release/verify-published-release: success path", () => {
  it("verifies npm, npx, bunx, and the GitHub release and prints JSON", async () => {
    const { json, rmSync, runCommand, writeFileSync } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--json",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        if (command === "npx" || command === "bunx" || command === "node") {
          return successfulPublishedVerifierResult(command, args);
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
    expect(json.package.executors.npx.pm.ok).toBe(true);
    expect(json.package.executors.npx["package-default-pm"].ok).toBe(true);
    expect(json.package.executors.npx["pm-mcp"].ok).toBe(true);
    expect(json.package.executors.npx["pm-mcp-http"]).toMatchObject({
      ok: true,
      http_status: 200,
      server_name: "pm-mcp",
      protocol_version: "2026-07-28",
    });
    expect(json.package.executors.bunx.pm.ok).toBe(true);
    expect(json.package.executors.bunx["package-default-pm"].ok).toBe(true);
    expect(json.package.executors.bunx["pm-mcp"].ok).toBe(true);
    expect(json.package.executors.bunx["pm-mcp-http"].ok).toBe(true);
    expect(json.package.negative_controls).toMatchObject({
      npx: { ok: true },
      npx_package_default: { ok: true },
      bunx: { ok: true },
      bunx_package_default: { ok: true },
    });
    for (const call of runCommand.mock.calls.filter((entry) =>
      entry[1].includes("pm-mcp"),
    )) {
      expect(call[2]).toMatchObject({ timeout: 60_000 });
    }
    expect(json.package.bin_coverage).toEqual({
      covered_bins: ["pm", "pm-cli", "pm-mcp", "pm-mcp-http"],
      distinct_entrypoints: [
        "dist/cli.js",
        "dist/mcp/http-server.js",
        "dist/mcp/server.js",
      ],
      uncovered_bins: [],
    });
    expect(json.github_release.tagName).toBe("v2026.6.14");
    expect(runCommand.mock.calls[0]?.[1]?.[1]).toBe(
      "@unbrained/pm-cli@2026.6.14",
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      path.join("/tmp/pm-cli-published-verify-test", "npmrc-public"),
      "",
      "utf8",
    );
    for (const call of runCommand.mock.calls.slice(0, 7)) {
      expect(call[2]).toMatchObject({
        env: {
          NODE_AUTH_TOKEN: "",
          NPM_TOKEN: "",
          npm_config_cache: path.join(
            "/tmp/pm-cli-published-verify-test",
            "npm-cache",
          ),
          npm_config_userconfig: path.join(
            "/tmp/pm-cli-published-verify-test",
            "npmrc-public",
          ),
          BUN_INSTALL_CACHE_DIR: path.join(
            "/tmp/pm-cli-published-verify-test",
            "bun-cache",
          ),
        },
      });
    }
    expect(rmSync).toHaveBeenCalled();
  });

  it("prints a text success line when --json is omitted", async () => {
    const { logs } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-package",
        "--skip-github-release",
      ],
    });
    expect(logs.join("\n")).toContain("Published release 2026.6.14 verified.");
  });

  it("uses the workflow package identity for every public package surface", async () => {
    const { runCommand } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      npmPackage: "@example/pm-cli",
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        return successfulPublishedVerifierResult(command, args);
      },
    });
    expect(runCommand.mock.calls.slice(0, 7).map((call) => call[1])).toEqual([
      [
        "view",
        "@example/pm-cli@2026.6.14",
        "version",
        "dist.integrity",
        "dist.unpackedSize",
        "--json",
      ],
      [
        "--yes",
        "--package",
        "@example/pm-cli@2026.6.14",
        "--",
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      [
        "--yes",
        "@example/pm-cli@2026.6.14",
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      ["--yes", "--package", "@example/pm-cli@2026.6.14", "--", "pm-mcp"],
      [
        "--silent",
        "--bun",
        "--package",
        "@example/pm-cli@2026.6.14",
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      [
        "--silent",
        "--bun",
        "@example/pm-cli@2026.6.14",
        "pm",
        "--json",
        "--no-extensions",
        "contracts",
        "--summary",
      ],
      ["--silent", "--bun", "--package", "@example/pm-cli@2026.6.14", "pm-mcp"],
    ]);
  });
});

describe("scripts/release/verify-published-release: npm metadata retries", () => {
  it("retries npm metadata and succeeds on a later attempt (exercises sleep + waiting log)", async () => {
    const { json, errors } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--json",
        "--skip-github-release",
        "--npm-attempts",
        "2",
        "--executor-attempts",
        "1",
      ],
      sleepMs: "0",
      runCommand: (command, args, call) => {
        if (command === "npm" && args[0] === "view") {
          // First attempt fails, second succeeds.
          return call === 0
            ? { status: 1, stdout: "", stderr: "registry timeout" }
            : npmViewResult("2026.6.14");
        }
        if (command === "npx" || command === "bunx" || command === "node") {
          return successfulPublishedVerifierResult(command, args);
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(json.ok).toBe(true);
    expect(json.package.npm.attempts).toBe(2);
    expect(errors.join("\n")).toContain(
      "Waiting for npm metadata propagation (attempt 1/2)",
    );
  });

  it("fails npm metadata after exhausting attempts", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? { status: 1, stdout: "", stderr: "npm down" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain(
      "npm metadata verification failed: npm down",
    );
  });

  it("fails npm metadata on a version mismatch", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? npmViewResult("2026.6.13")
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_version_mismatch:2026.6.13");
  });

  it("fails npm metadata on malformed JSON", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? { status: 0, stdout: "not-json", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_json_parse_failed");
  });

  it("falls back to npm_view_failed when npm exits non-zero with empty stderr", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? { status: 1, stdout: "", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_view_failed");
  });

  it("reports a missing version when npm metadata omits the version field", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? {
              status: 0,
              stdout: JSON.stringify({ dist: { integrity: "sha512-x" } }),
              stderr: "",
            }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("npm_version_mismatch:missing");
  });
});

describe("scripts/release/verify-published-release: executor failures", () => {
  it("fails when an executor reports a mismatched version (no_output branch)", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
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
    expect(String(failure ?? "")).toContain("npx-pm verification failed");
    expect(String(failure ?? "")).toContain("npx-pm_invalid_output");
  });

  it("reports the stderr/no_output fallback when an executor exits non-zero with empty stdout", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
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
    expect(String(failure ?? "")).toContain(
      "npx-pm_execution_failed:executor crashed",
    );
  });

  it("reports no_output when an executor exits non-zero with empty stdout and stderr", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
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
    expect(String(failure ?? "")).toContain(
      "npx-pm_execution_failed:no_output",
    );
  });

  it("rejects non-object CLI output and an invalid MCP discovery response", async () => {
    const cli = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view")
          return npmViewResult("2026.6.14");
        if (command === "npx") return { status: 0, stdout: "null", stderr: "" };
        return successfulExecutorResult(args);
      },
    });
    expect(String(cli.failure)).toContain("cli_dispatch_not_an_object");

    const mcp = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view")
          return npmViewResult("2026.6.14");
        if (command === "npx" && args.includes("pm-mcp")) {
          return {
            status: 0,
            stdout: JSON.stringify({ id: 1, result: {} }),
            stderr: "",
          };
        }
        return successfulExecutorResult(args);
      },
    });
    expect(String(mcp.failure)).toContain("mcp_discovery_response_invalid");

    const scalarVersion = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view")
          return npmViewResult("2026.6.14");
        if (command === "npx" && args.includes("pm-mcp")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              id: 1,
              result: {
                resultType: "complete",
                supportedVersions: "2026-07-28",
                _meta: {
                  "io.modelcontextprotocol/serverInfo": { name: "pm-mcp" },
                },
              },
            }),
            stderr: "",
          };
        }
        return successfulExecutorResult(args);
      },
    });
    expect(String(scalarVersion.failure)).toContain(
      "mcp_discovery_response_invalid",
    );
  });

  it("fails closed when missing-bin controls pass or a manifest bin is uncovered", async () => {
    const negativeControl = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view")
          return npmViewResult("2026.6.14");
        return successfulPublishedVerifierResult(
          command,
          args.includes("pm-definitely-missing") ? [] : args,
        );
      },
    });
    expect(String(negativeControl.failure)).toContain(
      "negative control failed: a missing executable exited zero",
    );

    const uncovered = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      packageManifest: {
        name: "@unbrained/pm-cli",
        bin: {
          pm: "dist/cli.js",
          "pm-cli": "dist/cli.js",
          "pm-mcp": "dist/mcp/server.js",
          "pm-extra": "dist/extra.js",
        },
      },
      runCommand: (command, args) =>
        command === "npm" && args[0] === "view"
          ? npmViewResult("2026.6.14")
          : successfulPublishedVerifierResult(command, args),
    });
    expect(String(uncovered.failure)).toContain(
      "Published package bins lack executable coverage: pm-extra",
    );
    expect(uncovered.runCommand).toHaveBeenCalledTimes(1);
    expect(uncovered.runCommand.mock.calls[0]?.[0]).toBe("npm");
    expect(uncovered.runCommand.mock.calls[0]?.[1]?.[0]).toBe("view");
  });

  it("fails when the published HTTP bin returns an invalid discovery receipt", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        if (command === "node" && args.includes("--eval")) {
          return {
            status: 0,
            stdout: JSON.stringify({ ok: true, http_status: 503 }),
            stderr: "",
          };
        }
        return successfulExecutorResult(args);
      },
    });
    expect(String(failure)).toContain(
      "npx-pm-mcp-http verification failed: mcp_http_discovery_response_invalid",
    );
  });
});

describe("scripts/release/verify-published-release: github release", () => {
  it("fails when gh release view exits non-zero", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-package",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command) =>
        command === "gh"
          ? { status: 1, stdout: "", stderr: "no release" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain(
      "GitHub release verification failed: no release",
    );
  });

  it("falls back to gh_release_view_failed when gh stderr is empty", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-package",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command) =>
        command === "gh"
          ? { status: 1, stdout: "", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("gh_release_view_failed");
  });

  it("fails on a github release tag mismatch", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-package",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command) =>
        command === "gh"
          ? {
              status: 0,
              stdout: JSON.stringify({ tagName: "v2026.6.13" }),
              stderr: "",
            }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("GitHub release tag mismatch");
  });

  it("reports a missing received tag when gh metadata omits tagName", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-package",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command) =>
        command === "gh"
          ? {
              status: 0,
              stdout: JSON.stringify({ name: "v2026.6.14" }),
              stderr: "",
            }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("received missing");
  });

  it("fails when the github release is a draft or prerelease", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-package",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command) =>
        command === "gh"
          ? {
              status: 0,
              stdout: JSON.stringify({ tagName: "v2026.6.14", isDraft: true }),
              stderr: "",
            }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("must not be draft/prerelease");
  });

  it("fails when gh release JSON cannot be parsed", async () => {
    const { failure } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-package",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "1",
      ],
      runCommand: (command) =>
        command === "gh"
          ? { status: 0, stdout: "not-json{", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });
    expect(String(failure ?? "")).toContain("GitHub release JSON parse failed");
  });
});
