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

    expect(full.command_summaries).toEqual(
      expect.arrayContaining(
        (summary.command_summaries ?? []).map((entry) =>
          expect.objectContaining(entry),
        ),
      ),
    );
    expect(full.command_summaries).toHaveLength(
      summary.command_summaries?.length ?? 0,
    );
    expect(summary.command_summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "plan create" }),
        expect.objectContaining({ command: "assurance run" }),
      ]),
    );
    expect(
      summary.command_summaries?.every(
        (entry) => entry.default_max_estimated_tokens_by_format === undefined,
      ),
    ).toBe(true);
    expect(
      full.command_summaries?.every(
        (entry) => entry.default_max_estimated_tokens_by_format !== undefined,
      ),
    ).toBe(true);
    expect(
      full.command_summaries?.every(
        (entry) => entry.intent_source !== undefined,
      ),
    ).toBe(true);
    expect(full.output_policy).toEqual(summary.output_policy);
    expect(full.commands.length).toBeGreaterThan(0);
    expect(full.schema).toBeDefined();
    expect(full.command_flags).toBeDefined();
    expect(full.runtime_schema).toBeDefined();
    expect(full.relationship_kind_contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonical: "blocked_by",
          aliases: ["depends_on"],
          inverse: "blocks",
          ordering: true,
        }),
        expect.objectContaining({
          canonical: "parent",
          aliases: ["child_of", "epic"],
          hierarchy: true,
        }),
      ]),
    );
  });

  it("publishes strict assurance lifetime and bounded integer metadata", async () => {
    const full = await runContracts({ full: true }, GLOBAL);
    const schema = JSON.stringify(full.schema);

    expect(schema).toContain(
      '"description":"Maximum number of newest assurance verdicts returned.","examples":[10,25]',
    );
    expect(schema).toContain('"required":["lifetime","retire_reason"]');
    expect(schema).toContain(
      '"retire_reason":{"type":"string","minLength":1}',
    );
  });
});
