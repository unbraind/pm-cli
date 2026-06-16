import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../helpers/scriptModule";

const harness = createScriptHarness();

const SCRIPT = "scripts/smoke-external-packages.mjs";
const CLI_TAIL = path.join("dist", "cli.js");

function isCli(command: string, args: string[]): boolean {
  return command === process.execPath && Boolean(args[0]?.endsWith(CLI_TAIL));
}

async function runScript(argv: string[]): Promise<void> {
  process.argv = ["node", "scripts/smoke-external-packages.mjs", ...argv];
  await harness.importModule(SCRIPT);
}

describe("smoke-external-packages", () => {
  it("prints help and exits 0 on --help", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? "")}`);
    }) as never);
    // process.exit(0) throws EXIT:0 -> caught by the module's top-level try/catch.
    await runScript(["--help"]);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Usage: node scripts/smoke-external-packages.mjs"))).toBe(
      true,
    );
    exitSpy.mockRestore();
  });

  it("discover-only prints discovered ecosystem package names", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "search") {
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: "pm-package-alpha", description: "pm package", keywords: ["pm-package"] },
            { name: "not-related", description: "other", keywords: ["misc"] },
            { name: "pm-extension-beta", description: "pm extension", keywords: "pm-extension other" },
            { name: "", description: "blank name skipped", keywords: ["pm-package"] },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--discover-only", "--limit", "5", "--query", "keywords:pm-package"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      mode: string;
      packages: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe("discover");
    expect(payload.packages).toEqual(["pm-package-alpha", "pm-extension-beta"]);
  });

  it("runs explicit packages with a mixed pass/fail result and sets exitCode=1", async () => {
    let currentPackage = "";
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        const cmd = pmArgs[0];
        if (cmd === "init") return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        if (cmd === "install") {
          currentPackage = String(pmArgs[1] ?? "").replace(/^npm:/, "");
          if (currentPackage === "pm-bad") return { status: 1, stdout: "", stderr: "install failed" };
          return { status: 0, stdout: JSON.stringify({ details: { installed_count: 1 } }), stderr: "" };
        }
        if (cmd === "package" && pmArgs[1] === "doctor") {
          return {
            status: 0,
            stdout: JSON.stringify({
              details: { summary: { activation_failure_count: 0, blocking_failure_count: 0 }, triage: { warning_codes: [] } },
            }),
            stderr: "",
          };
        }
        if (cmd === "contracts") {
          return {
            status: 0,
            stdout: JSON.stringify({
              action_availability: [{ action: `action-${currentPackage}`, invocable: true, available: true }],
            }),
            stderr: "",
          };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke"),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--package", "npm:pm-good", "--package", "pm-bad", "--timeout-ms", "50", "--keep-temp"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      tested: number;
      failed: number;
      query: string | null;
      results: Array<{ package: string; ok: boolean; temp_root?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.tested).toBe(2);
    expect(payload.failed).toBe(1);
    expect(payload.query).toBeNull();
    expect(payload.results.some((e) => e.package === "pm-good" && e.ok && e.temp_root)).toBe(true);
    expect(payload.results.some((e) => e.package === "pm-bad" && !e.ok)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("reports a package failure when package doctor reports activation/blocking failures and cleanup warns", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        const cmd = pmArgs[0];
        if (cmd === "init") return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        if (cmd === "install") return { status: 0, stdout: JSON.stringify({ details: { installed_count: 1 } }), stderr: "" };
        if (cmd === "package" && pmArgs[1] === "doctor") {
          return {
            status: 0,
            stdout: JSON.stringify({
              details: { summary: { activation_failure_count: 2, blocking_failure_count: 1 } },
            }),
            stderr: "",
          };
        }
        if (cmd === "contracts") return { status: 0, stdout: JSON.stringify({}), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke-fail"),
      rmSync: vi.fn(() => {
        throw new Error("rm failed");
      }),
      writeFileSync: vi.fn(),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--package", "pm-doctor-fail"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      results: Array<{ package: string; ok: boolean; error?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.results[0].error).toContain("package doctor reported activation=2 blocking=1");
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("failed to clean up temp directory"))).toBe(true);
  });

  it("reports a failure when a pm command emits non-JSON output", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        if (pmArgs[0] === "init") return { status: 0, stdout: "not json at all", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke-json"),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--package", "pm-json-bad"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(payload.results[0].ok).toBe(false);
    expect(payload.results[0].error).toContain("did not emit JSON");
  });

  it("fails fast when the dist CLI is not runnable", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 1, stdout: "", stderr: "missing build" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--discover-only"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("dist CLI is not runnable"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when npm search exits non-zero", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "search") {
        return { status: 1, stdout: "partial", stderr: "search boom" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--discover-only"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("npm search failed"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("fails when npm search returns a non-array payload", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "search") {
        return { status: 0, stdout: JSON.stringify({ not: "an array" }), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--discover-only"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("non-array payload"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("parses --packages comma lists, dedupes, and tolerates -- separators", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--", "--packages", "npm:pm-x, pm-x , pm-y,", "--discover-only"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as { packages: string[] };
    expect(payload.packages).toEqual(["pm-x", "pm-y"]);
  });

  it("rejects a flag with a missing value", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--query"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("--query requires a value"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a flag value that looks like another flag", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--query", "--limit"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("--query requires a value"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("rejects a non-positive integer for --limit", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--limit", "0"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("--limit must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an unknown option", async () => {
    vi.doMock("node:child_process", () => ({ spawnSync: vi.fn() }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--bogus"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("Unknown option: --bogus"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("smokes discovered packages on the default (non-discover) path with temp cleanup", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "search") {
        return {
          status: 0,
          stdout: JSON.stringify([{ name: "pm-package-found", description: "pm package", keywords: ["pm-package"] }]),
          stderr: "",
        };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        const cmd = pmArgs[0];
        if (cmd === "init") return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        if (cmd === "install") return { status: 0, stdout: JSON.stringify({ details: { installed_count: 1 } }), stderr: "" };
        if (cmd === "package" && pmArgs[1] === "doctor") {
          return {
            status: 0,
            stdout: JSON.stringify({
              details: { summary: { activation_failure_count: 0, blocking_failure_count: 0 }, triage: { warning_codes: ["w"] } },
            }),
            stderr: "",
          };
        }
        if (cmd === "contracts") {
          return {
            status: 0,
            stdout: JSON.stringify({ action_availability: [{ action: "act", invocable: true }, { invocable: false }] }),
            stderr: "",
          };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const rmSync = vi.fn();
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke-ok"),
      rmSync,
      writeFileSync: vi.fn(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--limit", "3"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      query: string | null;
      filters: unknown;
      results: Array<{ package: string; ok: boolean; temp_root?: string; available_runtime_actions: string[] }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.query).toBe("keywords:pm-package");
    expect(payload.filters).toEqual({ markers: ["pm-package", "pm-cli", "pm-extension", "pm-cli-extension"] });
    expect(payload.results[0].package).toBe("pm-package-found");
    expect(payload.results[0].temp_root).toBeUndefined();
    expect(payload.results[0].available_runtime_actions).toEqual(["act"]);
    expect(rmSync).toHaveBeenCalled();
  });

  it("normalizes spawn results with null status, missing stdout, and a spawn error", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        if (pmArgs[0] === "init") {
          // status null -> code 1; stdout undefined -> ""; no stderr but error -> error.message.
          return { status: null, signal: null, error: new Error("spawn ETIMEDOUT") };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke-nullstatus"),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--package", "pm-null"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(payload.results[0].ok).toBe(false);
    expect(payload.results[0].error).toContain("spawn ETIMEDOUT");
  });

  it("falls back to a generated label message when a failing command yields no error text", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        if (pmArgs[0] === "init") {
          // Non-zero code but empty stdout/stderr/error -> entry.error "" -> `${label} failed`.
          return { status: 1, signal: null, stdout: "", stderr: "" };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke-blank"),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--package", "pm-blank-fail"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      results: Array<{ ok: boolean; error?: string }>;
    };
    expect(payload.results[0].ok).toBe(false);
    expect(payload.results[0].error).toBe("init failed");
  });

  it("defaults doctor summary, counts, install count, contracts, and warning codes when absent", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        const cmd = pmArgs[0];
        if (cmd === "init") return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        if (cmd === "install") return { status: 0, stdout: JSON.stringify({}), stderr: "" }; // no details.installed_count
        if (cmd === "package" && pmArgs[1] === "doctor") {
          // No details.summary at all (-> {} and ?? 0 counts), no triage.warning_codes (-> []).
          return { status: 0, stdout: JSON.stringify({ details: {} }), stderr: "" };
        }
        if (cmd === "contracts") {
          // action_availability not an array -> [] fallback.
          return { status: 0, stdout: JSON.stringify({ action_availability: "nope" }), stderr: "" };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke-defaults"),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--package", "pm-minimal"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      results: Array<{
        ok: boolean;
        installed_count: number | null;
        activation_failure_count: number;
        blocking_failure_count: number;
        warning_codes: string[];
        available_runtime_actions: string[];
      }>;
    };
    const result = payload.results[0];
    expect(result.ok).toBe(true);
    expect(result.installed_count).toBeNull();
    expect(result.activation_failure_count).toBe(0);
    expect(result.blocking_failure_count).toBe(0);
    expect(result.warning_codes).toEqual([]);
    expect(result.available_runtime_actions).toEqual([]);
  });

  it("ignores search keywords that are neither an array nor a string", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "search") {
        return {
          status: 0,
          stdout: JSON.stringify([
            // keywords as an object -> neither array nor string -> [] -> matched only via name marker.
            { name: "pm-package-objkw", description: "pm package", keywords: { not: "iterable" } },
            // keywords numeric, no marker anywhere -> filtered out.
            { name: "unrelated-tool", description: "nothing", keywords: 42 },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScript(["--discover-only"]);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as { packages: string[] };
    expect(payload.packages).toEqual(["pm-package-objkw"]);
  });

  it("warns with String(cleanupError) when temp cleanup throws a non-Error", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (isCli(command, args)) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        if (pmArgs[0] === "init") return { status: 1, stdout: "", stderr: "init refused" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-external-package-smoke-rawcleanup"),
      rmSync: vi.fn(() => {
        throw "raw-cleanup-string";
      }),
      writeFileSync: vi.fn(),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--package", "pm-cleanup-raw"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("raw-cleanup-string"))).toBe(true);
  });

  it("reports String(error) in the top-level catch when a non-Error escapes main", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (isCli(command, args) && args[1] === "--version") {
        // assertCliBuilt's runCommand -> spawnSync throws a non-Error that escapes to top-level.
        throw "raw-top-level-string";
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runScript(["--discover-only"]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]) === "raw-top-level-string")).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
