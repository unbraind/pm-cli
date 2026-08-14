import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PM_ERROR_CODE_CATALOG } from "../../src/sdk/generated-error-code-catalog.js";
import {
  verifyPmRecoveryReferences,
  verifyPmRefusalReachability,
  type PmRecoveryReferenceObligation,
  type PmRecoveryReferenceObservation,
  type PmRefusalProbeObservation,
} from "../../src/sdk/agent/refusal-reachability.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("real-entrypoint refusal reachability", () => {
  it("reaches every declared state as its typed code and exit class", async () => {
    await withTempPmPath(async (context) => {
      const invalidRoot = path.join(context.tempRoot, "tracker-root-file");
      await writeFile(invalidRoot, "not a directory", "utf8");
      const probes = new Map<
        string,
        {
          entrypoint: string;
          run: () => { code: number; stderr: string };
        }
      >([
        [
          "tracker-root-regular-file",
          {
            entrypoint: "list",
            run: () =>
              context.runCli(["--pm-path", invalidRoot, "list", "--json"]),
          },
        ],
        [
          "cross-command-unknown-option",
          {
            entrypoint: "deps",
            run: () =>
              context.runCli(["deps", "--add", "related:pm-x", "--json"]),
          },
        ],
        [
          "schema-unknown-subcommand",
          {
            entrypoint: "schema",
            run: () =>
              context.runCli(["schema", "add-typ", "Example", "--json"]),
          },
        ],
        [
          "graph-unknown-subcommand",
          {
            entrypoint: "graph",
            run: () => context.runCli(["graph", "analyz", "--json"]),
          },
        ],
        [
          "config-unknown-action",
          {
            entrypoint: "config",
            run: () =>
              context.runCli(["config", "project", "delete", "--json"]),
          },
        ],
        [
          "package-unknown-action",
          {
            entrypoint: "package",
            run: () => context.runCli(["package", "insta", "--json"]),
          },
        ],
      ]);
      const observations: PmRefusalProbeObservation[] = [];
      for (const contract of PM_ERROR_CODE_CATALOG) {
        for (const state of contract.owned_states ?? []) {
          const probe = probes.get(state.probe_id);
          expect(probe, `missing probe driver ${state.probe_id}`).toBeDefined();
          const result = probe!.run();
          const envelope = JSON.parse(result.stderr) as {
            code: string;
            exit_code: number;
          };
          expect(result.code).toBe(envelope.exit_code);
          observations.push({
            probe_id: state.probe_id,
            entrypoint: probe!.entrypoint,
            code: envelope.code,
            exit_class:
              result.code === 2
                ? "usage"
                : result.code === 3
                  ? "not_found"
                  : "generic_failure",
          });
        }
      }
      expect(
        verifyPmRefusalReachability(PM_ERROR_CODE_CATALOG, observations),
      ).toMatchObject({ ok: true, declared_probe_count: 6 });
    });
  });

  it("executes and measures every recovery-reference kind emitted by real refusals", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli([
        "schema",
        "add",
        "type",
        "Example",
        "--json",
      ]);
      expect(result.code).toBe(2);
      const envelope = JSON.parse(result.stderr) as {
        code: string;
        examples?: string[];
        next_steps?: string[];
        recovery?: {
          allowed_values?: string[];
          suggested_retry?: string;
        };
      };
      expect(envelope.code).toBe("unknown_subcommand");
      expect(envelope.recovery?.allowed_values).toContain("add-type");
      expect(envelope.recovery?.allowed_values).toHaveLength(15);
      expect(envelope.recovery?.suggested_retry).toBe(
        "pm schema add-type Example --json",
      );
      const suggestedRetry = envelope.recovery!.suggested_retry!;
      expect(context.runCli(suggestedRetry.split(" ").slice(1)).code).toBe(0);

      const optionResult = context.runCli([
        "deps",
        "--add",
        "related:pm-x",
        "--json",
      ]);
      expect(optionResult.code).toBe(2);
      const optionEnvelope = JSON.parse(optionResult.stderr) as {
        recovery?: { candidate_commands?: string[] };
      };
      const contracts = context.runCli(
        [
          "--no-extensions",
          "contracts",
          "--flags-only",
          "--json",
          "--output-budget",
          "unbounded",
        ],
        { expectJson: true },
      ).json as { commands: string[] };
      const declaredCommandPaths = new Set(contracts.commands);
      const obligations: PmRecoveryReferenceObligation[] = [
        {
          id: "schema:suggested-retry:0",
          probe_id: "schema-split-action",
          kind: "suggested_retry",
          value: suggestedRetry,
        },
        ...(optionEnvelope.recovery?.candidate_commands ?? []).map(
          (value, index) => ({
            id: `deps:candidate-command:${index}`,
            probe_id: "cross-command-unknown-option",
            kind: "candidate_command" as const,
            value,
          }),
        ),
        ...(envelope.examples ?? []).map((value, index) => ({
          id: `schema:example:${index}`,
          probe_id: "schema-split-action",
          kind: "example" as const,
          value,
        })),
        ...(envelope.next_steps ?? []).map((value, index) => ({
          id: `schema:next-step:${index}`,
          probe_id: "schema-split-action",
          kind: "next_step" as const,
          value,
        })),
      ];
      const observations: PmRecoveryReferenceObservation[] = obligations.map(
        (obligation) => {
          if (obligation.kind === "suggested_retry") {
            return {
              id: obligation.id,
              reachable: true,
              proof: "executed",
            };
          }
          if (obligation.kind === "candidate_command") {
            return {
              id: obligation.id,
              reachable: declaredCommandPaths.has(obligation.value),
              proof: "declared_command_path",
            };
          }
          if (obligation.kind === "example") {
            const commandPath = obligation.value
              .replace(/^pm\s+/u, "")
              .split(/\s+(?:--|<)/u)[0]!;
            return {
              id: obligation.id,
              reachable:
                obligation.value === suggestedRetry ||
                declaredCommandPaths.has(commandPath),
              proof:
                obligation.value === suggestedRetry
                  ? "linked_execution"
                  : "declared_command_path",
            };
          }
          return {
            id: obligation.id,
            reachable: obligation.value.includes(suggestedRetry),
            proof: "linked_execution",
          };
        },
      );
      const report = verifyPmRecoveryReferences(obligations, observations);
      expect(report).toMatchObject({
        ok: true,
        pass_fraction: 1,
        coverage_by_kind: [
          { kind: "suggested_retry", declared: 1, passed: 1 },
          { kind: "candidate_command", declared: 6, passed: 6 },
          { kind: "example", declared: 2, passed: 2 },
          { kind: "next_step", declared: 1, passed: 1 },
        ],
      });

      const broken = observations.map((observation, index) =>
        index === 0 ? { ...observation, reachable: false } : observation,
      );
      expect(verifyPmRecoveryReferences(obligations, broken)).toMatchObject({
        ok: false,
        pass_fraction: 0.9,
        findings: [expect.objectContaining({ kind: "unreachable_reference" })],
      });
    });
  });
});
