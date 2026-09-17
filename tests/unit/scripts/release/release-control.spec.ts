import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness();
interface ControlModule { selectReleaseControl(candidate: string, versions: unknown): string }

it("prints the control from a real version inventory through the executable entrypoint", async () => {
  const root = await harness.createTempRoot("pm-release-control-");
  const file = path.join(root, "versions.json");
  await writeFile(file, JSON.stringify(["2026.9.15", "2026.9.16"]));
  process.argv = [process.execPath, path.resolve("scripts/release/release-control.mjs"), "2026.9.16", file];
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await harness.importModule<ControlModule>("scripts/release/release-control.mjs");
  expect(output).toHaveBeenCalledWith("2026.9.15");
});

it("allows imports without an executable argument", async () => {
  process.argv = [process.execPath];
  expect((await harness.importModule<ControlModule>("scripts/release/release-control.mjs")).selectReleaseControl).toBeTypeOf("function");
});

it("selects only the nearest older published calendar release", async () => {
  const { selectReleaseControl } = await harness.importModule<ControlModule>("scripts/release/release-control.mjs");
  const versions = ["2026.9.17", "2026.9.16-3", "2026.9.16", "2026.8.31", "2025.12.31", "2026.9.16-2", "2026.9.16-2", "latest", null];
  expect(selectReleaseControl("2026.9.17", versions)).toBe("2026.9.16-3");
  expect(selectReleaseControl("2026.9.16-2", versions)).toBe("2026.9.16");
  expect(selectReleaseControl("2026.9.16", versions)).toBe("2026.8.31");
  expect(() => selectReleaseControl("latest", versions)).toThrow("Invalid");
  expect(() => selectReleaseControl("2026.9.16", {})).toThrow("Invalid");
  expect(() => selectReleaseControl("2026.9.18", versions)).toThrow("absent");
  expect(() => selectReleaseControl("2025.12.31", versions)).toThrow("No previous");
});
