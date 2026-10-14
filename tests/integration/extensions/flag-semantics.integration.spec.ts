import { expect, it } from "vitest";
import { getContracts, PmClient } from "../../../src/sdk/runtime.js";
import { verifyCliFlagInvocationParity } from "../../../src/sdk/flag-invocation-contracts.js";
import { verifyExtensionFlagFixture, verifySdkExtensionFlagFixture, writeExtensionFlagFixture } from "../../fixtures/extensions/flag-semantics.mjs";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

it("preserves extension value grammar through help, SDK contracts and exact handler inputs", async () => {
  await withTempPmPath(async (context) => {
    writeExtensionFlagFixture(context.pmPath);
    const surfaces = [];
    for (const command of ["semantic probe", "semantic-probe"]) {
      surfaces.push(await getContracts({ pmRoot: context.pmPath, command, full: true, flagsOnly: true }));
    }
    const contracts = { command_flags: surfaces.flatMap((surface) => surface.command_flags ?? []) };
    const report = verifyExtensionFlagFixture(context.runCli, contracts, verifyCliFlagInvocationParity);
    expect(report).toMatchObject({ ok: true, case_count: 37 });
    await verifySdkExtensionFlagFixture(new PmClient({ pmRoot: context.pmPath }));
    const lostArity = structuredClone(contracts);
    const optional = lostArity.command_flags[0]!.flag_invocations!.find((row) => row.flag === "--maybe")!;
    optional.value_required = true;
    expect(() => verifyExtensionFlagFixture(context.runCli, lostArity, verifyCliFlagInvocationParity)).toThrow(/value_required_mismatch/);
    expect(() => verifyExtensionFlagFixture((args: string[]) => {
      if (args.includes("--enabled") && args.includes("false")) return {
        status: 0, stdout: JSON.stringify({ options: { enabled: true, truth: true }, args: ["false"] }), stderr: "",
      };
      return context.runCli(args);
    }, contracts, verifyCliFlagInvocationParity)).toThrow(/bool-spaced-false/);
  });
}, 120_000);
