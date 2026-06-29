import { describe, expect, it, vi } from "vitest";

import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();

/** A spawnSync stub: whoami uses `onWhoami`, the review call uses `onReview`. */
function mockSpawn(onWhoami: () => unknown, onReview: (args: string[]) => unknown) {
  const spawnSync = vi.fn((_command: string, args: string[]) => (args[0] === "whoami" ? onWhoami() : onReview(args)));
  vi.doMock("node:child_process", () => ({ spawnSync }));
  return spawnSync;
}

async function runGate(args: string[], label: string): Promise<void> {
  process.argv = ["node", "scripts/release/greptile-review-gate.mjs", ...args];
  await harness.importModule("scripts/release/greptile-review-gate.mjs", label);
}

describe("scripts/release/greptile-review-gate", () => {
  it("prints usage for --help and spawns nothing", async () => {
    const spawnSync = mockSpawn(
      () => ({ status: 0, stdout: "", stderr: "" }),
      () => ({ status: 0, stdout: "", stderr: "" }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runGate(["--help"], "greptileHelp");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("greptile-review-gate.mjs");
  });

  it("skips (JSON) when the greptile CLI is not installed", async () => {
    mockSpawn(
      () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }),
      () => ({ status: 0, stdout: "", stderr: "" }),
    );
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runGate(["--json"], "greptileNotInstalled");
    const payload = JSON.parse(String(writeSpy.mock.calls.at(-1)?.[0] ?? "{}"));
    expect(payload).toMatchObject({ ok: true, skipped: true });
    expect(payload.reason).toContain("not installed");
    expect(process.exitCode).toBe(0);
  });

  it("skips (human) when the greptile CLI is not authenticated", async () => {
    // Omit stdout/stderr so runGreptile's `?? ""` normalization branches are hit.
    mockSpawn(
      () => ({ status: 1 }),
      () => ({ status: 0, stdout: "", stderr: "" }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runGate([], "greptileUnauthed");
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("not authenticated");
    expect(process.exitCode).toBe(0);
  });

  it("skips when the review times out", async () => {
    mockSpawn(
      () => ({ status: 0, stdout: "signed in", stderr: "" }),
      () => ({ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } }),
    );
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runGate(["--json", "--timeout-ms", "1000"], "greptileTimeout");
    const payload = JSON.parse(String(writeSpy.mock.calls.at(-1)?.[0] ?? "{}"));
    expect(payload).toMatchObject({ ok: true, skipped: true });
    expect(payload.reason).toContain("timed out");
  });

  it("skips when the review does not complete (null exit status)", async () => {
    // A null status with no error exercises the `status ?? "null"` reason branch.
    mockSpawn(
      () => ({ status: 0, stdout: "signed in", stderr: "" }),
      () => ({ status: null, stdout: "boom", stderr: "fatal" }),
    );
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runGate(["--json"], "greptileIncomplete");
    const payload = JSON.parse(String(writeSpy.mock.calls.at(-1)?.[0] ?? "{}"));
    expect(payload).toMatchObject({ ok: true, skipped: true });
    expect(payload.reason).toContain("did not complete");
    expect(payload.reason).toContain("null");
  });

  it("passes (JSON) on a clean review and forwards --base", async () => {
    const spawnSync = mockSpawn(
      () => ({ status: 0, stdout: "signed in", stderr: "" }),
      () => ({ status: 0, stdout: "Greptile Summary\nNo review comments.", stderr: "" }),
    );
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runGate(["--json", "--base", "main"], "greptileClean");
    const payload = JSON.parse(String(writeSpy.mock.calls.at(-1)?.[0] ?? "{}"));
    expect(payload).toMatchObject({ ok: true, skipped: false, findings: 0 });
    expect(process.exitCode).toBe(0);
    const reviewCall = spawnSync.mock.calls.find((call) => (call[1] as string[])[0] === "review");
    expect(reviewCall?.[1]).toEqual(["review", "--agent", "--base", "main"]);
  });

  it("passes (human) on a clean review without a base", async () => {
    mockSpawn(
      () => ({ status: 0, stdout: "signed in", stderr: "" }),
      () => ({ status: 0, stdout: "no review comments", stderr: "" }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runGate([], "greptileCleanHuman");
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("no findings");
    expect(process.exitCode).toBe(0);
  });

  it("fails (human) when the review reports findings", async () => {
    mockSpawn(
      () => ({ status: 0, stdout: "signed in", stderr: "" }),
      () => ({ status: 0, stdout: "src/x.ts:1 use const here", stderr: "" }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runGate([], "greptileFindings");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("review findings");
    expect(process.exitCode).toBe(1);
  });

  it("does not fail on findings under --report-only", async () => {
    mockSpawn(
      () => ({ status: 0, stdout: "signed in", stderr: "" }),
      () => ({ status: 0, stdout: "src/x.ts:1 use const here", stderr: "" }),
    );
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runGate(["--json", "--report-only"], "greptileReportOnly");
    const payload = JSON.parse(String(writeSpy.mock.calls.at(-1)?.[0] ?? "{}"));
    expect(payload.ok).toBe(false);
    expect(process.exitCode).toBe(0);
  });
});
