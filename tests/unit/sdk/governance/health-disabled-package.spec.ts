import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { runExtension } from "../../../../src/sdk/extension.js";
import { writeTestExtension } from "../../../helpers/extensions.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("disabled package version health", () => {
  it.each([
    { bound: "pm_min_version", version: "2099.1.1" },
    { bound: "pm_max_version", version: "1.0.0" },
    { bound: "pm_min_version", version: "not-a-version" },
    { bound: "pm_max_version", version: "not-a-version" },
  ])("keeps $bound incompatibility advisory only while the package is disabled", async ({ bound, version }) => {
    await withTempPmPath(async (context) => {
      const source = path.join(context.tempRoot, "future-package");
      await writeTestExtension({ root: source, name: "future-package", manifestOverrides: { [bound]: version } });
      expect((await runExtension(source, { install: true, project: true }, { path: context.pmPath })).ok).toBe(false);
      const enabled = await runHealth({ path: context.pmPath }, { strictExit: true, checkOnly: true });
      expect(enabled.ok).toBe(false);
      expect(enabled.findings).toContainEqual(expect.objectContaining({ code: expect.stringContaining("extension_pm_"), severity: "gate_failing" }));
      await runExtension("future-package", { deactivate: true, project: true }, { path: context.pmPath });
      const disabled = await runHealth({ path: context.pmPath }, { strictExit: true, checkOnly: true, full: true });
      expect(disabled.ok).toBe(true);
      expect(disabled.findings).toContainEqual(expect.objectContaining({ code: expect.stringContaining("extension_disabled_pm_"), severity: "advisory", remediation: expect.stringContaining("pm package activate future-package --project") }));
      expect(disabled.failed_because).toEqual([]);
      expect(enabled.findings).toContainEqual(expect.objectContaining({ severity: "gate_failing", remediation: expect.stringContaining("future-package") }));
      const strictCli = context.runCli(["health", "--strict-exit", "--check-only", "--json"], { expectJson: true });
      expect(strictCli.code).toBe(0);
      expect(strictCli.json).toMatchObject({ ok: true });
    });
  });
});
