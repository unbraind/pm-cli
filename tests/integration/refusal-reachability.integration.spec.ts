import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PM_ERROR_CODE_CATALOG } from "../../src/sdk/generated-error-code-catalog.js";
import {
  verifyPmRefusalReachability,
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

  it("classifies the split schema action trap with a copy-pasteable retry", async () => {
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
    });
  });
});
