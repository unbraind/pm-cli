import { describe, expect, it } from "vitest";
import { listCoreClosedDomainContracts } from "../../src/sdk/agent/closed-domain-contracts.js";
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
          expect.objectContaining({ name: "init", tier: "core" }),
        ]),
      );
      expect(rootPayload.subcommands.some(({ name }) => name === "graph")).toBe(
        false,
      );
      const contextHelp = context.runCli(["context", "--help", "--json"], {
        expectJson: true,
      });
      expect(contextHelp.json).toMatchObject({
        visibility_tier: "core",
        capability_family: "context",
      });
      expect(
        context.runCli(["graph", "--help", "--json"], { expectJson: true })
          .json,
      ).toMatchObject({
        visibility_tier: "standard",
        capability_family: "graph",
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

      const contracts = listCoreClosedDomainContracts();
      expect(contracts).toHaveLength(19);
      for (const contract of contracts) {
        const result = context.runCli([...contract.refusal_args, "--json"]);
        expect(result.code, contract.probe_id).toBe(2);
        const problemStart = result.stderr.indexOf("{");
        const envelope = JSON.parse(
          problemStart >= 0 ? result.stderr.slice(problemStart) : result.stderr,
        ) as {
          code: string;
          recovery: {
            allowed_values: string[];
            suggested_retry: string;
            suggested_retry_args: string[];
          };
          refusal: {
            surface: string;
            rejected_value?: string;
            legal_domain?: string[];
            exit_code: number;
          };
        };
        expect(envelope.code).toBe(contract.error_code);
        expect(envelope.refusal.exit_code).toBe(2);
        expect(
          contract.rejected_value
            .split("+")
            .includes(envelope.refusal.rejected_value ?? ""),
          contract.probe_id,
        ).toBe(true);
        if (contract.allowed_values_required !== false) {
          expect(envelope.refusal.legal_domain).toEqual(
            contract.allowed_values,
          );
        }
        expect(envelope.recovery.allowed_values ?? []).toEqual(
          contract.allowed_values.slice(
            0,
            envelope.recovery.allowed_values?.length ?? 0,
          ),
        );
        expect(envelope.recovery.suggested_retry_args).toEqual(
          contract.suggested_retry_args,
        );
        const retry = context.runCli([
          ...envelope.recovery.suggested_retry_args,
          "--json",
        ]);
        expect(retry.code, contract.probe_id).toBe(0);
      }
    });
  });
});
