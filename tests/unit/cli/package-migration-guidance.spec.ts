import { expect, it } from "vitest";
import { runUpgrade } from "../../../src/sdk/governance/upgrade.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

it("includes scheduling migration guidance in a real CLI upgrade plan without installing anything", async () => {
  await withTempPmPath(async (context) => {
    const planned = await runUpgrade(undefined, { cliOnly: true, dryRun: true }, { path: context.pmPath });
    expect(planned.cli).toMatchObject({ status: "planned", migration_guidance: [expect.stringContaining("pm package install calendar --project")] });
    expect(JSON.stringify(planned)).toContain("pm calendar remind");
    const packagesOnly = await runUpgrade(undefined, { packagesOnly: true, dryRun: true }, { path: context.pmPath });
    expect(packagesOnly.cli).not.toHaveProperty("migration_guidance");
    const customPackage = await runUpgrade(undefined, { cliOnly: true, dryRun: true, packageName: "example-cli" }, { path: context.pmPath });
    expect(customPackage.cli).not.toHaveProperty("migration_guidance");
  });
});
