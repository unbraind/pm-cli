import { afterEach, describe, expect, it } from "vitest";
import { resolveCommanderUsageContext } from "../../../src/cli/commander-usage.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";
import { isCompatibleRecoveryFlag } from "../../../src/sdk/agent/command-recovery.js";

const ORIGINAL_ARGV = [...process.argv];

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
});

async function resolveScope(
  flag: string,
): Promise<Awaited<ReturnType<typeof resolveCommanderUsageContext>>> {
  process.argv = ["node", "pm", "list-open", flag];
  return resolveCommanderUsageContext(
    { message: `unknown option '${flag}'` },
    createPmCliProgram("test"),
    new Map(),
  );
}

describe("unknown-option lexicon scope contract", () => {
  it("preserves purpose for shared SDK recovery candidates in both directions", () => {
    expect(isCompatibleRecoveryFlag("--full", "--full-changed-fields")).toBe(false);
    expect(isCompatibleRecoveryFlag("--id-only", "--output-include")).toBe(false);
    expect(isCompatibleRecoveryFlag("--full", "--fields")).toBe(true);
    expect(isCompatibleRecoveryFlag("--id-only", "--full-changed-fields")).toBe(true);
    expect(isCompatibleRecoveryFlag("--tilte", "--title")).toBe(true);
    expect(isCompatibleRecoveryFlag("--ful", "--full-changed-fields")).toBe(false);
    expect(isCompatibleRecoveryFlag("--full-chang", "--full-changed-fields")).toBe(true);
    expect(isCompatibleRecoveryFlag("--x", "--title")).toBe(true);
  });
  it.each(["--full", "--ful"])("keeps unsupported read projection %s separate from mutation receipt controls", async (flag) => {
    process.argv = ["node", "pm", "telemetry", "status", flag, "--json"];
    const context = await resolveCommanderUsageContext(
      { message: `unknown option '${flag}'` },
      createPmCliProgram("test"),
      new Map(),
    );
    expect(context.unknownOptionScope).toBe(flag === "--full" ? "declared_elsewhere" : "declared_nowhere");
    expect(context.unknownOptionSuggestions ?? []).not.toContain("--full-changed-fields");
    expect(context.suggestedRetryCommand).toBeUndefined();
  });
  it("derives all three scope classes from the declared flag lexicon", async () => {
    const onPath = await resolveScope("--limit");
    expect(onPath.unknownOptionScope).toBe("declared_on_path");

    const elsewhere = await resolveScope("--command");
    expect(elsewhere.unknownOptionScope).toBe("declared_elsewhere");
    expect(elsewhere.unknownOptionOtherCommands).toContain("contracts");

    const nowhere = await resolveScope("--definitely-not-declared");
    expect(nowhere.unknownOptionScope).toBe("declared_nowhere");
    expect(nowhere.unknownOptionOtherCommands).toBeUndefined();
  });

  it("fails the negative control when a known flag is treated as undeclared", async () => {
    const known = await resolveScope("--command");
    expect(known.unknownOptionScope).not.toBe("declared_nowhere");
    expect(known.unknownOptionOtherCommandsTotal).toBeGreaterThan(0);
  });
});
