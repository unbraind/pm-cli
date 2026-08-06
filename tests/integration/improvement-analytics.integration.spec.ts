import { describe, expect, it } from "vitest";
import { handleRequest } from "../../src/mcp/server.js";
import {
  readImprovementLedger,
  recordImprovementObservation,
} from "../../src/sdk/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("improvement analytics CLI, SDK, and MCP parity", () => {
  it("records and reads the same audited ledger across every transport", async () => {
    await withTempPmPath(async (context) => {
      const cli = context.runCli(
        [
          "stats",
          "--analytics",
          JSON.stringify({
            observe: ["quality.coverage.lines=99,unit=percent,threshold=100"],
            direction: "higher",
            measurementSource: "coverage-gate",
            measurementItem: "pm-quality",
            measurementRevision: "cli-revision",
            measurements: true,
            provenanceCoverage: true,
            fleetAttribution: true,
            since: "-30d",
            eventLimit: 100,
            minimumSample: 1,
          }),
          "--json",
        ],
        { expectJson: true },
      );
      expect(cli.code).toBe(0);
      expect(cli.json).toMatchObject({
        improvement_ledger: {
          total: 1,
          observations: [{ metric: "quality.coverage.lines", value: 99 }],
        },
        recorded_observations: [{ changed: true }],
        provenance_coverage: { window: { source: "history_event_index" } },
        fleet_attribution: {
          policy: "observational_only_not_for_authorization_or_routing",
        },
      });

      await expect(
        recordImprovementObservation(
          {
            metric: "quality.coverage.lines",
            value: 100,
            direction: "higher",
            unit: "percent",
            threshold: 100,
            source: "coverage-gate",
            itemId: "pm-quality",
            revision: "sdk-revision",
          },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject({ changed: true });

      const response = await handleRequest({
        id: 1,
        method: "tools/call",
        params: {
          name: "pm_run",
          arguments: {
            path: context.pmPath,
            action: "stats",
            options: {
              measurements: true,
              metric: "quality.coverage.lines",
              measurementLimit: 10,
              observe: [
                "quality.coverage.lines=100,unit=percent,threshold=100",
              ],
              improvementDirection: "higher",
              measurementSource: "coverage-gate",
              measurementItem: "pm-quality",
              measurementRevision: "mcp-revision",
              author: "mcp-agent",
              message: "MCP acceptance observation",
              provenanceCoverage: true,
              fleetAttribution: true,
              since: "-30d",
              eventLimit: 100,
              minimumSample: 1,
            },
          },
        },
      });
      expect(response?.isError).not.toBe(true);
      expect(response).toMatchObject({
        structuredContent: {
          result: {
            improvement_ledger: {
              total: 3,
              trends: [{ improved: true, sample_count: 3 }],
            },
            recorded_observations: [{ changed: true }],
          },
        },
      });
      await expect(
        readImprovementLedger({
          pmRoot: context.pmPath,
          metric: "quality.coverage.lines",
        }),
      ).resolves.toMatchObject({ total: 3 });
    });
  });

  it("publishes exact command and tool contracts for the expanded stats surface", async () => {
    await withTempPmPath(async (context) => {
      const flags = context.runCli(
        ["contracts", "--command", "stats", "--flags-only", "--json"],
        { expectJson: true },
      );
      expect(flags.code).toBe(0);
      expect(JSON.stringify(flags.json)).toContain("--analytics");
      expect(JSON.stringify(flags.json)).not.toContain("--observe");

      const schema = context.runCli(
        ["contracts", "--action", "stats", "--schema-only", "--json"],
        { expectJson: true },
      );
      expect(schema.code).toBe(0);
      expect(JSON.stringify(schema.json)).toContain("improvementDirection");
      expect(JSON.stringify(schema.json)).toContain("provenanceCoverage");
    });
  });
});
