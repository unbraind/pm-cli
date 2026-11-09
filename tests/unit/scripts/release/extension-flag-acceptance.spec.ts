import { runInNewContext } from "node:vm";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule.js";
import { parse } from "yaml";

const spawn = vi.hoisted(() => vi.fn());
const consumer = vi.hoisted(() => vi.fn());
beforeEach(() => {
  vi.doMock("node:child_process", () => ({ spawnSync: spawn }));
  vi.doMock("../../../fixtures/extensions/flag-semantics.mjs", () => ({ runExtensionFlagConsumer: consumer, EXTENSION_FLAG_REQUIRED_CASE_IDS: ["echo"] }));
  vi.doMock("../../../fixtures/telemetry/diagnostic-privacy.mjs", () => ({ DIAGNOSTIC_PRIVACY_REQUIRED_CASE_IDS: ["echo"] }));
});
const harness = createScriptHarness();
const script = "scripts/release/extension-flag-acceptance.mjs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); spawn.mockReset(); consumer.mockReset(); });

it("keeps exact-artifact acceptance before publication and preserves the reviewed import graph", () => {
  const workflow = parse(readFileSync(path.resolve(".github/workflows/release.yml"), "utf8"));
  const steps = workflow.jobs.release.steps as Array<{ name: string; run?: string; uses?: string; with?: Record<string, unknown> }>;
  const publish = steps.find((step) => step.name === "Publish to npm")!.run!;
  const acceptance = publish.indexOf('node "${EXTENSION_FLAG_ACCEPTANCE}" "${RUNNER_TEMP}/${publication_tarball}"');
  expect(acceptance).toBeGreaterThan(0);
  expect(acceptance).toBeLessThan(publish.indexOf('npm publish "${RUNNER_TEMP}/${publication_tarball}"'));
  const preservation = steps.find((step) => step.name === "Preserve reviewed package artifact controls")!.run!;
  expect(preservation).toContain('cp scripts/release/extension-flag-acceptance.mjs');
  expect(preservation).toContain('cp tests/fixtures/extensions/flag-semantics.mjs');
  expect(preservation).toContain('cp tests/fixtures/telemetry/diagnostic-privacy.mjs');
  expect(preservation).toContain('echo "EXTENSION_FLAG_ACCEPTANCE=${RELEASE_CONTROLS}/extension-flag-acceptance.mjs"');
  const retained = steps.findIndex((step) => step.name === "Retain exact-candidate extension acceptance");
  expect(retained).toBeGreaterThan(steps.findIndex((step) => step.name === "Publish to npm"));
  expect(steps[retained]!.with!.path).toBe("${{ runner.temp }}/extension-flag-acceptance.json");
});

