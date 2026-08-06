import { describe, expect, it } from "vitest";
import { runContracts } from "../../../src/sdk/cli-contracts/runtime-contracts.js";

const GLOBAL = {
  json: true,
  quiet: true,
  noPager: true,
  noExtensions: true,
} as Parameters<typeof runContracts>[1];

describe("full contracts projection monotonicity", () => {
  it("keeps every compact command semantic in the full projection", async () => {
    const summary = await runContracts({ summary: true }, GLOBAL);
    const full = await runContracts({ full: true }, GLOBAL);

    expect(full.command_summaries).toEqual(summary.command_summaries);
    expect(full.output_policy).toEqual(summary.output_policy);
    expect(full.commands.length).toBeGreaterThan(0);
    expect(full.schema).toBeDefined();
    expect(full.command_flags).toBeDefined();
    expect(full.runtime_schema).toBeDefined();
  });
});
