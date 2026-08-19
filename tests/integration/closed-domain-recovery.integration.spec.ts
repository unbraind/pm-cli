import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("closed-domain recovery envelopes", () => {
  it("projects the shared tier and family contract through JSON help", async () => {
    await withTempPmPath(async (context) => {
      const root = context.runCli(["--help", "--json"], { expectJson: true });
      const rootPayload = root.json as {
        subcommands: Array<{
          name: string;
          tier: string;
          family: string;
        }>;
      };
      expect(rootPayload.subcommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "context",
            tier: "core",
            family: "context",
          }),
          expect.objectContaining({
            name: "graph",
            tier: "standard",
            family: "graph",
          }),
        ]),
      );
      const contextHelp = context.runCli(["context", "--help", "--json"], {
        expectJson: true,
      });
      expect(contextHelp.json).toMatchObject({
        visibility_tier: "core",
        capability_family: "context",
      });
    });
  });

  it("discloses complete intent and projection domains across read commands", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        ["create", "--id", "pm-domain", "--title", "Domain", "--json"],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      const probes = [
        {
          args: ["list", "--for", "invalid"],
          allowed: ["triage"],
          retry: "pm list --for triage",
          retryArgs: ["list", "--for", "triage"],
        },
        {
          args: ["list", "--fields", "invalid"],
          allowed: ["id", "item.id", "title"],
          retry: "pm list --fields id,title,status --limit 10",
          retryArgs: [
            "list",
            "--fields",
            "id,title,status",
            "--limit",
            "10",
          ],
        },
        {
          args: ["get", "pm-domain", "--for", "invalid"],
          allowed: ["inspect"],
          retry: "pm get pm-domain --for inspect",
          retryArgs: ["get", "pm-domain", "--for", "inspect"],
        },
        {
          args: ["search", "Domain query", "--for", "invalid"],
          allowed: ["discover"],
          retry: 'pm search "Domain query" --for discover',
          retryArgs: ["search", "Domain query", "--for", "discover"],
        },
        {
          args: ["get", "pm-domain", "--fields", "invalid"],
          allowed: ["id", "item.id", "linked.files"],
          retry: 'pm get pm-domain --fields "id,title,status"',
          retryArgs: ["get", "pm-domain", "--fields", "id,title,status"],
        },
        {
          args: ["search", "Domain query", "--fields", "invalid"],
          allowed: ["id", "item.id", "score"],
          retry:
            'pm search "Domain query" --fields "id,title,status,score"',
          retryArgs: [
            "search",
            "Domain query",
            "--fields",
            "id,title,status,score",
          ],
        },
      ];
      for (const probe of probes) {
        const result = context.runCli([...probe.args, "--json"]);
        expect(result.code, probe.args.join(" ")).toBe(2);
        const envelope = JSON.parse(result.stderr) as {
          recovery: {
            allowed_values: string[];
            suggested_retry: string;
            suggested_retry_args: string[];
          };
        };
        expect(envelope.recovery.allowed_values).toEqual(
          expect.arrayContaining(probe.allowed),
        );
        expect(envelope.recovery.suggested_retry).toBe(probe.retry);
        expect(envelope.recovery.suggested_retry_args).toEqual(
          probe.retryArgs,
        );
        const retry = context.runCli([
          ...envelope.recovery.suggested_retry_args,
          "--json",
        ]);
        expect(retry.code, envelope.recovery.suggested_retry).toBe(0);
      }
    });
  });
});
