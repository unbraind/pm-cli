import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveAutomaticReadSampleRate } from "../../../../src/core/telemetry/read-sampling.js";
import { withTempDir } from "../../../helpers/temp.js";

it("retains ordinary reads and bounds expected repeated-read volume with finite installation state", async () => {
  await withTempDir("pm-auto-sampling-", async (root) => {
    let expectedPairs = 0;
    for (let index = 1; index <= 100; index += 1) {
      const rate = await resolveAutomaticReadSampleRate(root, "list", true, {}, 60_000);
      expect(rate).toBe(Math.min(1, (10 / index) ** 2));
      expectedPairs += rate;
    }
    expect(expectedPairs).toBeLessThan(20);
    expect(await resolveAutomaticReadSampleRate(root, "get", true, {}, 60_000)).toBe(1);
    expect(await resolveAutomaticReadSampleRate(root, "list", true, {}, 120_000)).toBe(1);
    const state = await readFile(path.join(root, "runtime", "telemetry", "read-sampling.json"), "utf8");
    expect(state.length).toBeLessThan(1024);
    expect(state).not.toContain(root);
  });
});

it("retains writes and unknown ownership without touching sampling state and honors explicit controls", async () => {
  await withTempDir("pm-auto-policy-", async (root) => {
    for (const [command, owned] of [["create", true], ["custom", true], ["list", false]] as const) {
      expect(await resolveAutomaticReadSampleRate(root, command, owned, {}, 0)).toBe(1);
    }
    for (const raw of ["1", "invalid", "", "0.25"]) {
      expect(await resolveAutomaticReadSampleRate(root, "list", true, { PM_TELEMETRY_READ_SAMPLE_RATE: raw }, 0)).toBe(raw === "0.25" ? 0.25 : 1);
    }
    await expect(readFile(path.join(root, "runtime", "telemetry", "read-sampling.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each(["broken", "0", "null", "[]", '{"minute":1}', '{"minute":1,"counts":null}', '{"minute":1,"counts":"wrong"}', '{"minute":1,"counts":{"list":-1}}', '{"minute":1,"counts":{"list":1.5,"custom":10,"get":"bad"}}'])("recovers malformed sampling state without dropping telemetry: %s", async (raw) => {
  await withTempDir("pm-auto-corrupt-", async (root) => {
    const directory = path.join(root, "runtime", "telemetry");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "read-sampling.json"), raw);
    expect(await resolveAutomaticReadSampleRate(root, "list", true, {}, 60_000)).toBe(1);
  });
});

it("retains the invocation when sampling state cannot be read", async () => {
  await withTempDir("pm-auto-unavailable-", async (root) => {
    await mkdir(path.join(root, "runtime", "telemetry", "read-sampling.json"), { recursive: true });
    expect(await resolveAutomaticReadSampleRate(root, "list", true, {}, 0)).toBe(1);
  });
});