it("keeps pinned uncached Bun acceptance while selecting the official macOS asset transport (GH-1694)", () => {
  const workflow = parse(readFileSync(path.resolve(".github/workflows/release.yml"), "utf8"));
  const setup = workflow.jobs["installed-acceptance"].steps.find((step: { name: string }) => step.name === "Setup Bun");
  expect(setup.with["bun-version"]).toBe("1.4.0");
  expect(setup.with["no-cache"]).toBe(true);
  expect(setup.with["bun-download-url"]).toBe("${{ runner.os == 'macOS' && format('https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-{0}.zip?download=1', runner.arch == 'ARM64' && 'aarch64' || 'x64') || '' }}");
  expect(setup["continue-on-error"]).toBeUndefined();
  expect(workflow.jobs.release.needs).toContain("prepublication-bun");
  const preflight = workflow.jobs["prepublication-bun"];
  expect(preflight.strategy.matrix.os).toEqual(["macos-latest", "windows-latest"]);
  expect(preflight["continue-on-error"]).toBeUndefined();
  const nativeSetup = preflight.steps.find((step: { name: string }) => step.name === "Setup Bun");
  expect(nativeSetup.uses).toBe(setup.uses);
  expect(nativeSetup.with).toEqual(setup.with);
  expect(nativeSetup["continue-on-error"]).toBeUndefined();
  const nativeVersion = preflight.steps.find((step: { name: string }) => step.name === "Verify pinned Bun runtime");
  expect(nativeVersion.run).toContain('execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()');
  expect(nativeVersion.run).toContain('version !== "1.4.0"');
  expect(nativeVersion["continue-on-error"]).toBeUndefined();
  expect(nativeVersion.if).toBeUndefined();
  expect(workflow.jobs.release.if).toBeUndefined();
  const versionScript = nativeVersion.run.trim().match(/^node -e '([\s\S]+)'$/u)![1];
  const executeVersionCheck = (version: string) => runInNewContext(versionScript, {
    require: (specifier: string) => {
      expect(specifier).toBe("node:child_process");
      return { execFileSync: (command: string, args: string[], options: { encoding: string }) => {
        expect([command, args, options]).toEqual(["bun", ["--version"], { encoding: "utf8" }]);
        return version;
      } };
    },
    console: { log: vi.fn() },
  }, { timeout: 1_000 });
  expect(() => executeVersionCheck("1.4.0\r\n")).not.toThrow();
  expect(() => executeVersionCheck("1.4.1\n")).toThrow("Expected Bun 1.4.0 before publication");
  const ci = parse(readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8"));
  const prepublication = ci.jobs["build-test"].steps.find((step: { name: string }) => step.name === "Verify pinned macOS Bun download");
  expect(prepublication).toMatchObject({ if: "matrix.os == 'macos-latest'", uses: setup.uses, with: { "bun-version": "1.4.0", "no-cache": true } });
  expect(prepublication.with["bun-download-url"]).toBe("${{ format('https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-darwin-{0}.zip?download=1', runner.arch == 'ARM64' && 'aarch64' || 'x64') }}");
  expect(prepublication["continue-on-error"]).toBeUndefined();
  expect(ci.jobs["build-test"].steps.find((step: { name: string }) => step.name === "Verify pinned macOS Bun runtime")).toMatchObject({ if: "matrix.os == 'macos-latest'", run: 'test "$(bun --version)" = "1.4.0"' });
});

it("requires executed cases, isolates inherited state and binds the exact candidate bytes", async () => {
  const module = await harness.importModule<typeof import("../../../../scripts/release/extension-flag-acceptance.mjs")>(script);
  const root = mkdtempSync(path.join(tmpdir(), "pm-flag-receipt-")); roots.push(root);
  const tarball = path.join(root, "candidate.tgz"); writeFileSync(tarball, "candidate");
  spawn.mockImplementation((command) => ({ status: 0, stdout: command === "tar" ? "" : JSON.stringify({ ok: true, case_count: 1, executed_cases: ["echo"] }), stderr: "" }));
  vi.stubEnv("PM_PATH", path.join(root, "must-not-touch"));
  vi.stubEnv("GIT_DIR", path.join(root, "decoy"));
  expect(module.verifyExtensionFlagTarball(tarball)).toMatchObject({ ok: true, case_count: 1, executed_cases: ["echo"], artifact_sha256: "dda18a0e21ae47c53b4309434cbc02ae8bf764fa83a6defbb719431242722aa7", evidence_scope: "packed-candidate" });
  const options = spawn.mock.calls[1]![2];
  expect(options.env.GIT_DIR).toBeUndefined();
  expect(options.env.PM_PATH).not.toContain("must-not-touch");
  expect(options.env).toMatchObject({ PM_TELEMETRY_DISABLED: "1", PM_TELEMETRY_OTEL_DISABLED: "1" });
  expect(existsSync(options.cwd)).toBe(false);
  for (const receipt of [{ ok: false, case_count: 1 }, { ok: true, case_count: 0, executed_cases: [] }, { ok: true, case_count: 1 }, { ok: true, case_count: 1, executed_cases: ["unknown"] }, { ok: true, case_count: 1, executed_cases: ["echo", "echo"] }]) {
    spawn.mockReturnValue({ status: 0, stdout: JSON.stringify(receipt), stderr: "" });
    expect(() => module.verifyInstalledExtensionFlags(root, "other-runtime")).toThrow();
  }
  for (const receipt of [{ ok: false, case_count: 1 }, { ok: true, case_count: 0, executed_cases: [] }, { ok: true, case_count: 1 }, { ok: true, case_count: 1, executed_cases: ["unknown"] }]) {
    spawn.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ ok: true, case_count: 1, executed_cases: ["echo"] }), stderr: "" });
    spawn.mockReturnValueOnce({ status: 0, stdout: JSON.stringify(receipt), stderr: "" });
    expect(() => module.verifyInstalledExtensionFlags(root)).toThrow();
  }
  spawn.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ ok: true, case_count: 1, executed_cases: ["echo"] }), stderr: "" });
  spawn.mockReturnValueOnce({ status: 1, stdout: "", stderr: "privacy failed" });
  expect(() => module.verifyInstalledExtensionFlags(root)).toThrow(/privacy failed/);
  spawn.mockReturnValue({ status: 1, stdout: "", stderr: "unpack failed" });
  expect(() => module.verifyExtensionFlagTarball(tarball)).toThrow(/unpack failed/);
  expect(() => module.verifyInstalledExtensionFlags(root)).toThrow(/unpack failed/);
});

it("distinguishes launch and signal failures from product assertions", async () => {
  const module = await harness.importModule<typeof import("../../../../scripts/release/extension-flag-acceptance.mjs")>(script);
  spawn.mockReturnValue({ error: new Error("spawn unavailable") });
  expect(() => module.execute("missing", [], undefined)).toThrow("spawn unavailable");
  spawn.mockReturnValue({ signal: "SIGTERM" });
  expect(() => module.execute("terminated", [], {})).toThrow("terminated: SIGTERM");
});

it("dispatches both required modes and guards executable entry", async () => {
  const module = await harness.importModule<typeof import("../../../../scripts/release/extension-flag-acceptance.mjs")>(script);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  consumer.mockResolvedValue({ ok: true, case_count: 1, executed_cases: ["echo"] });
  expect(await module.main(["--consumer", "/installed"])).toMatchObject({ ok: true });
  const root = mkdtempSync(path.join(tmpdir(), "pm-flag-main-")); roots.push(root);
  const tarball = path.join(root, "candidate.tgz"); writeFileSync(tarball, "candidate");
  spawn.mockImplementation((command) => ({ status: 0, stdout: command === "tar" ? "" : JSON.stringify({ ok: true, case_count: 1, executed_cases: ["echo"] }), stderr: "" }));
  process.argv = [process.execPath, path.resolve(script), tarball];
  expect(await module.main()).toMatchObject({ ok: true });
  await module.runIfMain("");
  await module.runIfMain(path.resolve(script));
  expect(output).toHaveBeenCalled();
});
