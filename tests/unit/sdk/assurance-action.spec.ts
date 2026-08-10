import { describe, expect, it, vi } from "vitest";

import {
  runAssuranceAction,
  runAssuranceDispatch,
} from "../../../src/sdk/governance/assurance-action.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const measurement = {
  id: "all-items",
  source: { kind: "items", statuses: ["open"] },
};
const assertion = {
  id: "all-items-floor",
  measurement_id: measurement.id,
  owner_item_id: "pm-owner",
  scope: { kind: "all" },
  floor: 0,
  enforcement: "block",
  negative_control: {
    cases: [
      { observed: 0, expected: "pass" },
      { observed: -1, expected: "fail" },
    ],
  },
};
const gate = {
  id: "delivery",
  assertion_ids: [assertion.id],
  triggers: ["ci"],
};

describe("assurance action transport", () => {
  it("normalizes CRUD, evaluation, and errors for every host", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const global = { path: pmPath };
      await runCreate(
        { title: "Authorize assurance updates", type: "Decision" },
        { path: pmPath, json: true, quiet: true },
      );
      await expect(
        runAssuranceAction({ action: "unknown" }, global),
      ).rejects.toThrow("Unknown assurance action");
      await expect(
        runAssuranceAction({ action: "list" }, global),
      ).rejects.toThrow("kind is required");
      await expect(
        runAssuranceAction(
          { action: "put", kind: "unknown", id: "x", definition: {} },
          global,
        ),
      ).rejects.toThrow("kind is required");
      await expect(
        runAssuranceAction(
          { action: "put", kind: "measurement", id: "x", definition: "{" },
          global,
        ),
      ).rejects.toThrow("valid JSON");
      const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "invalid";
      });
      await expect(
        runAssuranceAction(
          { action: "put", kind: "measurement", id: "x", definition: "{}" },
          global,
        ),
      ).rejects.toThrow("valid JSON");
      parse.mockRestore();
      for (const definition of [undefined, [], "  "]) {
        await expect(
          runAssuranceAction(
            { action: "put", kind: "measurement", id: "x", definition },
            global,
          ),
        ).rejects.toThrow("JSON object");
      }
      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "measurement",
            id: "different",
            definition: measurement,
          },
          global,
        ),
      ).rejects.toThrow("does not match requested id");

      await expect(
        runAssuranceAction(
          {
            action: "put",
            kind: "measurement",
            id: measurement.id,
            definition: JSON.stringify(measurement),
            author: "transport-test",
            message: "Create measurement",
          },
          global,
        ),
      ).resolves.toMatchObject({ action: "created" });
      await expect(
        runAssuranceDispatch(
          { subcommand: "put", idOnly: true },
          {
            kind: "measurement",
            id: measurement.id,
            definition: measurement,
            fullChangedFields: true,
          },
          global,
        ),
      ).resolves.toEqual({ id: measurement.id });
      await runAssuranceAction(
        {
          action: "put",
          kind: "assertion",
          id: assertion.id,
          definition: assertion,
        },
        global,
      );
      await runAssuranceAction(
        { action: "put", kind: "gate", id: gate.id, definition: gate },
        global,
      );

      await expect(
        runAssuranceAction({ action: "list", kind: "measurement" }, global),
      ).resolves.toMatchObject({ count: 1, items: [measurement] });
      await expect(
        runAssuranceDispatch(
          { assuranceAction: "list", kind: "measurement" },
          {},
          global,
        ),
      ).resolves.toMatchObject({ count: 1 });
      await expect(
        runAssuranceDispatch(
          {},
          { operation: "list", kind: "measurement" },
          global,
        ),
      ).resolves.toMatchObject({ count: 1 });
      await expect(runAssuranceDispatch({}, {}, global)).rejects.toThrow(
        "Unknown assurance action",
      );
      await expect(
        runAssuranceAction(
          { action: "show", kind: "assertion", id: assertion.id },
          global,
        ),
      ).resolves.toEqual(assertion);
      await expect(
        runAssuranceAction({ action: "show", kind: "gate" }, global),
      ).rejects.toThrow("requires an id");
      await expect(
        runAssuranceAction({ action: "run" }, global),
      ).rejects.toThrow("gate id");
      await expect(
        runAssuranceAction({ action: "run", id: gate.id }, global),
      ).rejects.toThrow("requires a trigger");

      await expect(
        runAssuranceAction(
          { action: "run", id: gate.id, trigger: "ci", dry_run: true },
          global,
        ),
      ).resolves.toMatchObject({ dry_run: true, verdict: "pass" });
      await runAssuranceAction(
        { action: "run", id: gate.id, trigger: "ci", tree: "known-tree" },
        global,
      );
      await expect(
        runAssuranceAction({ action: "verdicts", gate: gate.id }, global),
      ).resolves.toMatchObject({ count: 1, items: [{ tree_id: "known-tree" }] });

      await runAssuranceAction(
        { action: "remove", kind: "gate", id: gate.id },
        global,
      );
      await runAssuranceAction(
        { action: "remove", kind: "assertion", id: assertion.id },
        global,
      );
      await expect(
        runAssuranceAction(
          {
            action: "remove",
            kind: "measurement",
            id: measurement.id,
            idOnly: true,
          },
          global,
        ),
      ).resolves.toEqual({ id: measurement.id });
    });
  });
});
