import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { writeTestExtension } from "../../helpers/extensions.js";
import {
  _testOnlyContractsCommand,
  runContracts,
} from "../../../src/sdk/cli-contracts/runtime-contracts.js";

const GLOBAL = {
  json: true,
  quiet: true,
  noPager: true,
  noExtensions: true,
} as Parameters<typeof runContracts>[1];

describe("full contracts projection monotonicity", () => {
  it.each(["search advanced", "search-advanced"])("shares installed %s flags between canonical and compatibility paths", async (registeredCommand) => {
    await withTempPmPath(async (context) => {
      await writeTestExtension({
        root: context.pmPath,
        placement: "projectRoot",
        directory: "search-facet-contract",
        manifestOverrides: { capabilities: ["commands", "schema"] },
        entryFilename: "index.mjs",
        entrySource: `export default { activate(api) {
          api.registerCommand({ name: ${JSON.stringify(registeredCommand)}, action: 'search-advanced',
            flags: [{ long: '--facet-probe', value_name: 'value', value_type: 'string' }],
            run: () => ({ ok: true }) });
        } };`,
      });
      const result = await runContracts({ full: true, flagsOnly: true }, { ...GLOBAL, path: context.pmPath, noExtensions: false });
      for (const command of ["search advanced", "search-advanced"]) {
        expect(result.command_flags?.find((entry) => entry.command === command)?.flags.some((flag) => flag.flag === "--facet-probe"), command).toBe(true);
      }
    });
  });
  it("identifies native and legacy history flags with one canonical command", async () => {
    const native = await runContracts({ command: "history repair", flagsOnly: true }, GLOBAL);
    const legacy = await runContracts({ command: "history-repair", flagsOnly: true }, GLOBAL);
    expect(native.command_flags?.[0]?.canonical_command).toBe("history repair");
    expect(legacy.command_flags?.[0]?.canonical_command).toBe("history repair");
    expect(native.command_flags?.[0]?.flags).toEqual(legacy.command_flags?.[0]?.flags);
    expect(native.command_flags?.[0]?.positionals).toEqual(legacy.command_flags?.[0]?.positionals);
  });

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
    const compactCommands = new Set(summary.command_summaries?.map((entry) => entry.command));
    expect(full.command_summaries?.filter((entry) => !compactCommands.has(entry.command)).map((entry) => entry.command)).toEqual([
      "activity", "append", "close-many", "comments", "copy", "ctx", "delete", "deps", "docs", "duplicates", "eval", "events", "files", "focus", "gc", "health", "history-attest", "history-compact", "history-redact", "history-repair", "item test worker", "learnings", "merge", "next", "notes", "packages", "restore", "stats", "telemetry", "test", "test-all", "test-runs-worker", "update-many", "validate",
    ]);
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
    expect(schema).toContain('"retire_reason":{"type":"string","minLength":1}');
  });

  it("controls summary format budgets and intent provenance independently", () => {
    const formatOnly = _testOnlyContractsCommand.buildCommandSummarySurface(
      ["contracts"],
      [],
      { includeFormatBudgets: true, includeIntentProvenance: false },
    )[0]!;
    expect(formatOnly.default_max_estimated_tokens_by_format).toBeDefined();
    expect(formatOnly.intent_source).toBeUndefined();

    const provenanceOnly = _testOnlyContractsCommand.buildCommandSummarySurface(
      ["contracts"],
      [],
      { includeFormatBudgets: false, includeIntentProvenance: true },
    )[0]!;
    expect(
      provenanceOnly.default_max_estimated_tokens_by_format,
    ).toBeUndefined();
    expect(provenanceOnly.intent_source).toBe("command");
  });
});
