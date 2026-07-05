import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();

interface GatePayload {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; skipped?: boolean }>;
}

describe("scripts/release/run-gates", () => {
  it("prints usage and runs nothing for --help", async () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    vi.doMock("node:child_process", () => ({ spawnSync }));
    process.argv = ["node", "scripts/release/run-gates.mjs", "--help"];
    const helpLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await harness.importModule("scripts/release/run-gates.mjs", "runGatesHelp");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(String(helpLog.mock.calls.at(-1)?.[0] ?? "")).toContain("--skip-compatibility");
  });

  it("marks dogfood/compatibility/sentry checks skipped and emits a JSON summary", async () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    vi.doMock("node:child_process", () => ({ spawnSync }));
    process.argv = [
      "node",
      "scripts/release/run-gates.mjs",
      "--json",
      "--skip-dogfood",
      "--skip-compatibility",
      "--skip-greptile",
      "--skip-telemetry-sentry",
      "--telemetry-mode",
      "required",
    ];
    const jsonWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await harness.importModule("scripts/release/run-gates.mjs", "runGatesSkips");
    const payload = JSON.parse(String(jsonWriteSpy.mock.calls.at(-1)?.[0] ?? "{}")) as GatePayload;
    expect(payload.ok).toBe(true);
    expect(payload.checks.some((entry) => entry.name === "package-first-dogfood" && entry.skipped === true)).toBe(true);
    expect(payload.checks.some((entry) => entry.name === "compatibility-check" && entry.skipped === true)).toBe(true);
    expect(payload.checks.some((entry) => entry.name === "greptile-review" && entry.skipped === true)).toBe(true);
    expect(payload.checks.some((entry) => entry.name === "sentry-telemetry-gate" && entry.skipped === true)).toBe(true);
    expect(spawnSync).toHaveBeenCalled();
  });

  it("runs every gate including dogfood + sentry and prints the success line", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 0, stdout: '{"compatibility":"ok"}', stderr: "" };
      }
      if (joined.includes("sentry-telemetry-gate.mjs")) {
        return { status: 0, stdout: '{"ok":true,"mode":"best-effort"}', stderr: "" };
      }
      if (joined.includes("greptile-review-gate.mjs")) {
        return { status: 0, stdout: '{"ok":true,"skipped":false,"findings":0}', stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "scripts/release/run-gates.mjs"];
    await harness.importModule("scripts/release/run-gates.mjs", "runGatesFull");
    expect(
      spawnSync.mock.calls.some((c) => [c[0], ...(c[1] as string[])].join(" ").includes("dogfood:package-first")),
    ).toBe(true);
    expect(
      spawnSync.mock.calls.some((c) => [c[0], ...(c[1] as string[])].join(" ").includes("sentry-telemetry-gate.mjs")),
    ).toBe(true);
    expect(
      spawnSync.mock.calls.some((c) => [c[0], ...(c[1] as string[])].join(" ").includes("greptile-review-gate.mjs")),
    ).toBe(true);
    expect(spawnSync.mock.calls.some((c) => [c[0], ...(c[1] as string[])].join(" ").includes("quality:static"))).toBe(
      true,
    );
    expect(
      spawnSync.mock.calls.some((c) => {
        const args = (c[1] as string[] | undefined) ?? [];
        const joined = [c[0], ...args].join(" ");
        return joined.includes("static-quality-gate.mjs") && !joined.includes("quality:static");
      }),
    ).toBe(false);
    expect(
      spawnSync.mock.calls.some(([, args]) => {
        const commandArgs = args as string[];
        const scriptIndex = commandArgs.indexOf("scripts/release/sentry-telemetry-gate.mjs");
        const telemetryModeIndex = commandArgs.indexOf("--telemetry-mode");
        const windowDaysIndex = commandArgs.indexOf("--sentry-window-days");
        return (
          scriptIndex >= 0 &&
          commandArgs.includes("--json") &&
          telemetryModeIndex >= 0 &&
          commandArgs[telemetryModeIndex + 1] === "best-effort" &&
          windowDaysIndex >= 0 &&
          commandArgs[windowDaysIndex + 1] === "14"
        );
      }),
    ).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Release gates passed."))).toBe(true);
    logSpy.mockRestore();
  });

  it("fails a captured gate and includes stdout + stderr detail in the message", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 9, stdout: "  compat out  ", stderr: "  compat err  " };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs", "--skip-dogfood", "--skip-telemetry-sentry"];
    await expect(harness.importModule("scripts/release/run-gates.mjs", "runGatesFailDetail")).rejects.toThrow("EXIT:9");
    const msg = String(errorSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(msg).toContain("Gate failed: compatibility-check");
    expect(msg).toContain("stdout:");
    expect(msg).toContain("compat out");
    expect(msg).toContain("stderr:");
    expect(msg).toContain("compat err");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails a gate with no stdout/stderr detail (empty suffix branch)", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("build")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs"];
    await expect(harness.importModule("scripts/release/run-gates.mjs", "runGatesFailNoDetail")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toBe("Gate failed: build");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails a captured gate with only stdout (stderr-empty branch)", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 3, stdout: "only out", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs", "--skip-dogfood", "--skip-telemetry-sentry"];
    await expect(harness.importModule("scripts/release/run-gates.mjs", "runGatesFailStdoutOnly")).rejects.toThrow(
      "EXIT:3",
    );
    const msg = String(errorSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(msg).toContain("stdout:");
    expect(msg).toContain("only out");
    expect(msg).not.toContain("stderr:");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails when a captured gate emits invalid JSON", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 0, stdout: "not-json", stderr: "" };
      }
      if (joined.includes("sentry-telemetry-gate.mjs")) {
        return { status: 0, stdout: '{"ok":true}', stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = harness.mockProcessExit();
    process.argv = ["node", "scripts/release/run-gates.mjs", "--json", "--skip-dogfood", "--skip-telemetry-sentry"];
    await expect(harness.importModule("scripts/release/run-gates.mjs", "runGatesParseFail")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Failed to parse JSON for compatibility-check");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
