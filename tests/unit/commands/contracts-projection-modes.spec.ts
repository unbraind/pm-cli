import { describe, expect, it } from "vitest";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";
import { runContracts } from "../../../src/cli/commands/contracts.js";
import { readOutputIncludeModeOptions } from "../../../src/sdk/read-output-contracts.js";

const GLOBAL_OPTIONS: GlobalOptions = {
  json: true,
  quiet: false,
  noExtensions: false,
  profile: false,
};

describe("per-command projection mode contracts", () => {
  it("distinguishes the global union from exact command vocabularies", async () => {
    const result = await runContracts({ summary: true }, GLOBAL_OPTIONS);

    expect(result.output_policy?.degradation_ladder).toEqual([
      "full",
      "compact",
      "brief",
      "summary",
      "counts",
    ]);
    expect(result.output_projection_contracts).toMatchObject({
      global_ladder_field: "output_policy.degradation_ladder",
      global_ladder_scope: "union_not_per_command",
      discovery: "pm contracts --command <command> --summary",
    });
    expect(result.output_projection_contracts?.commands).toBeUndefined();
  });

  it("keeps command-scoped discovery exact before invocation", async () => {
    const list = await runContracts(
      { command: "list", summary: true },
      GLOBAL_OPTIONS,
    );
    const health = await runContracts(
      { command: "health", summary: true },
      GLOBAL_OPTIONS,
    );

    expect(list.output_projection_contracts?.commands).toEqual([
      { command: "list", modes: ["brief", "compact", "full"] },
    ]);
    expect(health.output_projection_contracts?.commands).toEqual([
      { command: "health", modes: ["brief", "full", "summary"] },
    ]);
    for (const declaration of [
      ...(list.output_projection_contracts?.commands ?? []),
      ...(health.output_projection_contracts?.commands ?? []),
    ]) {
      expect(declaration.modes).toEqual([
        ...readOutputIncludeModeOptions(declaration.command).keys(),
      ]);
    }
    expect(
      health.output_projection_contracts?.commands[0]?.modes,
    ).not.toContain("compact");
    expect(list.output_projection_contracts?.commands[0]?.modes).not.toContain(
      "summary",
    );
  });
});
