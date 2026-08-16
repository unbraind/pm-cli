import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  buildDefectRecurrenceIndex,
  parseDefectRecurrencePolicy,
} from "../../../src/sdk/governance/defect-recurrence.js";
import { main } from "../../../scripts/bench/defect-recurrence-index.mjs";

const recurrencePolicy = parseDefectRecurrencePolicy(
  JSON.parse(await readFile("config/defect-recurrence-policy.json", "utf8")),
);

describe("defect recurrence index benchmark", () => {
  it("runs the real index with default adapters and bounded test scale", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(main([], { defaultItemCount: 2 })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("2 items"));
    stdout.mockRestore();
  });

  it("emits deterministic JSON and enforces explicit thresholds", async () => {
    const stdout: string[] = [];
    const clock = [0, 10, 20, 25];
    const memory = [100, 200];
    await expect(
      main(["--items", "10", "--check", "--json"], {
        now: () => clock.shift()!,
        memoryUsage: () => memory.shift()!,
        thresholds: {
          full_duration_ms: 20,
          incremental_duration_ms: 10,
          heap_delta_bytes: 200,
        },
        writeStdout: (value: string) => stdout.push(value),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      item_count: 10,
      full_duration_ms: 10,
      incremental_duration_ms: 5,
      heap_delta_bytes: 100,
      deterministic: true,
    });

    const failedOutput: string[] = [];
    const slowClock = [0, 50, 60, 90];
    await expect(
      main(["--items", "2", "--check", "--json"], {
        now: () => slowClock.shift()!,
        memoryUsage: () => 100,
        thresholds: {
          full_duration_ms: 1,
          incremental_duration_ms: 1,
          heap_delta_bytes: 1,
        },
        writeStdout: (value: string) => failedOutput.push(value),
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(failedOutput.join(""))).toMatchObject({ ok: false });
  });

  it("rejects invalid scale and fails a nondeterministic index implementation", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(main(["--items", "0"])).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith("--items must be a positive integer\n");
    stderr.mockRestore();

    let calls = 0;
    const stdout: string[] = [];
    await expect(
      main(["--items", "1", "--json"], {
        buildIndex: (
          ...args: Parameters<typeof buildDefectRecurrenceIndex>
        ) => ({
          ...buildDefectRecurrenceIndex(...args),
          index_fingerprint: `call-${calls++}`,
        }),
        memoryUsage: () => 0,
        writeStdout: (value: string) => stdout.push(value),
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      deterministic: false,
    });

    const humanOutput: string[] = [];
    calls = 0;
    await expect(
      main(["--items", "1"], {
        buildIndex: (...args: Parameters<typeof buildDefectRecurrenceIndex>) => ({
          ...buildDefectRecurrenceIndex(...args),
          index_fingerprint: `human-call-${calls++}`,
        }),
        memoryUsage: () => 0,
        writeStdout: (value: string) => humanOutput.push(value),
      }),
    ).resolves.toBe(1);
    expect(humanOutput.join("")).toContain("FAIL");
  });

  it("clamps a negative measured heap delta to zero", async () => {
    const stdout: string[] = [];
    const memory = [200, 100];
    await expect(
      main(["--items", "1", "--json"], {
        policy: recurrencePolicy,
        memoryUsage: () => memory.shift()!,
        writeStdout: (value: string) => stdout.push(value),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ heap_delta_bytes: 0 });
  });
});
