import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness(["../../../scripts/smoke-cleanup.mjs"]);

const SCRIPT = "scripts/smoke-npx-from-pack.mjs";
const SCRIPT_ABS = path.join(process.cwd(), "scripts/smoke-npx-from-pack.mjs");

/**
 * Strip the win32 `.cmd` suffix the script's `resolveCommand` appends to
 * `npm`/`npx`/`bunx` on `process.platform === "win32"`, so these
 * `execFileSync` mocks match the spawned command on every host. Without this,
 * the default executable keys never match their `.cmd` wrappers on
 * `windows-latest`. The dedicated win32 test below keys on the `.cmd` names
 * directly.
 */
const baseCommand = (command: string): string => command.replace(/\.cmd$/, "");

interface ExecResponses {
  packOutput?: string;
  /** Map a logical pm sub-command to its stdout (JSON string or text). */
  pmResponse?: (commandName: string, pmArgs: string[]) => string;
  /** Override direct (`npx <spec>`) responses. */
  directResponse?: (args: string[]) => string;
  aliasResponse?: (args: string[]) => string;
}

/** Supply canonical successful outputs for packed CLI workflow commands. */
function defaultPm(commandName: string): string {
  if (commandName === "--version") return "2026.6.14\n";
  if (commandName === "init") return JSON.stringify({ ok: true });
  if (commandName === "install") {
    return JSON.stringify({
      details: { installed_all: true, installed_count: 9 },
    });
  }
  if (commandName === "package") {
    return JSON.stringify({
      details: {
        packages: [
          { alias: "a" },
          { alias: "b" },
          { alias: "c" },
          { alias: "d" },
        ],
      },
    });
  }
  if (commandName === "create")
    return JSON.stringify({ item: { id: "pm-pack-smoke-item" } });
  if (commandName === "calendar")
    return JSON.stringify({ summary: { events: 1 } });
  if (commandName === "upgrade")
    return JSON.stringify({
      summary: { requested_packages: true },
      packages: [],
    });
  return "{}";
}

/** Recover arguments after the executable selected by npm exec or npx. */
function pmArgsAfterBinary(args: string[], binary: string): string[] {
  const index = args.indexOf(binary);
  return index >= 0 ? args.slice(index + 1) : [];
}

/** Route npm-exec calls through the logical pm response fixture. */
function handleNpmExec(
  args: string[],
  pm: (commandName: string, pmArgs: string[]) => string,
): string {
  const pmArgs = pmArgsAfterBinary(args, "pm");
  return pm(pmArgs[0], pmArgs);
}

/** Model direct local-tarball npx execution without network or installation. */
function handleBareNpxPackage(
  args: string[],
  responses: ExecResponses,
): string | undefined {
  if (!args.some((arg) => arg.startsWith("file:"))) {
    return undefined;
  }
  if (responses.directResponse) {
    return responses.directResponse(args);
  }
  if (args.includes("--version")) {
    return "2026.6.14\n";
  }
  return args.includes("--help") ? "Usage: pm\n" : undefined;
}

/** Model explicit `pm-cli` bin selection from the packed artifact. */
function handleAliasNpxPackage(
  args: string[],
  responses: ExecResponses,
): string | undefined {
  if (!args.includes("--package") || !args.includes("pm-cli")) {
    return undefined;
  }
  if (responses.aliasResponse) {
    return responses.aliasResponse(args);
  }
  if (args.includes("--version")) {
    return "2026.6.14\n";
  }
  return args.includes("--help") ? "Usage: pm-cli\n" : undefined;
}

/** Dispatch subprocess calls across pack, installed, npx, and bunx fixtures. */
function runExecFileSyncMock(
  command: string,
  args: string[],
  responses: ExecResponses,
  pm: (commandName: string, pmArgs: string[]) => string,
): string {
  const cmd = baseCommand(command);
  if (cmd === "npm" && args[0] === "pack") {
    return responses.packOutput ?? "pm-cli-2026.6.14.tgz\n";
  }
  if (cmd === "npm" && args[0] === "exec") {
    return handleNpmExec(args, pm);
  }
  if (cmd === "bunx") {
    return "2026.6.14\n";
  }
  if (cmd !== "npx") {
    return "";
  }
  return (
    handleBareNpxPackage(args, responses) ??
    handleAliasNpxPackage(args, responses) ??
    ""
  );
}

/** Create a Vitest subprocess spy with configurable package responses. */
function buildExecFileSync(responses: ExecResponses) {
  const pm = responses.pmResponse ?? ((c: string) => defaultPm(c));
  return vi.fn(
    (command: string, args: string[], _options?: { timeout?: number }) =>
      runExecFileSyncMock(command, args, responses, pm),
  );
}

