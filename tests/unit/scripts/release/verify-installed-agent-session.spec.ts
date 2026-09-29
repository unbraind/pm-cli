import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const UTILS_SPECIFIER = "../../../../scripts/release/utils.mjs";
const harness = createScriptHarness([UTILS_SPECIFIER]);

type CommandResult = { status: number; stdout: string; stderr: string; exit_status?: number | null; signal?: string | null; error_code?: string | null; timed_out?: boolean };

interface RunOptions {
  argv: string[];
  npmPackage?: string;
  npmExecpath?: string | null;
  realpath?: (value: string) => string;
  runCommand?: (command: string, args: string[]) => CommandResult;
  elapsedBeyondDeadline?: boolean;
}

/** Execute the real verifier with isolated installer, filesystem, and output boundaries. */
async function runAcceptance(options: RunOptions) {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs");
  vi.doUnmock(UTILS_SPECIFIER);
  process.env.PM_VERIFY_SLEEP_MS = "0";
  if (options.npmExecpath === null) delete process.env.npm_execpath;
  else process.env.npm_execpath = options.npmExecpath ?? "C:/node/npm-cli.js";
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
  const runCommand = vi.fn((command: string, args: string[], _execution: { env: NodeJS.ProcessEnv; inheritEnvironment?: boolean }) =>
    (options.runCommand ?? successfulCommand)(command, args),
  );
  vi.doMock(UTILS_SPECIFIER, async () => {
    const actual =
      await vi.importActual<Record<string, unknown>>(UTILS_SPECIFIER);
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
  if (options.elapsedBeyondDeadline) {
    let reads = 0;
    vi.spyOn(Date, "now").mockImplementation(() => ++reads === 1 ? 0 : 13 * 60_000 + 1);
  }
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

/** Return minimal valid installer and lifecycle receipts for controlled failure variations. */
function successfulCommand(command: string, args: string[]): CommandResult {
  if (
    (["npm", process.execPath].includes(command) && args.includes("install")) ||
    (command === "bun" && args[0] === "add")
  ) {
    return { status: 0, stdout: "installed", stderr: "" };
  }
  if (args.includes("create")) {
    return {
      status: 0,
      stdout: JSON.stringify({ id: "accept-test" }),
      stderr: "",
    };
  }
  if (args.includes("get")) {
    return {
      status: 0,
      stdout: JSON.stringify({ item: { id: "accept-test", status: "closed" } }),
      stderr: "",
    };
  }
  if (args.some((arg) => arg.includes("listAllComplete"))) {
    return {
      status: 0,
      stdout: JSON.stringify({
        item_count: 1,
        source_complete: true,
        full_projection: true,
      }),
      stderr: "",
    };
  }
  return { status: 0, stdout: "{}", stderr: "" };
}

describe("verify-installed-agent-session", () => {
  it("isolates inherited script policy without changing the caller environment", async () => {
    vi.stubEnv("npm_config_allow_scripts", "lowercase-policy");
    vi.stubEnv("NpM_CoNfIg_AlLoW_ScRiPtS", "mixed-policy");
    vi.stubEnv("NPM_CONFIG_ALLOW_SCRIPTS", "uppercase-policy");
    vi.stubEnv("npm_config_fetch_retries", "7");
    const callerPolicy = Object.entries(process.env).filter(([key]) => key.toLowerCase() === "npm_config_allow_scripts");
    try {
      const result = await runAcceptance({ argv: ["--version", "2026.9.18", "--manager", "both", "--json"] });
      expect(result.failure).toBeNull();
      for (const [, , execution] of result.runCommand.mock.calls) {
        expect(execution.inheritEnvironment).toBe(false);
        expect(Object.keys(execution.env).filter((key) => key.toLowerCase() === "npm_config_allow_scripts")).toEqual(["NPM_CONFIG_ALLOW_SCRIPTS"]);
        expect(execution.env.NPM_CONFIG_ALLOW_SCRIPTS).toBe("");
        expect(execution.env.npm_config_fetch_retries).toBe("7");
      }
      expect(Object.entries(process.env).filter(([key]) => key.toLowerCase() === "npm_config_allow_scripts")).toEqual(callerPolicy);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs the previous public release first in an independent global prefix", async () => {
    const result = await runAcceptance({ argv: ["--version", "2026.9.16", "--previous-version", "2026.9.15", "--manager", "npm", "--global", "--json"] });
    expect(result.failure).toBeNull();
    expect(result.json.sessions.map((session: { version: string; role: string; install_mode: string }) => [session.version, session.role, session.install_mode])).toEqual([
      ["2026.9.15", "control", "global"], ["2026.9.16", "candidate", "global"],
    ]);
    const installs = result.runCommand.mock.calls.filter(([, args]) => args.includes("install"));
    expect(installs).toHaveLength(2);
    expect(installs[0]?.[1]).toContain("--global");
    expect(installs[0]?.[1]).not.toEqual(installs[1]?.[1]);
  });

  it.each(["latest", "2026.9.16"])("rejects invalid control %s", async (previous) => {
    const result = await runAcceptance({ argv: ["--version", "2026.9.16", "--previous-version", previous] });
    expect(String(result.failure)).toContain("Invalid --previous-version");
  });

  it("requires npm for global acceptance", async () => {
    const result = await runAcceptance({ argv: ["--version", "2026.9.16", "--global"] });
    expect(String(result.failure)).toContain("--global requires");
  });

  it("uses the actual npm JavaScript entrypoint on Windows", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const missing = await runAcceptance({ argv: ["--version", "2026.9.16", "--manager", "npm"], npmExecpath: null });
      expect(String(missing.failure)).toContain("npm_execpath");
      const result = await runAcceptance({ argv: ["--version", "2026.9.16", "--manager", "npm", "--global", "--json"] });
      expect(result.failure).toBeNull();
      expect(result.runCommand.mock.calls[0]?.[0]).toBe(process.execPath);
      expect(result.runCommand.mock.calls[0]?.[1][0]).toBe("C:/node/npm-cli.js");
      expect(result.json.sessions[0].executable).not.toContain(`${path.sep}lib${path.sep}`);
    } finally {
      Object.defineProperty(process, "platform", descriptor!);
    }
  });

  it("prints usage without installing", async () => {
    const result = await runAcceptance({ argv: ["--help"] });
    expect(result.logs.join("\n")).toContain(
      "verify-installed-agent-session.mjs",
    );
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
    expect(
      result.json.sessions.map(
        (session: { manager: string }) => session.manager,
      ),
    ).toEqual(["npm", "bun"]);
    for (const session of result.json.sessions) {
      expect(session.step_count).toBe(11);
      expect(session.item_id).toBe("accept-test");
      expect(session.steps.every((step: { ok: boolean }) => step.ok)).toBe(
        true,
      );
      expect(session.estimated_output_tokens).toBeGreaterThan(0);
    }
    expect(result.fsMocks.rmSync).toHaveBeenCalledWith(
      "/tmp/installed-agent-test",
      { recursive: true, force: true },
    );
    expect(
      result.runCommand.mock.calls.some(
        ([command, args]) =>
          command === "bun" && args.includes("--ignore-scripts"),
      ),
    ).toBe(true);
    expect(
      result.runCommand.mock.calls.filter(
        ([command, args]) =>
          ["bun", process.execPath].includes(command) &&
          args.some((arg) => arg.includes("listAllComplete")),
      ),
    ).toHaveLength(2);
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
        value.endsWith(`${path.sep}cli.js`)
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
      'bun exact-package installation failed: [{"attempt":1,"classification":"nonzero_exit"',
    );
    expect(
      installFailure.runCommand.mock.calls.filter(
        ([command, args]) => command === "bun" && args[0] === "add",
      ),
    ).toHaveLength(1);
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
          ? {
              status: 0,
              stdout: JSON.stringify({ value: "x".repeat(5_000) }),
              stderr: "",
            }
          : successfulCommand(command, args),
    });
    expect(String(oversized.failure)).toContain(
      "exceeded the annotate output budget",
    );
  });

  it("uses the empty installer failure fallback", async () => {
    const installFailure = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "npm"],
      runCommand: (command, args) =>
        ["npm", process.execPath].includes(command) && args.includes("install")
          ? { status: 1, stdout: "", stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(installFailure.failure)).toContain(
      'npm exact-package installation failed: [{"attempt":1,"classification":"nonzero_exit"',
    );
  });

  it.each([
    { name: "timeout", result: { status: 1, exit_status: null, signal: "SIGTERM", error_code: "ETIMEDOUT", timed_out: true, stderr: "timed out" }, classification: "timeout" },
    { name: "signal", result: { status: 1, exit_status: null, signal: "SIGKILL", stderr: "" }, classification: "signal" },
    { name: "missing executable", result: { status: 1, exit_status: null, error_code: "ENOENT", stderr: "" }, classification: "executable_missing" },
    { name: "other spawn error", result: { status: 1, exit_status: null, error_code: "EACCES", stderr: "" }, classification: "spawn_error" },
    { name: "nonzero exit", result: { status: 17, exit_status: 17, stderr: "failed" }, classification: "nonzero_exit" },
  ])("classifies $name without a registry retry", async ({ result, classification }) => {
    const acceptance = await runAcceptance({
      argv: ["--version", "2026.9.29", "--manager", "npm"],
      runCommand: (command, args) => args.includes("install")
        ? { stdout: "", ...result }
        : successfulCommand(command, args),
    });
    expect(String(acceptance.failure)).toContain(`"classification":"${classification}"`);
    expect(acceptance.runCommand.mock.calls.filter(([, args]) => args.includes("install"))).toHaveLength(1);
  });

  it("retains redacted registry failures after successful propagation", async () => {
    let attempts = 0;
    const acceptance = await runAcceptance({
      argv: ["--version", "2026.9.29", "--manager", "bun", "--json"],
      runCommand: (command, args) => {
        if (command === "bun" && args[0] === "add" && ++attempts === 1) {
          return { status: 1, stdout: "", stderr: "E404 404 Not Found https://secret@example.com/pkg Bearer private-token" };
        }
        return successfulCommand(command, args);
      },
    });
    expect(acceptance.failure).toBeNull();
    expect(acceptance.json.sessions[0].install_attempts).toMatchObject([
      { classification: "registry_visibility", attempt: 1 },
      { classification: "success", attempt: 2 },
    ]);
    expect(JSON.stringify(acceptance.json)).not.toContain("private-token");
    expect(JSON.stringify(acceptance.json)).not.toContain("secret@example.com");
  });

  it("detects a registry 404 beyond the excerpt and redacts complete authorization values", async () => {
    let attempts = 0;
    const acceptance = await runAcceptance({
      argv: ["--version", "2026.9.29", "--manager", "npm", "--json"],
      runCommand: (command, args) => {
        if (args.includes("install") && ++attempts === 1) {
          return { status: 1, stdout: "", stderr: `Authorization: token abc-secret\n${"x".repeat(600)} E404 404 Not Found` };
        }
        return successfulCommand(command, args);
      },
    });
    expect(acceptance.failure).toBeNull();
    expect(attempts).toBe(2);
    expect(acceptance.json.sessions[0].install_attempts[0].classification).toBe("registry_visibility");
    expect(acceptance.json.sessions[0].install_attempts[0].stderr_excerpt).toContain("Authorization: [redacted]");
    expect(JSON.stringify(acceptance.json)).not.toContain("abc-secret");
    expect(acceptance.json.sessions[0].install_attempts[0].stderr_excerpt).toHaveLength(512);
  });

  it.each([
    "error: GET https://registry.npmjs.org/@unbrained%2fpm-cli-404-probe-20260929 - 404",
    'error: package "@example/pm-cli" not found registry.npmjs.org/@example/pm-cli 404',
  ])("retries a Bun registry visibility failure with a bare 404: %s", async (stderr) => {
    let attempts = 0;
    const acceptance = await runAcceptance({
      argv: ["--version", "2026.9.29", "--manager", "bun", "--json"],
      runCommand: (command, args) => command === "bun" && args[0] === "add" && ++attempts === 1
        ? { status: 1, stdout: "", stderr }
        : successfulCommand(command, args),
    });
    expect(acceptance.failure).toBeNull();
    expect(attempts).toBe(2);
    expect(acceptance.json.sessions[0].install_attempts.map((row: { classification: string }) => row.classification)).toEqual(["registry_visibility", "success"]);
  });

  it("does not retry an unrelated bare 404 or HTTP 403", async () => {
    for (const stderr of ["package not found 404", "error: GET https://registry.npmjs.org/example - 403"]) {
      const acceptance = await runAcceptance({
        argv: ["--version", "2026.9.29", "--manager", "bun"],
        runCommand: (command, args) => command === "bun" && args[0] === "add"
          ? { status: 1, stdout: "", stderr }
          : successfulCommand(command, args),
      });
      expect(String(acceptance.failure)).toContain('"classification":"nonzero_exit"');
      expect(acceptance.runCommand.mock.calls.filter(([command, args]) => command === "bun" && args[0] === "add")).toHaveLength(1);
    }
  });

  it("bounds repeated registry visibility failures and preserves the first attempt", async () => {
    const acceptance = await runAcceptance({
      argv: ["--version", "2026.9.29", "--manager", "npm"],
      runCommand: (command, args) => args.includes("install")
        ? { status: 1, stdout: "", stderr: "E404 404 Not Found token=private" }
        : successfulCommand(command, args),
    });
    expect(acceptance.runCommand.mock.calls.filter(([, args]) => args.includes("install"))).toHaveLength(3);
    expect(String(acceptance.failure)).toContain('"attempt":1,"classification":"registry_visibility"');
    expect(String(acceptance.failure)).toContain('"attempt":3,"classification":"registry_visibility"');
    expect(String(acceptance.failure)).not.toContain("private");
  });

  it("refuses work once the shared acceptance deadline has elapsed", async () => {
    const acceptance = await runAcceptance({ argv: ["--version", "2026.9.29", "--manager", "npm"], elapsedBeyondDeadline: true });
    expect(String(acceptance.failure)).toContain("total deadline");
    expect(acceptance.runCommand).not.toHaveBeenCalled();
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
          ? {
              status: 0,
              stdout: JSON.stringify({ item: { status: "open" } }),
              stderr: "",
            }
          : successfulCommand(command, args),
    });
    expect(String(openReadBack.failure)).toContain(
      "read-back did not observe closed state",
    );
    const incompleteSdkRead = await runAcceptance({
      argv: ["--version", "2026.7.31", "--manager", "bun"],
      runCommand: (command, args) =>
        args.some((arg) => arg.includes("listAllComplete"))
          ? { status: 0, stdout: JSON.stringify({ item_count: 1 }), stderr: "" }
          : successfulCommand(command, args),
    });
    expect(String(incompleteSdkRead.failure)).toContain(
      "SDK read was not complete for bun",
    );
  });
});
