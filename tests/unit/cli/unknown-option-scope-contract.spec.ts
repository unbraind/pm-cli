import { afterEach, describe, expect, it } from "vitest";
import { resolveCommanderUsageContext } from "../../../src/cli/commander-usage.js";
import { createPmCliProgram } from "../../../src/sdk/cli-program.js";

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
