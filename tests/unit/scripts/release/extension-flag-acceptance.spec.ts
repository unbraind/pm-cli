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
  vi.doMock("../../../fixtures/extensions/flag-semantics.mjs", () => ({ runExtensionFlagConsumer: consumer }));
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
  expect(preservation).toContain('echo "EXTENSION_FLAG_ACCEPTANCE=${RELEASE_CONTROLS}/extension-flag-acceptance.mjs"');
  const retained = steps.findIndex((step) => step.name === "Retain exact-candidate extension acceptance");
  expect(retained).toBeGreaterThan(steps.findIndex((step) => step.name === "Publish to npm"));
  expect(steps[retained]!.with!.path).toBe("${{ runner.temp }}/extension-flag-acceptance.json");
});

it("requires executed cases, isolates inherited state and binds the exact candidate bytes", async () => {
  const module = await harness.importModule<typeof import("../../../../scripts/release/extension-flag-acceptance.mjs")>(script);
  const root = mkdtempSync(path.join(tmpdir(), "pm-flag-receipt-")); roots.push(root);
  const tarball = path.join(root, "candidate.tgz"); writeFileSync(tarball, "candidate");
  spawn.mockImplementation((command) => ({ status: 0, stdout: command === "tar" ? "" : JSON.stringify({ ok: true, case_count: 39 }), stderr: "" }));
  vi.stubEnv("PM_PATH", path.join(root, "must-not-touch"));
  vi.stubEnv("GIT_DIR", path.join(root, "decoy"));
  expect(module.verifyExtensionFlagTarball(tarball)).toMatchObject({ ok: true, case_count: 39, artifact_sha256: "dda18a0e21ae47c53b4309434cbc02ae8bf764fa83a6defbb719431242722aa7", evidence_scope: "packed-candidate" });
  const options = spawn.mock.calls[1]![2];
  expect(options.env.GIT_DIR).toBeUndefined();
  expect(options.env.PM_PATH).not.toContain("must-not-touch");
  expect(options.env).toMatchObject({ PM_TELEMETRY_DISABLED: "1", PM_TELEMETRY_OTEL_DISABLED: "1" });
  expect(existsSync(options.cwd)).toBe(false);
  for (const receipt of [{ ok: false, case_count: 1 }, { ok: true, case_count: 0 }]) {
    spawn.mockReturnValue({ status: 0, stdout: JSON.stringify(receipt), stderr: "" });
    expect(() => module.verifyInstalledExtensionFlags(root, "other-runtime")).toThrow(/Missing required/);
  }
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
  consumer.mockResolvedValue({ ok: true, case_count: 39 });
  expect(await module.main(["--consumer", "/installed"])).toMatchObject({ ok: true });
  const root = mkdtempSync(path.join(tmpdir(), "pm-flag-main-")); roots.push(root);
  const tarball = path.join(root, "candidate.tgz"); writeFileSync(tarball, "candidate");
  spawn.mockImplementation((command) => ({ status: 0, stdout: command === "tar" ? "" : JSON.stringify({ ok: true, case_count: 39 }), stderr: "" }));
  process.argv = [process.execPath, path.resolve(script), tarball];
  expect(await module.main()).toMatchObject({ ok: true });
  await module.runIfMain("");
  await module.runIfMain(path.resolve(script));
  expect(output).toHaveBeenCalled();
});
