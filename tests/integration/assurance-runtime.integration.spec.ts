import { describe, expect, it } from "vitest";

import {
  PmClient,
  analyzeSdkActionCoverage,
  runAction,
} from "../../src/sdk/runtime.js";
import { runAssuranceAction } from "../../src/sdk/governance/assurance-action.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const measurement = {
  id: "open-items",
  source: { kind: "items" as const, statuses: ["open"] },
};

describe("assurance runtime parity", () => {
  it("routes PmClient, standalone SDK, and MCP dispatch through one action", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const client = new PmClient({ pmRoot: pmPath, author: "runtime-test" });
      await expect(
        client.assurance({
          action: "put",
          kind: "measurement",
          id: measurement.id,
          definition: measurement,
        }),
      ).resolves.toMatchObject({ action: "created", changed: true });

      await expect(
        runAssuranceAction(
          { action: "show", kind: "measurement", id: measurement.id },
          { path: pmPath },
        ),
      ).resolves.toEqual(measurement);

      await expect(
        runAction({
          action: "assurance",
          path: pmPath,
          options: { subcommand: "list", kind: "measurement" },
        }),
      ).resolves.toMatchObject({ count: 1, items: [measurement] });

      expect(
        analyzeSdkActionCoverage().find((row) => row.action === "assurance"),
      ).toEqual({
        action: "assurance",
        resolved_action: "assurance",
        covered: true,
        route: "native",
      });
    });
  });
});
