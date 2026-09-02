import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync as makeRealTempDirectory,
  rmSync as removeRealDirectory,
  writeFileSync as writeRealFile,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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
    const skillText = "pm sdk\n";
    const skillDigest = `sha256:${createHash("sha256")
      .update(skillText)
      .digest("hex")}`;
    return {
      status: 0,
      stdout: [
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: {
              extensions: {
                "io.modelcontextprotocol/skills": {
                  status: "draft",
                  revision:
                    "SEP-2640@a3e147ca2710f68214247aecc729731ee1ae8d03",
                  directoryRead: true,
                },
                "io.modelcontextprotocol/ui": {
                  mimeTypes: ["text/html;profile=mcp-app"],
                },
              },
            },
            resultType: "complete",
            _meta: {
              "io.modelcontextprotocol/serverInfo": { name: "pm-mcp" },
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          result: {
            skills: [
              {
                uri: "skill://pm-sdk/SKILL.md",
                resources: [
                  {
                    uri: "skill://pm-sdk/SKILL.md",
                    digest: skillDigest,
                    size: Buffer.byteLength(skillText),
                  },
                ],
              },
            ],
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          result: {
            tools: [
              {
                name: "pm_context",
                _meta: { ui: { resourceUri: "ui://pm/context.html" } },
              },
            ],
          },
        },
        {
          jsonrpc: "2.0",
          id: 4,
          result: {
            contents: [
              {
                mimeType: "text/html;profile=mcp-app",
                text: "ui/initialize",
              },
            ],
          },
        },
        {
          jsonrpc: "2.0",
          id: 5,
          result: {
            contents: [
              {
                uri: "skill://pm-sdk/SKILL.md",
                mimeType: "text/markdown",
                text: skillText,
                _meta: { digest: skillDigest },
              },
            ],
          },
        },
      ].map((response) => JSON.stringify(response)).join("\n"),
      stderr: "",
    };
  }
  return {
    status: 0,
    stdout: JSON.stringify({ summary: { command_count: 1 } }),
    stderr: "",
  };
}

function transformMcpResponses(
  result: RunCommandResult,
  transform: (responses: Array<Record<string, unknown>>) => void,
): RunCommandResult {
  const responses = result.stdout
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  transform(responses);
  return {
    ...result,
    stdout: responses.map((response) => JSON.stringify(response)).join("\n"),
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
        extensions: [
          "io.modelcontextprotocol/skills",
          "io.modelcontextprotocol/ui",
        ],
      }),
      stderr: "",
    };
  }
  const result = successfulExecutorResult(args);
  if (!(command === "bunx" && args.includes("pm-mcp"))) return result;
  return transformMcpResponses(result, (responses) => {
    const response = responses.find((candidate) => candidate.id === 5);
    const contents = (response?.result as { contents?: unknown } | undefined)
      ?.contents;
    if (!Array.isArray(contents)) return;
    const content = contents[0] as Record<string, unknown>;
    content.blob = Buffer.from(String(content.text), "utf8").toString("base64");
    delete content.text;
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port for the test"));
        return;
      }
      server.close((error) =>
        error === undefined ? resolve(address.port) : reject(error),
      );
    });
  });
}

async function assertLoopbackPortIsReusable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  });
}