/** Isolate filesystem effects while retaining every smoke control-flow branch. */
function mockFs() {
  vi.doMock("node:fs", () => ({
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => "/tmp/pm-pack-smoke"),
    writeFileSync: vi.fn(),
  }));
}

describe("smoke-npx-from-pack", () => {
  it("runs the packed smoke and warns on cleanup failure", async () => {
    const cleanupTempRoot = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({}),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "npx and bunx packed package smoke passed",
    );
    expect(cleanupTempRoot).toHaveBeenCalledWith("/tmp/pm-pack-smoke");
    expect(String(warnSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "[pm-pack-smoke] cleanup warning",
    );
  });

  it("runs cleanly when cleanup succeeds (no warning, readCommandError non-Error tolerated)", async () => {
    const cleanupTempRoot = vi.fn(() => undefined);
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({}),
    }));

    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(cleanupTempRoot).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("allows fresh-runner dependency resolution and bounds every subprocess", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    const execFileSync = buildExecFileSync({});
    vi.doMock("node:child_process", () => ({ execFileSync }));

    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);

    for (const [command, args, options] of execFileSync.mock.calls) {
      expect(options?.timeout).toBe(600_000);
      const normalizedCommand = baseCommand(command);
      if (
        normalizedCommand === "npx" ||
        (normalizedCommand === "npm" &&
          ["exec", "install"].includes(args[0] ?? ""))
      ) {
        expect(args).not.toContain("--offline");
      }
    }
    expect(
      execFileSync.mock.calls.some(
        ([command, args]) =>
          command === process.execPath && args[0]?.endsWith("cli-consumer.mjs"),
      ),
    ).toBe(true);
    const bunxArgs = execFileSync.mock.calls.find(
      ([command]) => baseCommand(command) === "bunx",
    )?.[1];
    expect(bunxArgs?.slice(0, 4)).toEqual([
      "--silent",
      "--bun",
      "--package",
      expect.any(String),
    ]);
    expect(path.basename(bunxArgs?.[3] ?? "")).toBe("pm-cli-2026.6.14.tgz");
    expect(bunxArgs?.slice(4)).toEqual(["pm", "--version"]);
  });

  it("throws when npm pack produces no tarball name", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({ packOutput: "   \n" }),
    }));
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      "npm pack did not produce a tarball name",
    );
  });

  it("throws when the installed packed binary produces empty version output", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        pmResponse: (commandName) =>
          commandName === "--version" ? "" : defaultPm(commandName),
      }),
    }));
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      "npx smoke test returned empty version output",
    );
  });

  it.each([
    {
      name: "empty version output",
      direct: undefined,
      pm: (c: string) => (c === "--version" ? "" : defaultPm(c)),
      expected: /returned empty version output/,
    },
    {
      name: "direct version mismatch",
      direct: (args: string[]) =>
        args.includes("--version") ? "9.9.9\n" : "Usage: pm\n",
      pm: undefined,
      expected: /Bare npx package smoke returned/,
    },
    {
      name: "alias help empty",
      alias: (args: string[]) =>
        args.includes("--version") ? "2026.6.14\n" : "",
      pm: undefined,
      expected: /pm-cli bin alias smoke returned empty help/,
    },
    {
      name: "install-all unexpected payload",
      pm: (c: string) =>
        c === "install"
          ? JSON.stringify({ details: { installed_all: false } })
          : defaultPm(c),
      expected: /Packed install-all smoke returned unexpected payload/,
    },
    {
      name: "catalog unexpected payload",
      pm: (c: string) =>
        c === "package"
          ? JSON.stringify({ details: { packages: [{ alias: "a" }] } })
          : defaultPm(c),
      expected: /Packed package catalog smoke returned unexpected payload/,
    },
    {
      name: "calendar unexpected payload",
      pm: (c: string) =>
        c === "calendar"
          ? JSON.stringify({ summary: { events: 0 } })
          : defaultPm(c),
      expected: /Packed calendar smoke returned unexpected payload/,
    },
    {
      name: "upgrade unexpected payload",
      pm: (c: string) =>
        c === "upgrade"
          ? JSON.stringify({ summary: { requested_packages: false } })
          : defaultPm(c),
      expected: /Packed package upgrade smoke returned unexpected payload/,
    },
  ])("throws on $name", async ({ direct, alias, pm, expected }) => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        directResponse: direct,
        aliasResponse: alias as ((args: string[]) => string) | undefined,
        pmResponse: pm,
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(expected);
  });

  it("resolves .cmd wrappers on win32", async () => {
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    mockFs();
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "npm.cmd" && args[0] === "pack")
        return "pm-cli-2026.6.14.tgz\n";
      if (command === "npm.cmd" && args[0] === "exec") {
        const pmArgs = pmArgsAfterBinary(args, "pm");
        return defaultPm(pmArgs[0]);
      }
      if (
        command === "npx.cmd" &&
        args.some((arg) => arg.startsWith("file:"))
      ) {
        if (args.includes("--version")) return "2026.6.14\n";
        if (args.includes("--help")) return "Usage: pm\n";
      }
      if (
        command === "npx.cmd" &&
        args.includes("--package") &&
        args.includes("pm-cli")
      ) {
        if (args.includes("--version")) return "2026.6.14\n";
        if (args.includes("--help")) return "Usage: pm-cli\n";
      }
      return { "bunx.cmd": "2026.6.14\n" }[command] ?? "";
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    try {
      await harness.importModule(SCRIPT);
    } finally {
      if (originalPlatform)
        Object.defineProperty(process, "platform", originalPlatform);
    }
    expect(execFileSync.mock.calls.some((call) => call[0] === "npm.cmd")).toBe(
      true,
    );
    expect(execFileSync.mock.calls.some((call) => call[0] === "npx.cmd")).toBe(
      true,
    );
    expect(execFileSync.mock.calls.some((call) => call[0] === "bunx.cmd")).toBe(
      true,
    );
  });

  it("readCommandError renders non-Error cleanup failures", async () => {
    const cleanupTempRoot = vi.fn(() => {
      throw "raw-cleanup-failure-string";
    });
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({}),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(String(warnSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "raw-cleanup-failure-string",
    );
  });

  it("readCommandError formats an Error with stdout present and a blank stderr value", async () => {
    const cleanupTempRoot = vi.fn(() => {
      const error = new Error("cleanup boom") as Error & {
        stderr?: string;
        stdout?: string;
      };
      error.stderr = "cleanup stderr line";
      error.stdout = "cleanup stdout detail";
      throw error;
    });
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({}),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(String(warnSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "cleanup stdout detail",
    );
  });

  it("readCommandError tolerates Errors whose stderr/stdout keys are present but nullish", async () => {
    const cleanupTempRoot = vi.fn(() => {
      const error = new Error("cleanup boom blank") as Error & {
        stderr?: string;
        stdout?: string;
      };
      error.stderr = undefined;
      error.stdout = undefined;
      throw error;
    });
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({}),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await harness.importModule(SCRIPT);
    expect(String(warnSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "cleanup boom blank",
    );
  });

  it("throws when the direct bare-npx version is empty (version-output fallback message)", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        directResponse: (args) =>
          args.includes("--version") ? "" : "Usage: pm\n",
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      /Bare npx package smoke returned empty version output instead of/,
    );
  });

  it("throws when the pm-cli alias help is empty", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        aliasResponse: () => "",
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      /pm-cli bin alias smoke returned empty help/,
    );
  });

  it("throws when the calendar payload omits summary.events entirely", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    vi.doMock("node:child_process", () => ({
      execFileSync: buildExecFileSync({
        pmResponse: (commandName) =>
          commandName === "calendar"
            ? JSON.stringify({})
            : defaultPm(commandName),
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow(
      /Packed calendar smoke returned unexpected payload/,
    );
  });

  it("fails when the packed TypeScript consumer typecheck rejects (GH-602)", async () => {
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot: vi.fn(),
    }));
    mockFs();
    const seenCommands: Array<[string, string[]]> = [];
    const passthrough = buildExecFileSync({});
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn((command: string, args: string[]) => {
        seenCommands.push([command, args]);
        if (
          baseCommand(command) !== "npm" &&
          baseCommand(command) !== "npx" &&
          args.some((arg) => arg.endsWith("tsc"))
        ) {
          const error = new Error("tsc failed") as Error & { stdout?: string };
          error.stdout = "consumer.ts(1,1): error TS2307: Cannot find module";
          throw error;
        }
        return passthrough(command, args);
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", SCRIPT_ABS];
    await expect(harness.importModule(SCRIPT)).rejects.toThrow("tsc failed");
    expect(
      seenCommands.some(
        ([command, args]) =>
          baseCommand(command) === "npm" &&
          args[0] === "install" &&
          args.some((arg) => arg.endsWith(".tgz")),
      ),
    ).toBe(true);
  });

  it("does not auto-run when argv[1] is not the script path", async () => {
    const cleanupTempRoot = vi.fn();
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    mockFs();
    const execFileSync = buildExecFileSync({});
    vi.doMock("node:child_process", () => ({ execFileSync }));
    process.argv = ["node", "/some/other/file.mjs"];
    await harness.importModule(SCRIPT);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
