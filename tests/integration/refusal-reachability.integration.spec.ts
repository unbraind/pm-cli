import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import fg from "fast-glob";
import { describe, expect, it } from "vitest";
import { PM_ERROR_CODE_CATALOG } from "../../src/sdk/generated-error-code-catalog.js";
import { PM_READ_OUTPUT_SURFACE_CONTRACTS } from "../../src/sdk/read-output-contracts.js";
import {
  PmCompleteListValidationError,
  certifyCompleteListResult,
} from "../../src/sdk/query/complete-list.js";
import {
  censusPmRecoveryReferenceProducers,
  derivePmRecoveryReferenceObligations,
  verifyPmRecoveryReferences,
  verifyPmRefusalReachability,
  type PmRecoveryReferenceObligation,
  type PmRecoveryReferenceObservation,
  type PmRefusalProbeObservation,
} from "../../src/sdk/agent/refusal-reachability.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

/** Remove invocation-only amount receipts before comparing replacement results. */
function withoutReadInvocationReceipts(
  stdout: string,
): Record<string, unknown> {
  const normalized = structuredClone(JSON.parse(stdout)) as Record<
    string,
    unknown
  >;
  delete normalized.applied_limit;
  delete normalized.now;
  delete normalized.read_output;
  if (
    normalized.filters !== null &&
    typeof normalized.filters === "object" &&
    !Array.isArray(normalized.filters)
  ) {
    delete (normalized.filters as Record<string, unknown>).limit;
  }
  return normalized;
}

