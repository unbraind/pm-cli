import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const UTILS_SPECIFIER = "../../../../scripts/release/utils.mjs";
const harness = createScriptHarness([UTILS_SPECIFIER]);

type CommandResult = { status: number; stdout: string; stderr: string };

interface RunOptions {
  argv: string[];
  npmPackage?: string;
  realpath?: (value: string) => string;
  runCommand?: (command: string, args: string[]) => CommandResult;
}

async function runAcceptance(options: RunOptions) {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doUnmock(UTILS_SPECIFIER);
  if (options.npmPackage === undefined) delete process.env.NPM_PACKAGE;
  else process.env.NPM_PACKAGE = options.npmPackage;
  const fsMocks = {
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => "/tmp/installed-agent-test"),
    readFileSync: vi.fn(() => JSON.stringify({ name: "@unbrained/pm-cli" })),
    realpathSync: vi.fn(options.realpath ?? ((value: string) => value)),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  vi.doMock("node:fs", () => fsMocks);
  const runCommand = vi.fn((command: string, args: string[]) =>
    (options.runCommand ?? successfulCommand)(command, args),
  );
  vi.doMock(UTILS_SPECIFIER, async () => {
    const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(UTILS_SPECIFIER);
    return {
      ...actual,
      commandFor: (binary: string) => binary,
      runCommand,
      fail(message: string) {
        throw new Error(`FAIL:${message}`);
      },
    };
  });
  process.argv = [
    "node",
    "scripts/release/verify-installed-agent-session.mjs",
    ...options.argv,
  ];
  const writes: string[] = [];
  const logs: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    writes.push(String(value));
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    logs.push(String(value ?? ""));
  });
  let failure: unknown = null;
  try {
    await harness.importModuleStable(
      "scripts/release/verify-installed-agent-session.mjs",
    );
  } catch (error) {
    failure = error;
  }
  return {
    failure,
    fsMocks,
    logs,
    runCommand,
    json: writes.length > 0 ? JSON.parse(writes.at(-1) ?? "null") : null,
  };
}

function successfulCommand(command: string, args: string[]): CommandResult {
  if (
    (command === "npm" && args[0] === "install") ||
    (command === "bun" && args[0] === "add")
  ) {
    return { status: 0, stdout: "installed", stderr: "" };
  }
  if (args.includes("create")) {
    return { status: 0, stdout: JSON.stringify({ id: "accept-test" }), stderr: "" };
  }
  if (args.includes("get")) {
    return {
      status: 0,
      stdout: JSON.stringify({ item: { id: "accept-test", status: "closed" } }),
      stderr: "",
    };
  }
  return { status: 0, stdout: "{}", stderr: "" };
}

describe("verify-installed-agent-session", () => {
  it("prints usage without installing", async () => {
    const result = await runAcceptance({ argv: ["--help"] });
    expect(result.logs.join("\n")).toContain("verify-installed-agent-session.mjs");
    expect(result.runCommand).not.toHaveBeenCalled();
  });

  it("rejects missing versions and invalid manager names", async () => {
    const missing = await runAcceptance({ argv: [] });
    expect(String(missing.failure)).toContain("Missing or invalid --version");
    const manager = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "pnpm"],
    });
    expect(String(manager.failure)).toContain("Invalid --manager value");
  });

  it("installs through npm and Bun and reports the complete bounded agent loop", async () => {
    const result = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "both", "--json"],
    });
    expect(result.failure).toBeNull();
    expect(result.json).toMatchObject({
      ok: true,
      version: "2026.7.31",
      package: "@unbrained/pm-cli",
    });
    expect(result.json.sessions.map((session: { manager: string }) => session.manager)).toEqual([
      "npm",
      "bun",
    ]);
    for (const session of result.json.sessions) {
      expect(session.step_count).toBe(10);
      expect(session.item_id).toBe("accept-test");
      expect(session.steps.every((step: { ok: boolean }) => step.ok)).toBe(true);
      expect(session.estimated_output_tokens).toBeGreaterThan(0);
    }
    expect(result.fsMocks.rmSync).toHaveBeenCalledWith(
      "/tmp/installed-agent-test",
      { recursive: true, force: true },
    );
  });

  it("uses an explicit package override and prints the text success form", async () => {
    const result = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      npmPackage: "@example/pm-cli",
    });
    expect(result.failure).toBeNull();
    expect(result.logs.join("\n")).toContain(
      "Installed-agent acceptance passed for @example/pm-cli@2026.7.31.",
    );
    expect(result.runCommand.mock.calls[0]?.[1]).toContain(
      "@example/pm-cli@2026.7.31",
    );
  });

  it("fails closed on escaped binaries and failed installs", async () => {
    const escaped = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      realpath: (value) =>
        value.includes(`${path.sep}.bin${path.sep}`)
          ? path.join(path.parse(value).root, "outside", "pm")
          : value,
    });
    expect(String(escaped.failure)).toContain("escaped its package root");
    const installFailure = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "bun"],
      runCommand: (command, args) =>
        command === "bun" && args[0] === "add"
          ? { status: 1, stdout: "", stderr: "registry unavailable" }
          : successfulCommand(command, args),
    });
    expect(String(installFailure.failure)).toContain(
      "bun exact-package installation failed: registry unavailable",
    );
  });

  it("reports the exact failing agent step, malformed output, and output budget", async () => {
    const commandFailure = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        args.includes("context")
          ? { status: 1, stdout: "", stderr: "context failed" }
          : successfulCommand(command, args),
    });
    expect(String(commandFailure.failure)).toContain(
      "failed at npm:orient: context failed",
    );
    const emptyCommandFailure = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        args.includes("context")
          ? { status: 1, stdout: "", stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(emptyCommandFailure.failure)).toContain(
      "failed at npm:orient: command exited non-zero",
    );
    const malformed = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        args.includes("claim")
          ? { status: 0, stdout: "not-json", stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(malformed.failure)).toContain("invalid JSON at npm:claim");
    const oversized = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        args.includes("comments")
          ? { status: 0, stdout: JSON.stringify({ value: "x".repeat(5_000) }), stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(oversized.failure)).toContain("exceeded the annotate output budget");
  });

  it("uses the empty installer failure fallback", async () => {
    const installFailure = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        command === "npm" && args[0] === "install"
          ? { status: 1, stdout: "", stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(installFailure.failure)).toContain(
      "npm exact-package installation failed: installer exited non-zero",
    );
  });

  it("requires create identity and closed read-back state", async () => {
    const missingId = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        args.includes("create")
          ? { status: 0, stdout: "{}", stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(missingId.failure)).toContain("did not return an item id");
    const openReadBack = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        args.includes("get")
          ? { status: 0, stdout: JSON.stringify({ item: { status: "open" } }), stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(openReadBack.failure)).toContain(
      "read-back did not observe closed state",
    );
  });
});