async function getMcpHttpEvaluatorScript(): Promise<string> {
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
    runCommand: (command, args) =>
      command === "npm" && args[0] === "view"
        ? npmViewResult("2026.6.14")
        : successfulPublishedVerifierResult(command, args),
  });
  const evaluatorCall = runCommand.mock.calls.find(
    ([command, args]) => command === "node" && args.includes("--eval"),
  );
  const evaluatorScript =
    evaluatorCall?.[1]?.[evaluatorCall[1].indexOf("--eval") + 1];
  expect(typeof evaluatorScript).toBe("string");
  return String(evaluatorScript);
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

    const malformedSkill = await runVerify({
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
        const result = successfulExecutorResult(args);
        if (!(command === "npx" && args.includes("pm-mcp"))) return result;
        return transformMcpResponses(result, (responses) => {
          const response = responses.find((candidate) => candidate.id === 2);
          const skills = (response?.result as { skills?: unknown } | undefined)
            ?.skills;
          if (!Array.isArray(skills)) return;
          for (const skill of skills as Array<Record<string, unknown>>) {
            skill.resources = null;
          }
        });
      },
    });
    expect(String(malformedSkill.failure)).toContain(
      "mcp_discovery_response_invalid",
    );

    const wrongRevision = await runVerify({
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
        const result = successfulExecutorResult(args);
        if (!(command === "npx" && args.includes("pm-mcp"))) return result;
        return transformMcpResponses(result, (responses) => {
          const response = responses.find((candidate) => candidate.id === 1);
          const resultValue = response?.result as {
            capabilities?: {
              extensions?: Record<string, Record<string, unknown>>;
            };
          } | undefined;
          const capability =
            resultValue?.capabilities?.extensions?.[
              "io.modelcontextprotocol/skills"
            ];
          if (capability) capability.revision = "SEP-2640@different";
        });
      },
    });
    expect(String(wrongRevision.failure)).toContain(
      "mcp_discovery_response_invalid",
    );

    const wrongDigest = await runVerify({
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
        const result = successfulExecutorResult(args);
        if (!(command === "npx" && args.includes("pm-mcp"))) return result;
        return transformMcpResponses(result, (responses) => {
          const response = responses.find((candidate) => candidate.id === 5);
          const contents = (response?.result as { contents?: unknown } | undefined)
            ?.contents;
          if (!Array.isArray(contents)) return;
          (contents[0] as { text?: string }).text = "tampered\n";
        });
      },
    });
    expect(String(wrongDigest.failure)).toContain(
      "mcp_discovery_response_invalid",
    );

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

  it("caps HTTP startup retries so their worst case fits the hosted step", async () => {
    const { failure, runCommand } = await runVerify({
      argv: [
        "--version",
        "2026.6.14",
        "--skip-github-release",
        "--npm-attempts",
        "1",
        "--executor-attempts",
        "10",
      ],
      runCommand: (command, args) => {
        if (command === "npm" && args[0] === "view") {
          return npmViewResult("2026.6.14");
        }
        if (command === "node" && args.includes("--eval")) {
          return { status: 1, stdout: "", stderr: "startup timeout" };
        }
        return successfulExecutorResult(args);
      },
    });
    expect(String(failure)).toContain("npx-pm-mcp-http verification failed");
    expect(
      runCommand.mock.calls.filter(
        ([command, args]) => command === "node" && args.includes("--eval"),
      ),
    ).toHaveLength(2);
  });

  it("bounds evaluator readiness and keeps the Windows process tree governed", async () => {
    const evaluatorScript = await getMcpHttpEvaluatorScript();
    expect(evaluatorScript).toContain("configuredReadyTimeout <= 15000");
    expect(evaluatorScript).toContain("$childArgs = [string[]]@(");
    expect(evaluatorScript).toContain("Start-Process");
    expect(evaluatorScript).toContain("-Wait");
    expect(evaluatorScript).toContain("taskkill.exe exited with code");
    expect(evaluatorScript).toContain(
      "Published HTTP process tree remained alive after taskkill.exe",
    );
  });

  it("kills a detached HTTP runner tree when readiness times out", async () => {
    const evaluatorScript = await getMcpHttpEvaluatorScript();

    const tempRoot = makeRealTempDirectory(
      path.join(tmpdir(), "pm-http-timeout-test-"),
    );
    const fakeRunner = path.join(tempRoot, "fake-runner.mjs");
    const port = await reserveLoopbackPort();
    writeRealFile(
      fakeRunner,
      [
        'import { createServer } from "node:net";',
        "const server = createServer(() => {});",
        'server.listen(Number(process.env.PM_MCP_HTTP_PORT), "127.0.0.1");',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", String(evaluatorScript)],
        {
          encoding: "utf8",
          timeout: 8_000,
          env: {
            ...process.env,
            PM_VERIFY_HTTP_RUNNER: "npx",
            PM_VERIFY_HTTP_RUNNER_COMMAND: process.execPath,
            PM_VERIFY_HTTP_PACKAGE_SPEC: "@example/pm-cli@2026.6.14",
            PM_VERIFY_HTTP_RUNNER_ARGS_JSON: JSON.stringify([fakeRunner]),
            PM_VERIFY_HTTP_PORT: String(port),
            PM_VERIFY_HTTP_READY_TIMEOUT_MS: "200",
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Published HTTP bin did not become reachable before timeout",
      );
      await assertLoopbackPortIsReusable(port);
    } finally {
      removeRealDirectory(tempRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it("kills a surviving server after its intermediate runner exits", async () => {
    const evaluatorScript = await getMcpHttpEvaluatorScript();

    const tempRoot = makeRealTempDirectory(
      path.join(tmpdir(), "pm-http-runner-exit-test-"),
    );
    const serverScript = path.join(tempRoot, "surviving-server.mjs");
    const runnerScript = path.join(tempRoot, "exiting-runner.mjs");
    const port = await reserveLoopbackPort();
    writeRealFile(
      serverScript,
      [
        'import { createServer } from "node:net";',
        "const body = JSON.stringify({ ok: false });",
        "const server = createServer((socket) => {",
        "  setTimeout(() => socket.end(",
        '    "HTTP/1.1 503 Service Unavailable\\r\\n" +',
        '    "Content-Type: application/json\\r\\n" +',
        '    "Content-Length: " + Buffer.byteLength(body) + "\\r\\n" +',
        '    "Connection: close\\r\\n\\r\\n" + body,',
        "  ), 700);",
        "});",
        'server.listen(Number(process.env.PM_MCP_HTTP_PORT), "127.0.0.1");',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      "utf8",
    );
    writeRealFile(
      runnerScript,
      [
        'import { spawn } from "node:child_process";',
        `spawn(process.execPath, [${JSON.stringify(serverScript)}], {`,
        "  env: process.env,",
        '  stdio: "ignore",',
        "});",
        "await new Promise((resolve) => setTimeout(resolve, 200));",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", String(evaluatorScript)],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            PM_VERIFY_HTTP_RUNNER: "npx",
            PM_VERIFY_HTTP_RUNNER_COMMAND: process.execPath,
            PM_VERIFY_HTTP_PACKAGE_SPEC: "@example/pm-cli@2026.6.14",
            PM_VERIFY_HTTP_RUNNER_ARGS_JSON: JSON.stringify([runnerScript]),
            PM_VERIFY_HTTP_PORT: String(port),
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Published HTTP discovery response was invalid",
      );
      await assertLoopbackPortIsReusable(port);
    } finally {
      removeRealDirectory(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);
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