describe("real-entrypoint refusal reachability", () => {
  it("censuses the complete source producer table without unknown recovery fields", async () => {
    const sourcePaths = await fg("src/**/*.ts", { cwd: process.cwd() });
    const sources = await Promise.all(
      sourcePaths.map(async (sourcePath) => ({
        path: sourcePath,
        content: await readFile(path.join(process.cwd(), sourcePath), "utf8"),
      })),
    );
    const report = censusPmRecoveryReferenceProducers(sources);

    expect(report.ok, JSON.stringify(report.findings, null, 2)).toBe(true);
    expect(report.scanned_file_count).toBeGreaterThan(400);
    expect(
      Object.entries(report.producer_count_by_kind).filter(
        ([, count]) => count === 0,
      ),
    ).toEqual([]);
  });

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
      const budgetResult = context.runCli([
        "--no-extensions",
        "contracts",
        "--json",
        "--full",
        "--output-budget",
        "256",
      ]);
      expect(budgetResult.code).toBe(2);
      const budgetEnvelope = JSON.parse(budgetResult.stdout) as unknown;
      const unboundedRecovery = context.runCli([
        "--no-extensions",
        "contracts",
        "--json",
        "--full",
        "--output-budget",
        "unbounded",
      ]);
      expect(unboundedRecovery.code).toBe(0);
      const fixture = context.runCli([
        "create",
        "--create-mode",
        "progressive",
        "--title",
        "Replacement equivalence fixture",
        "--type",
        "Task",
        "--status",
        "open",
        "--json",
      ]);
      expect(fixture.code).toBe(0);
      const legacyRead = context.runCli(["list", "--json", "--no-truncate"]);
      const replacementRead = context.runCli([
        "list",
        "--json",
        "--output-limit",
        "unbounded",
      ]);
      expect(replacementRead.code).toBe(legacyRead.code);
      const legacyLimitRead = context.runCli([
        "list",
        "--json",
        "--limit",
        "1",
      ]);
      const replacementLimitRead = context.runCli([
        "list",
        "--json",
        "--output-limit",
        "1",
      ]);
      expect(replacementLimitRead.code).toBe(legacyLimitRead.code);
      const replacementLimitPayloadMatches = isDeepStrictEqual(
        withoutReadInvocationReceipts(replacementLimitRead.stdout),
        withoutReadInvocationReceipts(legacyLimitRead.stdout),
      );
      expect(replacementLimitPayloadMatches).toBe(true);
      const listAmountAliases = PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
        ({ command }) => command === "list",
      )!.dimensions.amount.legacy_aliases.filter(({ flag }) =>
        ["--limit", "--no-truncate"].includes(flag),
      );
      let completeListFailure: PmCompleteListValidationError | undefined;
      try {
        certifyCompleteListResult({ items: [] });
      } catch (error: unknown) {
        if (error instanceof PmCompleteListValidationError) {
          completeListFailure = error;
        }
      }
      if (!(completeListFailure instanceof PmCompleteListValidationError)) {
        throw new TypeError("Expected complete-list certification to fail.");
      }
      const completeListRetry =
        completeListFailure.receipt.recovery.suggested_retry;
      expect(context.runCli(completeListRetry.split(" ").slice(1)).code).toBe(0);
      const obligations: PmRecoveryReferenceObligation[] = [
        ...derivePmRecoveryReferenceObligations(
          "schema-split-action",
          envelope,
        ),
        ...derivePmRecoveryReferenceObligations(
          "cross-command-unknown-option",
          optionEnvelope,
        ),
        ...derivePmRecoveryReferenceObligations(
          "whole-result-omission",
          budgetEnvelope,
        ),
        ...derivePmRecoveryReferenceObligations(
          "legacy-read-control",
          listAmountAliases,
        ),
        ...derivePmRecoveryReferenceObligations(
          "complete-list-certification",
          completeListFailure.receipt,
        ),
      ];
      const observations: PmRecoveryReferenceObservation[] = obligations.map(
        (obligation) => {
          if (obligation.kind === "suggested_retry") {
            return {
              id: obligation.id,
              reachable:
                obligation.value === suggestedRetry ||
                obligation.value === completeListRetry,
              proof: "executed",
              semantics: obligation.semantics,
            };
          }
          if (obligation.kind === "candidate_command") {
            return {
              id: obligation.id,
              reachable: declaredCommandPaths.has(obligation.value),
              proof: "declared_command_path",
              semantics: obligation.semantics,
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
              semantics: obligation.semantics,
            };
          }
          if (obligation.kind === "restore_with") {
            return {
              id: obligation.id,
              reachable:
                obligation.value === "Unbounded" &&
                unboundedRecovery.code === 0,
              proof: "executed",
              semantics: obligation.semantics,
            };
          }
          if (obligation.kind === "migration_hint") {
            return {
              id: obligation.id,
              reachable:
                obligation.semantics === "behavior_preserving"
                  ? replacementRead.code === legacyRead.code
                  : replacementLimitRead.code === legacyLimitRead.code &&
                    replacementLimitPayloadMatches,
              proof: "executed",
              semantics: obligation.semantics,
            };
          }
          return {
            id: obligation.id,
            reachable:
              obligation.value.includes(suggestedRetry) ||
              (obligation.probe_id === "cross-command-unknown-option" &&
                (obligation.value.includes("command help") ||
                  obligation.value.includes("accepted by"))),
            proof: "linked_execution",
            semantics: obligation.semantics,
          };
        },
      );
      const declaredByKind = (kind: PmRecoveryReferenceObligation["kind"]) =>
        obligations.filter((obligation) => obligation.kind === kind).length;
      const report = verifyPmRecoveryReferences(obligations, observations);
      expect(report).toMatchObject({
        ok: true,
        pass_fraction: 1,
        coverage_by_kind: (
          [
            "suggested_retry",
            "candidate_command",
            "example",
            "next_step",
            "migration_hint",
            "restore_with",
          ] as const
        ).map((kind) => ({
          kind,
          declared: declaredByKind(kind),
          passed: declaredByKind(kind),
        })),
      });
      expect(declaredByKind("candidate_command")).toBeGreaterThan(0);
      expect(declaredByKind("example")).toBeGreaterThan(0);
      expect(declaredByKind("migration_hint")).toBeGreaterThan(0);
      expect(declaredByKind("restore_with")).toBeGreaterThan(0);

      const broken = observations.map((observation, index) =>
        index === 0 ? { ...observation, reachable: false } : observation,
      );
      expect(verifyPmRecoveryReferences(obligations, broken)).toMatchObject({
        ok: false,
        pass_fraction: (obligations.length - 1) / obligations.length,
        findings: [expect.objectContaining({ kind: "unreachable_reference" })],
      });
    });
  });
});
