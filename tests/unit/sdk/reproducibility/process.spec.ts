import { describe, expect, it } from "vitest";
import { nextReproducibleToken } from "../../../../src/core/reproducibility/context.js";
import { nowIso } from "../../../../src/core/shared/time.js";
import {
  PM_REPRODUCIBLE_PROCESS_ENV,
  PmCliError,
  createReproducibleProcessRunner,
  resolveReproducibleProcessEnvironment,
  runWithReproducibleProcessEnvironment,
} from "../../../../src/sdk/index.js";

const VALID_ENVIRONMENT = {
  PM_CLOCK: "2026-08-22T10:00:00+02:00",
  PM_CLOCK_TICK_MS: "5",
  PM_SEED: "process-contract-seed",
} as const;

describe("reproducible process environment", () => {
  it("publishes stable names and stays inactive when every variable is absent", async () => {
    expect(PM_REPRODUCIBLE_PROCESS_ENV).toEqual({
      clock: "PM_CLOCK",
      tickMs: "PM_CLOCK_TICK_MS",
      seed: "PM_SEED",
    });
    expect(resolveReproducibleProcessEnvironment({})).toBeUndefined();
    await expect(
      runWithReproducibleProcessEnvironment({}, async () =>
        nextReproducibleToken(8),
      ),
    ).resolves.toBeUndefined();
  });

  it("normalizes settings and installs deterministic time and entropy", async () => {
    expect(resolveReproducibleProcessEnvironment(VALID_ENVIRONMENT)).toEqual({
      clock: "2026-08-22T08:00:00.000Z",
      tickMs: 5,
      seed: "process-contract-seed",
    });
    expect(
      resolveReproducibleProcessEnvironment({
        PM_CLOCK: "2026-08-22T08:00:00.000Z",
        PM_SEED: "default-tick",
      }),
    ).toMatchObject({ tickMs: 1 });

    const first = await runWithReproducibleProcessEnvironment(
      VALID_ENVIRONMENT,
      async () => ({
        timestamp: nowIso(),
        nextTimestamp: nowIso(),
        token: nextReproducibleToken(12),
      }),
    );
    const second = await runWithReproducibleProcessEnvironment(
      VALID_ENVIRONMENT,
      async () => ({
        timestamp: nowIso(),
        nextTimestamp: nowIso(),
        token: nextReproducibleToken(12),
      }),
    );
    expect(first).toEqual(second);
    expect(first.timestamp).toBe("2026-08-22T08:00:00.000Z");
    expect(first.nextTimestamp).toBe("2026-08-22T08:00:00.005Z");
  });

  it("lets a long-lived transport advance one sequence across serial operations", async () => {
    const run = createReproducibleProcessRunner(VALID_ENVIRONMENT);
    const first = await run(async () => ({
      timestamp: nowIso(),
      token: nextReproducibleToken(12),
    }));
    const second = await run(async () => ({
      timestamp: nowIso(),
      token: nextReproducibleToken(12),
    }));
    expect(second.timestamp).toBe("2026-08-22T08:00:00.005Z");
    expect(second.token).not.toBe(first.token);
  });

  it.each([
    [{ PM_CLOCK: VALID_ENVIRONMENT.PM_CLOCK }, "incomplete", "PM_SEED"],
    [{ PM_SEED: VALID_ENVIRONMENT.PM_SEED }, "incomplete", "PM_CLOCK"],
    [
      { PM_CLOCK_TICK_MS: "1" },
      "incomplete",
      "PM_CLOCK",
    ],
    [
      { ...VALID_ENVIRONMENT, PM_SEED: "   " },
      "invalid_value",
      "PM_SEED",
    ],
    [
      { ...VALID_ENVIRONMENT, PM_CLOCK: "not-a-clock" },
      "invalid_value",
      "PM_CLOCK",
    ],
    [
      { ...VALID_ENVIRONMENT, PM_CLOCK_TICK_MS: "" },
      "invalid_value",
      "PM_CLOCK_TICK_MS",
    ],
    [
      { ...VALID_ENVIRONMENT, PM_CLOCK_TICK_MS: "1.5" },
      "invalid_value",
      "PM_CLOCK_TICK_MS",
    ],
    [
      { ...VALID_ENVIRONMENT, PM_CLOCK_TICK_MS: "-1" },
      "invalid_value",
      "PM_CLOCK_TICK_MS",
    ],
  ] as const)(
    "returns typed recovery for invalid environment %#",
    (environment, reason, field) => {
      let thrown: unknown;
      try {
        resolveReproducibleProcessEnvironment(environment);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PmCliError);
      expect(thrown).toMatchObject({
        code: "invalid_reproducible_process_environment",
        exitCode: 2,
        context: {
          code: "invalid_reproducible_process_environment",
          reason,
          field,
          nextSteps: expect.arrayContaining([expect.stringContaining("Unset")]),
          recovery: { recovery_mode: "compact" },
        },
      });
    },
  );
});
