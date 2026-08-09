import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth } from "../../src/sdk/governance/health.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("provenance value health projection", () => {
  it("projects privacy-safe corpus conformance findings through health", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const history = path.join(pmPath, "history");
      await mkdir(history, { recursive: true });
      await writeFile(
        path.join(history, "legacy-provenance.jsonl"),
        `${JSON.stringify({
          agent_harness: "legacy-host",
          agent_provenance: {
            role: { source: "legacy", value: "true" },
          },
        })}\n`,
      );
      const result = await runHealth(
        { path: pmPath },
        { checkOnly: true, full: true },
      );
      expect(result.warnings).toContain(
        "provenance_value_domain_invalid:legacy-host:role:boolean:1",
      );
      expect(
        result.checks.find((check) => check.name === "storage")?.details,
      ).toMatchObject({
        provenance_invalid_values: [
          {
            harness: "legacy-host",
            dimension: "role",
            kind: "boolean",
            count: 1,
          },
        ],
      });
    });
  });
});
